-- Fix infinite recursion on conversation_members RLS.
-- Root cause: cm_select policy called is_conversation_member() which SELECT'd the same table under RLS.
-- Fix: harden SECURITY DEFINER helpers and re-apply policies.

CREATE OR REPLACE FUNCTION public.is_conversation_member(cid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_members m
    WHERE m.conversation_id = cid
      AND m.user_id = auth.uid()
      AND m.left_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.is_conversation_admin(cid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_members m
    WHERE m.conversation_id = cid
      AND m.user_id = auth.uid()
      AND m.left_at IS NULL
      AND m.role IN ('admin', 'owner')
  );
$$;

ALTER FUNCTION public.is_conversation_member(uuid) OWNER TO postgres;
ALTER FUNCTION public.is_conversation_admin(uuid) OWNER TO postgres;

GRANT EXECUTE ON FUNCTION public.is_conversation_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_conversation_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_conversation_member(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_conversation_admin(uuid) TO service_role;

DROP POLICY IF EXISTS "cm_select" ON public.conversation_members;
CREATE POLICY "cm_select" ON public.conversation_members
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_conversation_member(conversation_id)
  );

DROP POLICY IF EXISTS "cm_insert" ON public.conversation_members;
CREATE POLICY "cm_insert" ON public.conversation_members
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    OR public.is_conversation_admin(conversation_id)
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id AND c.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "cm_update_self" ON public.conversation_members;
CREATE POLICY "cm_update_self" ON public.conversation_members
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_conversation_admin(conversation_id)
  );

DROP POLICY IF EXISTS "conv_select_member" ON public.conversations;
CREATE POLICY "conv_select_member" ON public.conversations
  FOR SELECT TO authenticated
  USING (public.is_conversation_member(id));

DROP POLICY IF EXISTS "conv_update_member" ON public.conversations;
DROP POLICY IF EXISTS "conv_update_admin" ON public.conversations;
CREATE POLICY "conv_update_member" ON public.conversations
  FOR UPDATE TO authenticated
  USING (public.is_conversation_member(id));

DROP POLICY IF EXISTS "msg_select" ON public.campus_messages;
CREATE POLICY "msg_select" ON public.campus_messages
  FOR SELECT TO authenticated
  USING (public.is_conversation_member(conversation_id));

DROP POLICY IF EXISTS "msg_insert" ON public.campus_messages;
CREATE POLICY "msg_insert" ON public.campus_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND public.is_conversation_member(conversation_id)
  );
