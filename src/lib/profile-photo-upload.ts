import { supabase } from "@/integrations/supabase/client";

/**
 * Upload a profile image to the public `avatars` bucket and set profiles.profile_photo_url.
 * Uses SECURITY DEFINER RPC when available so RLS cannot block the update.
 */
export async function uploadProfilePhoto(opts: {
  file: File;
  userId: string;
  profileId?: string | null;
}): Promise<string> {
  const { file, userId, profileId } = opts;
  if (!userId) throw new Error("Not signed in");
  if (file.size > 3 * 1024 * 1024) throw new Error("Image must be 3 MB or smaller.");

  const pid = profileId || userId;
  const ext =
    (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `profiles/${pid}/avatar-${Date.now()}.${ext}`;

  let upErr: { message?: string } | null = null;
  try {
    const res = await supabase.storage
      .from("avatars")
      .upload(path, file, { upsert: true, contentType: file.type || "image/jpeg" });
    upErr = res.error;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/failed to fetch|network|load failed/i.test(m)) {
      throw new Error(
        "Could not upload photo (network). Check your connection and try a smaller image under 2 MB.",
      );
    }
    throw e;
  }
  if (upErr) {
    const m = upErr.message || "Upload failed";
    if (/bucket|not found|row-level security|policy/i.test(m)) {
      throw new Error("Photo storage is not ready. Ask school admin to enable the avatars bucket.");
    }
    throw new Error(m);
  }

  const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(path);
  const publicUrl = urlData?.publicUrl;
  if (!publicUrl) throw new Error("Could not resolve public URL");

  const { error: rpcErr } = await supabase.rpc(
    "update_my_profile_photo" as never,
    { p_url: publicUrl } as never,
  );
  if (rpcErr) {
    const { error: updErr } = await supabase
      .from("profiles")
      .update({ profile_photo_url: publicUrl } as never)
      .eq("auth_user_id", userId);
    if (updErr) {
      const { error: upd2 } = await supabase
        .from("profiles")
        .update({ profile_photo_url: publicUrl } as never)
        .eq("id", pid);
      if (upd2) throw upd2;
    }
  }
  return publicUrl;
}
