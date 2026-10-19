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
  let kind = (contentType || blob.type || "application/octet-stream").split(";")[0].trim();
  if (!kind || kind === "application/octet-stream" || kind === "video/webm") {
    // MediaRecorder often yields empty/generic type for webm voice notes
    kind = kind === "video/webm" ? "audio/webm" : (kind || "audio/webm");
  }
  const isImage = kind.startsWith("image/");
  const isAudio =
    kind.startsWith("audio/") ||
    kind === "application/ogg" ||
    kind === "audio/webm" ||
    kind === "video/webm";
  const type: "image" | "audio" | "file" = isImage ? "image" : isAudio ? "audio" : "file";
  const ext = isImage
    ? kind.includes("png")
      ? "png"
      : kind.includes("webp")
        ? "webp"
        : kind.includes("gif")
          ? "gif"
          : "jpg"
    : isAudio
      ? kind.includes("mpeg") || kind.includes("mp3")
        ? "mp3"
        : kind.includes("ogg")
          ? "ogg"
          : kind.includes("mp4")
            ? "m4a"
            : "webm"
      : kind.includes("pdf")
        ? "pdf"
        : kind.includes("mp4")
          ? "mp4"
          : "bin";
  const path = `${pathPrefix.replace(/\/+$/, "")}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  let lastErr = "";
  for (const bucket of BUCKETS) {
    try {
      const { error } = await supabase.storage.from(bucket).upload(path, blob, {
        contentType: kind || "application/octet-stream",
        upsert: true,
        cacheControl: "3600",
      });
      if (error) {
        lastErr = error.message || String(error);
        continue;
      }
      const { data } = supabase.storage.from(bucket).getPublicUrl(path);
      if (data?.publicUrl) return { url: data.publicUrl, type };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  // Inline fallback — voice notes / small images (max ~2.5MB so typical webm notes work)
  if ((isAudio || isImage) && blob.size <= 2_500_000) {
    const dataUrl = await blobToDataUrl(blob);
    return { url: dataUrl, type, inline: true };
  }
  if (blob.size <= 1_200_000) {
    const dataUrl = await blobToDataUrl(blob);
    return { url: dataUrl, type, inline: true };
  }
  throw new Error(
    lastErr ||
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
