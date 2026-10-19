import { supabase } from "@/integrations/supabase/client";

const BUCKETS = ["message-media", "avatars", "public", "course-materials"] as const;

/**
 * Upload a message attachment. Tries several known buckets, then falls back to
 * an inline data URL for small images/audio so chat still works without a dedicated bucket.
 */
export async function uploadMessageMedia(
  blob: Blob,
  contentType: string,
  pathPrefix: string,
): Promise<{ url: string; type: "image" | "audio" | "file"; inline?: boolean }> {
  const kind = contentType || blob.type || "application/octet-stream";
  const isImage = kind.startsWith("image/");
  const isAudio = kind.startsWith("audio/");
  const type: "image" | "audio" | "file" = isImage ? "image" : isAudio ? "audio" : "file";
  const ext = isImage
    ? kind.includes("png")
      ? "png"
      : kind.includes("webp")
        ? "webp"
        : "jpg"
    : isAudio
      ? "webm"
      : "bin";
  const path = `${pathPrefix.replace(/\/+$/, "")}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  for (const bucket of BUCKETS) {
    try {
      const { error } = await supabase.storage.from(bucket).upload(path, blob, {
        contentType: kind,
        upsert: true,
      });
      if (error) continue;
      const { data } = supabase.storage.from(bucket).getPublicUrl(path);
      if (data?.publicUrl) return { url: data.publicUrl, type };
    } catch {
      /* try next */
    }
  }

  // Inline fallback — keep small to avoid huge DB rows (max ~600KB)
  if (blob.size <= 600_000) {
    const dataUrl = await blobToDataUrl(blob);
    return { url: dataUrl, type, inline: true };
  }
  throw new Error(
    "Could not upload file. Use a smaller photo/video under 8 MB, check your connection, or ensure the message-media Storage bucket exists and is public.",
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(blob);
  });
}
