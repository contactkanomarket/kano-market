-- In-app HD voice calls between people who already have a chat, plus
-- "online / last seen" in the chat header.
--
-- Calls: a row in public.calls is the source of truth (who may join, state).
-- The audio itself is peer to peer (WebRTC); the browsers exchange connection
-- details over a Realtime broadcast channel named after the call id, which only
-- the two participants can read from public.calls.
-- Support chats have no fixed person on our side: a customer's call rings every
-- admin and the first admin to answer takes it.

-- ---------------------------------------------------------------------------
-- Presence
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Called by the app every minute while it is open (cheap: skips if recent).
CREATE OR REPLACE FUNCTION public.touch_last_seen()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.profiles
  SET last_seen_at = now()
  WHERE id = auth.uid()
    AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 seconds');
$$;

REVOKE ALL ON FUNCTION public.touch_last_seen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_last_seen() TO authenticated;

-- When the other side of a chat was last active. For a customer in a support
-- chat this is the most recently active admin ("Kano Kaftan").
CREATE OR REPLACE FUNCTION public.conversation_presence(p_conversation_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations%ROWTYPE;
  v_uid UUID := auth.uid();
  v_seen TIMESTAMPTZ;
BEGIN
  IF NOT public.can_access_conversation(p_conversation_id) THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id;

  IF v_uid = v_conv.customer_id AND v_conv.kind = 'support' THEN
    SELECT max(p.last_seen_at) INTO v_seen
    FROM public.user_roles ur JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'admin';
  ELSIF v_uid = v_conv.customer_id THEN
    SELECT last_seen_at INTO v_seen FROM public.profiles WHERE id = v_conv.vendor_id;
  ELSE
    SELECT last_seen_at INTO v_seen FROM public.profiles WHERE id = v_conv.customer_id;
  END IF;
  RETURN v_seen;
END;
$$;

REVOKE ALL ON FUNCTION public.conversation_presence(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.conversation_presence(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  caller_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- NULL while a call to support is ringing; set to the admin who answers.
  callee_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  to_support BOOLEAN NOT NULL DEFAULT false,
  caller_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ringing'
    CHECK (status IN ('ringing', 'accepted', 'declined', 'missed', 'cancelled', 'ended', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  CHECK (to_support OR callee_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_calls_callee_status ON public.calls(callee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_caller_status ON public.calls(caller_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_support_ringing ON public.calls(created_at DESC) WHERE to_support AND status = 'ringing';

ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can see their calls"
ON public.calls FOR SELECT
USING (
  auth.uid() IN (caller_id, callee_id)
  OR (to_support AND callee_id IS NULL AND public.has_role(auth.uid(), 'admin'))
);

ALTER PUBLICATION supabase_realtime ADD TABLE public.calls;

-- Seconds a call rings before it counts as missed.
CREATE OR REPLACE FUNCTION public.call_ring_seconds()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 45 $$;

-- Ringing calls nobody answered in time become missed.
CREATE OR REPLACE FUNCTION public.expire_stale_calls()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.calls SET status = 'missed', ended_at = now()
  WHERE status = 'ringing' AND created_at < now() - make_interval(secs => public.call_ring_seconds() + 15);
  -- An accepted call whose browsers vanished without hanging up.
  UPDATE public.calls SET status = 'ended', ended_at = now()
  WHERE status = 'accepted' AND answered_at < now() - interval '4 hours';
$$;

CREATE OR REPLACE FUNCTION public.start_call(p_conversation_id UUID)
RETURNS public.calls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_conv public.conversations%ROWTYPE;
  v_callee UUID;
  v_support BOOLEAN := false;
  v_name TEXT;
  v_call public.calls%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.can_access_conversation(p_conversation_id) THEN
    RAISE EXCEPTION 'You can only call people you are chatting with';
  END IF;
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id;

  IF v_uid = v_conv.customer_id THEN
    IF v_conv.kind = 'support' THEN
      v_support := true;
    ELSE
      v_callee := v_conv.vendor_id;
    END IF;
  ELSE
    v_callee := v_conv.customer_id;
  END IF;

  PERFORM public.expire_stale_calls();

  IF EXISTS (
    SELECT 1 FROM public.calls
    WHERE status IN ('ringing', 'accepted') AND v_uid IN (caller_id, callee_id)
  ) THEN
    RAISE EXCEPTION 'You are already in a call';
  END IF;
  IF v_callee IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.calls
    WHERE status IN ('ringing', 'accepted') AND v_callee IN (caller_id, callee_id)
  ) THEN
    RAISE EXCEPTION 'They are on another call. Try again in a moment.';
  END IF;

  -- How the caller appears on the other phone.
  IF v_uid <> v_conv.customer_id AND v_conv.kind = 'support' THEN
    v_name := 'Kano Kaftan Support';
  ELSE
    SELECT COALESCE(NULLIF(store_name, ''), NULLIF(btrim(full_name), ''), 'Kano Kaftan user')
    INTO v_name FROM public.profiles WHERE id = v_uid;
    IF v_uid = v_conv.customer_id THEN
      SELECT COALESCE(NULLIF(btrim(full_name), ''), 'A customer') INTO v_name FROM public.profiles WHERE id = v_uid;
    END IF;
  END IF;

  INSERT INTO public.calls (conversation_id, caller_id, callee_id, to_support, caller_name)
  VALUES (p_conversation_id, v_uid, v_callee, v_support, v_name)
  RETURNING * INTO v_call;

  -- Rings the phone even when the app is closed (push notification).
  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  SELECT r.user_id, format('Incoming voice call from %s', v_name), 'Tap to answer', 'info', 'call',
         CASE WHEN v_support THEN '/admin/messages/' ELSE '/messages/' END || p_conversation_id,
         jsonb_build_object('call_id', v_call.id, 'conversation_id', p_conversation_id)
  FROM (
    SELECT v_callee AS user_id WHERE v_callee IS NOT NULL
    UNION
    SELECT ur.user_id FROM public.user_roles ur WHERE v_support AND ur.role = 'admin'
  ) r;

  RETURN v_call;
END;
$$;

CREATE OR REPLACE FUNCTION public.answer_call(p_call_id UUID)
RETURNS public.calls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_call public.calls%ROWTYPE;
BEGIN
  SELECT * INTO v_call FROM public.calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Call not found';
  END IF;
  IF NOT (v_call.callee_id = v_uid OR (v_call.to_support AND v_call.callee_id IS NULL AND public.has_role(v_uid, 'admin'))) THEN
    RAISE EXCEPTION 'This call is not for you';
  END IF;
  IF v_call.status <> 'ringing' THEN
    RAISE EXCEPTION 'This call has ended';
  END IF;

  UPDATE public.calls
  SET status = 'accepted', answered_at = now(), callee_id = v_uid
  WHERE id = p_call_id
  RETURNING * INTO v_call;
  RETURN v_call;
END;
$$;

-- Hang up, decline, cancel or time out. Missed and declined calls leave a note in the chat.
CREATE OR REPLACE FUNCTION public.end_call(p_call_id UUID, p_reason TEXT DEFAULT 'hangup')
RETURNS public.calls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_call public.calls%ROWTYPE;
  v_is_callee BOOLEAN;
  v_status TEXT;
BEGIN
  SELECT * INTO v_call FROM public.calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Call not found';
  END IF;
  v_is_callee := v_call.callee_id = v_uid
    OR (v_call.to_support AND v_call.callee_id IS NULL AND public.has_role(v_uid, 'admin'));
  IF NOT (v_call.caller_id = v_uid OR v_is_callee) THEN
    RAISE EXCEPTION 'This call is not yours';
  END IF;
  IF v_call.status NOT IN ('ringing', 'accepted') THEN
    RETURN v_call; -- already over
  END IF;

  -- One admin declining a support call doesn't stop it ringing for the others.
  IF v_call.status = 'ringing' AND v_call.to_support AND v_call.callee_id IS NULL AND v_uid <> v_call.caller_id THEN
    RETURN v_call;
  END IF;

  v_status := CASE
    WHEN v_call.status = 'accepted' THEN CASE WHEN p_reason = 'failed' THEN 'failed' ELSE 'ended' END
    WHEN p_reason = 'timeout' THEN 'missed'
    WHEN v_uid = v_call.caller_id THEN 'cancelled'
    ELSE 'declined' END;

  UPDATE public.calls SET status = v_status, ended_at = now()
  WHERE id = p_call_id
  RETURNING * INTO v_call;

  IF v_status IN ('missed', 'cancelled', 'declined') THEN
    -- Sent as the caller, so the usual chat notification tells the other side.
    INSERT INTO public.messages (conversation_id, sender_id, body)
    VALUES (
      v_call.conversation_id,
      v_call.caller_id,
      CASE WHEN v_status = 'declined' THEN '📞 Voice call declined' ELSE '📞 Missed voice call' END
    );
  END IF;

  RETURN v_call;
END;
$$;

REVOKE ALL ON FUNCTION public.start_call(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.answer_call(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.end_call(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.expire_stale_calls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_call(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.answer_call(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_call(UUID, TEXT) TO authenticated;
