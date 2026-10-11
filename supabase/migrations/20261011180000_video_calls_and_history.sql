-- Video calls (same flow as voice) and a call history list.

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'voice' CHECK (kind IN ('voice', 'video'));

-- Start a voice or video call. start_call(uuid) stays for older app versions (voice).
CREATE OR REPLACE FUNCTION public.start_call_with(p_conversation_id UUID, p_kind TEXT DEFAULT 'voice')
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
  IF p_kind NOT IN ('voice', 'video') THEN
    RAISE EXCEPTION 'Unknown call type';
  END IF;
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

  IF v_uid <> v_conv.customer_id AND v_conv.kind = 'support' THEN
    v_name := 'Kano Kaftan Support';
  ELSIF v_uid = v_conv.customer_id THEN
    SELECT COALESCE(NULLIF(btrim(full_name), ''), 'A customer') INTO v_name FROM public.profiles WHERE id = v_uid;
  ELSE
    SELECT COALESCE(NULLIF(store_name, ''), NULLIF(btrim(full_name), ''), 'Kano Kaftan user')
    INTO v_name FROM public.profiles WHERE id = v_uid;
  END IF;

  INSERT INTO public.calls (conversation_id, caller_id, callee_id, to_support, caller_name, kind)
  VALUES (p_conversation_id, v_uid, v_callee, v_support, v_name, p_kind)
  RETURNING * INTO v_call;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  SELECT r.user_id, format('Incoming %s call from %s', p_kind, v_name), 'Tap to answer', 'info', 'call',
         CASE WHEN v_support THEN '/admin/messages/' ELSE '/messages/' END || p_conversation_id,
         jsonb_build_object('call_id', v_call.id, 'conversation_id', p_conversation_id, 'kind', p_kind)
  FROM (
    SELECT v_callee AS user_id WHERE v_callee IS NOT NULL
    UNION
    SELECT ur.user_id FROM public.user_roles ur WHERE v_support AND ur.role = 'admin'
  ) r;

  RETURN v_call;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_call(p_conversation_id UUID)
RETURNS public.calls
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT public.start_call_with(p_conversation_id, 'voice') $$;

-- Chat note for missed/declined calls now names the call type.
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
  v_icon TEXT;
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
    RETURN v_call;
  END IF;

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
    v_icon := CASE WHEN v_call.kind = 'video' THEN '📹' ELSE '📞' END;
    INSERT INTO public.messages (conversation_id, sender_id, body)
    VALUES (
      v_call.conversation_id,
      v_call.caller_id,
      format('%s %s %s call', v_icon,
        CASE WHEN v_status = 'declined' THEN 'Declined' ELSE 'Missed' END, v_call.kind)
    );
  END IF;

  RETURN v_call;
END;
$$;

-- Call history for the signed-in user, newest first.
CREATE OR REPLACE FUNCTION public.list_my_calls(p_limit INTEGER DEFAULT 50)
RETURNS TABLE (
  id UUID,
  conversation_id UUID,
  kind TEXT,
  status TEXT,
  outgoing BOOLEAN,
  other_party_name TEXT,
  other_party_avatar TEXT,
  created_at TIMESTAMPTZ,
  duration_seconds INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.conversation_id,
    c.kind,
    c.status,
    c.caller_id = auth.uid(),
    CASE
      WHEN c.caller_id = auth.uid() AND c.to_support THEN 'Kano Kaftan Support'
      WHEN c.caller_id = auth.uid() THEN
        CASE WHEN o.store_name IS NOT NULL AND o.id = conv.vendor_id THEN o.store_name
             ELSE COALESCE(NULLIF(btrim(o.full_name), ''), 'Customer') END
      ELSE c.caller_name
    END,
    CASE WHEN c.caller_id = auth.uid() AND c.to_support THEN NULL ELSE o.avatar_url END,
    c.created_at,
    CASE WHEN c.answered_at IS NOT NULL AND c.ended_at IS NOT NULL
      THEN GREATEST(0, EXTRACT(EPOCH FROM (c.ended_at - c.answered_at)))::INTEGER END
  FROM public.calls c
  JOIN public.conversations conv ON conv.id = c.conversation_id
  LEFT JOIN public.profiles o ON o.id = CASE WHEN c.caller_id = auth.uid() THEN c.callee_id ELSE c.caller_id END
  WHERE (auth.uid() IN (c.caller_id, c.callee_id)
         -- Support calls nobody answered show up for every admin.
         OR (c.to_support AND c.callee_id IS NULL AND public.has_role(auth.uid(), 'admin')))
    AND c.status NOT IN ('ringing', 'accepted')
  ORDER BY c.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;

REVOKE ALL ON FUNCTION public.start_call_with(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_my_calls(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_call_with(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_calls(INTEGER) TO authenticated;
