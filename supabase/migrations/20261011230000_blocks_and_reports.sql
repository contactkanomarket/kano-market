-- Block and report.
--  * Blocking someone stops messages and calls between you, both ways.
--    Unblocking keeps the row with active = false (nothing is deleted).
--  * Reports (a person, a message or a story) go to the admins.

CREATE TABLE IF NOT EXISTS public.user_blocks (
  blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON public.user_blocks (blocked_id) WHERE active;
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "People see who they blocked" ON public.user_blocks
  FOR SELECT USING (blocker_id = (SELECT auth.uid()));

CREATE TABLE IF NOT EXISTS public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('user', 'message', 'story')),
  target_id UUID NOT NULL,
  -- The person the report is about (the sender, the story's seller, or the user).
  reported_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam', 'scam', 'harassment', 'inappropriate', 'fake', 'other')),
  details TEXT CHECK (details IS NULL OR char_length(details) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'action_taken', 'dismissed')),
  admin_note TEXT,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_open_idx ON public.reports (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS reports_reporter_idx ON public.reports (reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_reported_user_idx ON public.reports (reported_user_id);
CREATE INDEX IF NOT EXISTS reports_conversation_idx ON public.reports (conversation_id);
CREATE INDEX IF NOT EXISTS reports_reviewed_by_idx ON public.reports (reviewed_by);
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view reports" ON public.reports
  FOR SELECT USING (public.has_role((SELECT auth.uid()), 'admin'));

/** Most reports one person can send in a day (stops report spam). */
CREATE OR REPLACE FUNCTION public.reports_daily_limit()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT 20 $$;

CREATE OR REPLACE FUNCTION public.is_blocked_between(p_a UUID, p_b UUID)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_blocks
    WHERE active AND ((blocker_id = p_a AND blocked_id = p_b) OR (blocker_id = p_b AND blocked_id = p_a))
  );
$$;

-- No new messages in a seller chat once either side has blocked the other.
CREATE OR REPLACE FUNCTION public.guard_blocked_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_conv public.conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = NEW.conversation_id;
  IF v_conv.kind = 'vendor' AND public.is_blocked_between(v_conv.customer_id, v_conv.vendor_id) THEN
    RAISE EXCEPTION 'You can''t send messages in this chat';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER messages_guard_blocked
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_blocked_message();

-- No calls either.
CREATE OR REPLACE FUNCTION public.guard_blocked_call()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.callee_id IS NOT NULL AND public.is_blocked_between(NEW.caller_id, NEW.callee_id) THEN
    RAISE EXCEPTION 'You can''t call this person';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER calls_guard_blocked
  BEFORE INSERT ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.guard_blocked_call();

REVOKE EXECUTE ON FUNCTION public.guard_blocked_message() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_blocked_call() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_blocked_between(UUID, UUID) FROM PUBLIC, anon, authenticated;

/** The other person in a seller chat (support chats can't be blocked). */
CREATE OR REPLACE FUNCTION public.conversation_other_user(p_conversation_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_conv public.conversations%ROWTYPE;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id;
  IF NOT FOUND OR v_conv.kind <> 'vendor' THEN RETURN NULL; END IF;
  IF auth.uid() = v_conv.customer_id THEN RETURN v_conv.vendor_id; END IF;
  IF auth.uid() = v_conv.vendor_id THEN RETURN v_conv.customer_id; END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.conversation_other_user(UUID) FROM PUBLIC, anon, authenticated;

/** Whether I blocked the other person in this chat, and whether they blocked me. */
CREATE OR REPLACE FUNCTION public.conversation_block_state(p_conversation_id UUID)
RETURNS TABLE (i_blocked BOOLEAN, blocked_me BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_other UUID := public.conversation_other_user(p_conversation_id);
BEGIN
  IF v_other IS NULL THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;
  RETURN QUERY SELECT
    EXISTS (SELECT 1 FROM public.user_blocks WHERE active AND blocker_id = auth.uid() AND blocked_id = v_other),
    EXISTS (SELECT 1 FROM public.user_blocks WHERE active AND blocker_id = v_other AND blocked_id = auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.set_conversation_block(p_conversation_id UUID, p_block BOOLEAN)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_other UUID := public.conversation_other_user(p_conversation_id);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in'; END IF;
  IF v_other IS NULL THEN RAISE EXCEPTION 'This chat can''t be blocked'; END IF;
  INSERT INTO public.user_blocks (blocker_id, blocked_id, active, updated_at)
  VALUES (auth.uid(), v_other, COALESCE(p_block, false), now())
  ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET active = EXCLUDED.active, updated_at = now();
  -- End any call that is ringing or live between the two.
  IF p_block THEN
    UPDATE public.calls SET status = 'ended', ended_at = now()
    WHERE status IN ('ringing', 'accepted')
      AND ((caller_id = auth.uid() AND callee_id = v_other) OR (caller_id = v_other AND callee_id = auth.uid()));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.report_content(
  p_target_type TEXT,
  p_target_id UUID,
  p_reason TEXT,
  p_details TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_reported UUID;
  v_conversation UUID;
  v_id UUID;
  v_details TEXT := NULLIF(btrim(COALESCE(p_details, '')), '');
  v_label TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Please sign in to report'; END IF;
  IF p_reason NOT IN ('spam', 'scam', 'harassment', 'inappropriate', 'fake', 'other') THEN
    RAISE EXCEPTION 'Choose a reason';
  END IF;
  IF v_details IS NOT NULL AND char_length(v_details) > 500 THEN
    RAISE EXCEPTION 'Please keep the details under 500 characters';
  END IF;
  IF (SELECT count(*) FROM public.reports WHERE reporter_id = v_uid AND created_at > now() - interval '1 day') >= public.reports_daily_limit() THEN
    RAISE EXCEPTION 'You have sent a lot of reports today. Please try again tomorrow.';
  END IF;

  IF p_target_type = 'user' THEN
    -- p_target_id is the conversation with that person.
    v_conversation := p_target_id;
    v_reported := public.conversation_other_user(p_target_id);
    IF v_reported IS NULL THEN RAISE EXCEPTION 'Chat not found'; END IF;
    v_label := 'a person';
  ELSIF p_target_type = 'message' THEN
    SELECT m.sender_id, m.conversation_id INTO v_reported, v_conversation FROM public.messages m WHERE m.id = p_target_id;
    IF v_conversation IS NULL OR NOT public.can_access_conversation(v_conversation) THEN RAISE EXCEPTION 'Message not found'; END IF;
    IF v_reported = v_uid THEN RAISE EXCEPTION 'You can''t report your own message'; END IF;
    v_label := 'a message';
  ELSIF p_target_type = 'story' THEN
    SELECT s.vendor_id INTO v_reported FROM public.vendor_stories s WHERE s.id = p_target_id;
    IF v_reported IS NULL THEN RAISE EXCEPTION 'Story not found'; END IF;
    IF v_reported = v_uid THEN RAISE EXCEPTION 'You can''t report your own story'; END IF;
    v_label := 'a story';
  ELSE
    RAISE EXCEPTION 'Unknown report type';
  END IF;

  -- One open report per person per item is enough.
  SELECT id INTO v_id FROM public.reports
  WHERE reporter_id = v_uid AND target_type = p_target_type AND target_id = p_target_id AND status = 'open';
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO public.reports (reporter_id, target_type, target_id, reported_user_id, conversation_id, reason, details)
  VALUES (v_uid, p_target_type, p_target_id, v_reported, v_conversation, p_reason, v_details)
  RETURNING id INTO v_id;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  SELECT ur.user_id, format('New report: %s', v_label), format('Reason: %s', p_reason), 'warning', 'system',
         '/admin/moderation', jsonb_build_object('report_id', v_id)
  FROM public.user_roles ur WHERE ur.role = 'admin';

  RETURN v_id;
END;
$$;

/** Admin list of reports with enough context to decide. */
CREATE OR REPLACE FUNCTION public.admin_list_reports(p_status TEXT DEFAULT 'open', p_limit INTEGER DEFAULT 100)
RETURNS TABLE (
  id UUID,
  target_type TEXT,
  target_id UUID,
  reason TEXT,
  details TEXT,
  status TEXT,
  admin_note TEXT,
  created_at TIMESTAMPTZ,
  reporter_name TEXT,
  reported_user_id UUID,
  reported_name TEXT,
  conversation_id UUID,
  message_body TEXT,
  story_image_url TEXT,
  story_caption TEXT,
  story_live BOOLEAN,
  reports_against_user INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admins only'; END IF;
  RETURN QUERY
  SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.admin_note, r.created_at,
         COALESCE(NULLIF(btrim(rp.full_name), ''), rp.email, 'Someone'),
         r.reported_user_id,
         COALESCE(NULLIF(tp.store_name, ''), NULLIF(btrim(tp.full_name), ''), tp.email, 'Unknown'),
         r.conversation_id,
         CASE WHEN r.target_type = 'message' THEN m.body END,
         s.image_url, s.caption,
         (s.id IS NOT NULL AND s.removed_at IS NULL AND s.expires_at > now()),
         (SELECT count(*)::int FROM public.reports x WHERE x.reported_user_id = r.reported_user_id)
  FROM public.reports r
  LEFT JOIN public.profiles rp ON rp.id = r.reporter_id
  LEFT JOIN public.profiles tp ON tp.id = r.reported_user_id
  LEFT JOIN public.messages m ON r.target_type = 'message' AND m.id = r.target_id
  LEFT JOIN public.vendor_stories s ON r.target_type = 'story' AND s.id = r.target_id
  WHERE p_status IS NULL OR r.status = p_status
  ORDER BY r.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_resolve_report(p_report_id UUID, p_status TEXT, p_note TEXT DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admins only'; END IF;
  IF p_status NOT IN ('open', 'action_taken', 'dismissed') THEN RAISE EXCEPTION 'Unknown status'; END IF;
  UPDATE public.reports
  SET status = p_status,
      admin_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
      reviewed_by = CASE WHEN p_status = 'open' THEN NULL ELSE auth.uid() END,
      reviewed_at = CASE WHEN p_status = 'open' THEN NULL ELSE now() END
  WHERE id = p_report_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report not found'; END IF;
END;
$$;

/** Every live story, for admins to look over and take down. */
CREATE OR REPLACE FUNCTION public.admin_live_stories()
RETURNS TABLE (
  id UUID,
  vendor_id UUID,
  store_name TEXT,
  image_url TEXT,
  caption TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  view_count INTEGER,
  like_count INTEGER,
  open_reports INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admins only'; END IF;
  RETURN QUERY
  SELECT s.id, s.vendor_id, p.store_name, s.image_url, s.caption, s.created_at, s.expires_at,
         (SELECT count(*)::int FROM public.story_views v WHERE v.story_id = s.id),
         (SELECT count(*)::int FROM public.story_likes l WHERE l.story_id = s.id AND l.liked),
         (SELECT count(*)::int FROM public.reports r WHERE r.target_type = 'story' AND r.target_id = s.id AND r.status = 'open')
  FROM public.vendor_stories s
  JOIN public.profiles p ON p.id = s.vendor_id
  WHERE s.removed_at IS NULL AND s.expires_at > now()
  ORDER BY 10 DESC, s.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.conversation_block_state(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_conversation_block(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_content(TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_reports(TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_resolve_report(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_live_stories() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.conversation_block_state(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_conversation_block(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_content(TEXT, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_reports(TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_report(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_live_stories() TO authenticated;
