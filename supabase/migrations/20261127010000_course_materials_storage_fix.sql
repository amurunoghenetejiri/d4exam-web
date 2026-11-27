-- Ensure course-materials bucket exists, is public, and allows up to 50MB uploads.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('course-materials', 'course-materials', true, 52428800)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = GREATEST(COALESCE(storage.buckets.file_size_limit, 0), 52428800);

DROP POLICY IF EXISTS "course_materials_storage_write" ON storage.objects;
CREATE POLICY "course_materials_storage_write"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'course-materials');

DROP POLICY IF EXISTS "course_materials_storage_update" ON storage.objects;
CREATE POLICY "course_materials_storage_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'course-materials')
  WITH CHECK (bucket_id = 'course-materials');

DROP POLICY IF EXISTS "course_materials_storage_read" ON storage.objects;
CREATE POLICY "course_materials_storage_read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'course-materials');
