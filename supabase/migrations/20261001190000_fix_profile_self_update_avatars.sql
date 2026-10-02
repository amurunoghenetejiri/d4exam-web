-- Self-update helpers that avoid RLS recursion on profiles
CREATE OR REPLACE FUNCTION public.update_my_bio(p_bio text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_settings jsonb;
  v_bio text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  v_bio := left(trim(coalesce(p_bio, '')), 280);
  SELECT coalesce(settings, '{}'::jsonb) INTO v_settings
  FROM public.profiles
  WHERE auth_user_id = auth.uid()
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  v_settings := v_settings || jsonb_build_object('bio', v_bio);
  UPDATE public.profiles
  SET settings = v_settings,
      updated_at = now()
  WHERE auth_user_id = auth.uid();
  RETURN v_bio;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_my_profile_photo(p_url text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_url IS NULL OR length(trim(p_url)) < 8 THEN
    RAISE EXCEPTION 'Invalid photo URL';
  END IF;
  UPDATE public.profiles
  SET profile_photo_url = trim(p_url),
      updated_at = now()
  WHERE auth_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;
  RETURN trim(p_url);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_my_bio(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_profile_photo(text) TO authenticated;

-- Ensure simple self-update policy (no recursive helpers)
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- Avatars storage bucket for profile photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  true,
  3145728,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 3145728,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[];

DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;
CREATE POLICY "avatars_public_read"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_auth_upload" ON storage.objects;
CREATE POLICY "avatars_auth_upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = 'profiles');

DROP POLICY IF EXISTS "avatars_auth_update" ON storage.objects;
CREATE POLICY "avatars_auth_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = 'profiles');

DROP POLICY IF EXISTS "avatars_auth_delete" ON storage.objects;
CREATE POLICY "avatars_auth_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = 'profiles');
