-- Message delivery receipts for WhatsApp-style ticks
ALTER TABLE public.campus_messages
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_campus_messages_undelivered
  ON public.campus_messages (conversation_id, created_at)
  WHERE delivered_at IS NULL AND deleted_at IS NULL;

-- Mark messages from others as delivered for this conversation (caller is recipient)
CREATE OR REPLACE FUNCTION public.mark_messages_delivered(p_conversation_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  n int;
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
    RETURN 0;
  END IF;

  UPDATE public.campus_messages
  SET delivered_at = now()
  WHERE conversation_id = p_conversation_id
    AND sender_id <> auth.uid()
    AND delivered_at IS NULL
    AND deleted_at IS NULL;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_messages_delivered(uuid) TO authenticated;

-- Allow members to update delivery on messages they received (if not using RPC)
DROP POLICY IF EXISTS "msg_update_delivery" ON public.campus_messages;
CREATE POLICY "msg_update_delivery"
  ON public.campus_messages
  FOR UPDATE
  TO authenticated
  USING (
    public.is_conversation_member(conversation_id)
    AND sender_id <> auth.uid()
  )
  WITH CHECK (
    public.is_conversation_member(conversation_id)
  );
