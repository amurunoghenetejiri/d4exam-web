import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSessionUser } from "@/lib/session";

type SchoolSubscription = {
  channel: ReturnType<typeof supabase.channel>;
  listeners: Set<() => void>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

const schoolSubscriptions = new Map<string, SchoolSubscription>();
let schoolChannelSequence = 0;

function subscribeToSchool(schoolId: string, onChange: () => void) {
  let entry = schoolSubscriptions.get(schoolId);
  if (!entry) {
    const channel = supabase
      .channel(`school-identity-${schoolId}-${++schoolChannelSequence}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "schools", filter: `id=eq.${schoolId}` },
        () => {
          const current = schoolSubscriptions.get(schoolId);
          if (!current) return;
          current.listeners.forEach((fn) => {
            try {
              fn();
            } catch {
              /* ignore */
            }
          });
        },
      )
      .subscribe();
    entry = { channel, listeners: new Set(), cleanupTimer: null };
    schoolSubscriptions.set(schoolId, entry);
  }
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
  entry.listeners.add(onChange);
  return () => {
    const current = schoolSubscriptions.get(schoolId);
    if (!current) return;
    current.listeners.delete(onChange);
    if (current.listeners.size === 0) {
      current.cleanupTimer = setTimeout(() => {
        const latest = schoolSubscriptions.get(schoolId);
        if (!latest || latest.listeners.size > 0) return;
        void supabase.removeChannel(latest.channel);
        schoolSubscriptions.delete(schoolId);
      }, 5_000);
    }
  };
}

export type SchoolIdentity = {
  id: string;
  name: string;
  schoolCode: string;
  logoUrl: string | null;
  status: string;
};

export function useSchoolIdentity(schoolId?: string | null) {
  const { data: session } = useSessionUser();
  const qc = useQueryClient();
  const id = schoolId ?? session?.schoolId ?? null;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id) return;
    const unsubscribe = subscribeToSchool(id, () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void qc.invalidateQueries({ queryKey: ["school-identity", id] });
      }, 1500);
    });

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      unsubscribe();
    };
  }, [id, qc]);

  return useQuery({
    queryKey: ["school-identity", id],
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<SchoolIdentity | null> => {
      if (!id) return null;
      const { data, error } = await supabase
        .from("schools")
        .select("id, name, school_code, logo_url, status")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        console.warn("[school-identity]", error);
        return null;
      }
      if (!data) return null;
      return {
        id: data.id as string,
        name: (data.name as string) || "School",
        schoolCode: (data.school_code as string) || "",
        logoUrl: (data.logo_url as string | null) ?? null,
        status: (data.status as string) || "active",
      };
    },
  });
}

/** Soft checks only — never blocks submit on decode/format issues. */
export function validateLogoFile(file: File): string | null {
  if (!file || file.size <= 0) return "Please choose a logo file.";
  if (file.size > 5 * 1024 * 1024) return "Logo must be under 5MB.";
  return null;
}

function guessExt(file: File): string {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".png") || file.type === "image/png") return "png";
  if (name.endsWith(".webp") || file.type === "image/webp") return "webp";
  if (name.endsWith(".gif") || file.type === "image/gif") return "gif";
  return "jpg";
}

/**
 * Upload logo without decoding/compressing the image.
 * 1) Try Supabase storage (raw File) → public URL
 * 2) Else FileReader data URL (no image decode)
 * Never throws cannot-read/decode — returns best-effort URL or empty string.
 */
/** Resize/compress logo client-side so storage + DB stay under limits.
 * PNG/WebP with transparency stay PNG so alpha is not flattened to black JPEG. */
async function compressLogoFile(file: File, maxPx = 512, quality = 0.82): Promise<File> {
  try {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return file;
    const keepAlpha =
      file.type === "image/png" ||
      file.type === "image/webp" ||
      /\.png$/i.test(file.name) ||
      /\.webp$/i.test(file.name);
    // Small enough already — skip re-encode (preserves original transparency)
    if (keepAlpha && file.size <= 400_000) return file;

    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return file;
    // Clear to transparent — never fill black (JPEG alpha would become solid black)
    ctx.clearRect(0, 0, w, h);
    if (!keepAlpha) {
      // Opaque formats: white backing so transparent edges do not become black
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    const mime = keepAlpha ? "image/png" : "image/jpeg";
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), mime, keepAlpha ? undefined : quality),
    );
    if (!blob) return file;
    const base = (file.name || "logo").replace(/\.[^.]+$/, "") || "logo";
    const ext = keepAlpha ? "png" : "jpg";
    return new File([blob], `${base}.${ext}`, { type: mime });
  } catch {
    return file;
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = String(reader.result || "");
      if (r.startsWith("data:")) resolve(r);
      else reject(new Error("empty"));
    };
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export async function uploadSchoolLogo(opts: {
  file: File;
  folder: string;
}): Promise<{ url: string; path: string }> {
  if (!opts.file || opts.file.size <= 0) {
    return { url: "", path: "" };
  }

  // Prefer a compressed image for uploads
  const file = await compressLogoFile(opts.file);
  const ext = guessExt(file) || "jpg";
  const path = `${opts.folder}/logo-${Date.now()}.${ext}`;
  const contentType = file.type || `image/${ext === "jpg" ? "jpeg" : ext}`;

  const buckets = ["school-logos", "public", "avatars"];
  for (const bucket of buckets) {
    try {
      const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
        cacheControl: "3600",
        upsert: true,
        contentType,
      });
      if (upErr) {
        console.warn("[logo-upload]", bucket, upErr.message);
        continue;
      }
      // Prefer long-lived signed URL (works even if bucket is not fully public)
      try {
        const { data: signed, error: sErr } = await supabase.storage
          .from(bucket)
          .createSignedUrl(path, 60 * 60 * 24 * 365); // 1 year
        if (!sErr && signed?.signedUrl) {
          return { url: signed.signedUrl, path: `${bucket}/${path}` };
        }
      } catch {
        /* fall through to public URL */
      }
      const { data } = supabase.storage.from(bucket).getPublicUrl(path);
      if (data?.publicUrl) {
        return { url: data.publicUrl, path: `${bucket}/${path}` };
      }
    } catch (e) {
      console.warn("[logo-upload] bucket fail", bucket, e);
    }
  }

  // Anonymous applicants often cannot write to storage — keep logo as data URL
  try {
    const dataUrl = await fileToDataUrl(file);
    // Cap ~1.2MB data URL so insert payload stays reasonable
    if (dataUrl.length <= 1_200_000) {
      return { url: dataUrl, path: "data-url" };
    }
    // Try stronger compression once more
    const smaller = await compressLogoFile(opts.file, 256, 0.7);
    const dataUrl2 = await fileToDataUrl(smaller);
    if (dataUrl2.length <= 1_200_000) {
      return { url: dataUrl2, path: "data-url" };
    }
  } catch {
    /* fall through */
  }

  return { url: "", path: "" };
}

export async function updateSchoolLogoUrl(schoolId: string, logoUrl: string) {
  const url = String(logoUrl || "").trim();
  if (!url) throw new Error("No logo URL to save");
  const { error } = await supabase
    .from("schools")
    .update({ logo_url: url, updated_at: new Date().toISOString() } as never)
    .eq("id", schoolId);
  if (error) throw new Error(error.message || "Could not save logo to school record");
}

export async function updateSchoolName(schoolId: string, name: string) {
  const trimmed = name.trim();
  if (trimmed.length < 2) throw new Error("School name must be at least 2 characters.");
  if (trimmed.length > 200) throw new Error("School name is too long.");
  const { error } = await supabase
    .from("schools")
    .update({ name: trimmed, updated_at: new Date().toISOString() } as never)
    .eq("id", schoolId);
  if (error) throw new Error(error.message || "Could not update school name");
}
