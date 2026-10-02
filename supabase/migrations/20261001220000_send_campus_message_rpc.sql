-- Reliable message send + list via SECURITY DEFINER (bypasses recursive RLS issues)
CREATE OR REPLACE FUNCTION public.send_campus_message(
  p_conversation_id uuid,
  p_body text DEFAULT NULL,
  p_attachment_url text DEFAULT NULL,
  p_attachment_type text DEFAULT NULL,
  p_client_id text DEFAULT NULL,
  p_reply_to_id uuid DEFAULT NULL,
  p_forwarded_from_id uuid DEFAULT NULL,
  p_duration_sec numeric DEFAULT NULL
)
RETURNS public.campus_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  uid uuid := auth.uid();
  msg public.campus_messages;
  preview text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id
      AND user_id = uid
      AND left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Not a member of this conversation';
  END IF;

  -- Idempotent: existing client_id
  IF p_client_id IS NOT NULL THEN
    SELECT * INTO msg FROM public.campus_messages
    WHERE conversation_id = p_conversation_id AND client_id = p_client_id
    LIMIT 1;
    IF FOUND THEN
      RETURN msg;
    END IF;
  END IF;

  INSERT INTO public.campus_messages (
    conversation_id, sender_id, body, attachment_url, attachment_type,
    reply_to_id, forwarded_from_id, client_id, duration_sec
  ) VALUES (
    p_conversation_id, uid, p_body, p_attachment_url, p_attachment_type,
    p_reply_to_id, p_forwarded_from_id, p_client_id, p_duration_sec
  )
  RETURNING * INTO msg;

  -- Build preview
  preview := COALESCE(
    NULLIF(trim(p_body), ''),
    CASE
      WHEN p_attachment_type ILIKE '%audio%' OR p_attachment_type = 'voice' THEN '🎤 Voice note'
      WHEN p_attachment_type ILIKE '%image%' OR p_attachment_type = 'photo' THEN '📷 Photo'
      WHEN p_attachment_type ILIKE '%video%' THEN '🎥 Video'
      WHEN p_attachment_type = 'call' THEN '📞 Call'
      WHEN p_attachment_url IS NOT NULL THEN '📄 Document'
      ELSE 'Message'
    END
  );

  UPDATE public.conversations
  SET
    last_message_at = msg.created_at,
    last_message_preview = left(preview, 120),
    last_message_sender_id = uid,
    updated_at = now()
  WHERE id = p_conversation_id;

  RETURN msg;
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_campus_message(uuid, text, text, text, text, uuid, uuid, numeric) TO authenticated;

-- List messages with membership check (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.list_campus_messages(
  p_conversation_id uuid,
  p_limit int DEFAULT 120
)
RETURNS SETOF public.campus_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id
      AND user_id = auth.uid()
      AND left_at IS NULL
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT m.*
  FROM public.campus_messages m
  WHERE m.conversation_id = p_conversation_id
    AND m.deleted_at IS NULL
  ORDER BY m.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 120), 500));
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_campus_messages(uuid, int) TO authenticated;
