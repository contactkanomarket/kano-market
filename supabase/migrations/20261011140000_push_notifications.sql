-- Phone push notifications (lock screen / notification panel).
--
-- Every row added to public.notifications is also sent as a web push to the
-- user's subscribed devices: the trigger below calls the "push" edge function
-- through pg_net. The function holds the VAPID keys; it creates them itself on
-- first use, so no private key is ever typed or copied by a person.

CREATE EXTENSION IF NOT EXISTS pg_net;

-- Server-only settings (no policies: only the service role can read it).
CREATE TABLE IF NOT EXISTS public.push_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  vapid_public_key TEXT,
  vapid_private_key TEXT,
  function_url TEXT,
  hook_secret TEXT NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.push_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.push_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_config FROM anon, authenticated;

-- One row per browser/phone that allowed notifications.
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see their push subscriptions"
ON public.push_subscriptions FOR SELECT
USING (user_id = auth.uid());

CREATE POLICY "Users can remove their push subscriptions"
ON public.push_subscriptions FOR DELETE
USING (user_id = auth.uid());

-- Saving a subscription goes through this function so a device that changes
-- hands (same endpoint, new account) moves to the new user.
CREATE OR REPLACE FUNCTION public.save_push_subscription(
  p_endpoint TEXT,
  p_p256dh TEXT,
  p_auth TEXT,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in first';
  END IF;
  IF p_endpoint !~ '^https://' OR char_length(p_endpoint) > 1000 THEN
    RAISE EXCEPTION 'Invalid push endpoint';
  END IF;

  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  VALUES (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  ON CONFLICT (endpoint) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    p256dh = EXCLUDED.p256dh,
    auth = EXCLUDED.auth,
    user_agent = EXCLUDED.user_agent;
END;
$$;

REVOKE ALL ON FUNCTION public.save_push_subscription(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- Send each new notification as a push (after the transaction commits).
CREATE OR REPLACE FUNCTION public.push_new_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg public.push_config%ROWTYPE;
BEGIN
  SELECT * INTO v_cfg FROM public.push_config WHERE id = 1;
  IF v_cfg.function_url IS NULL OR v_cfg.vapid_private_key IS NULL THEN
    RETURN NEW; -- push not set up yet
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.push_subscriptions WHERE user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_cfg.function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_cfg.hook_secret),
    body := jsonb_build_object('action', 'send', 'notification_id', NEW.id)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block the notification itself because a push could not be queued.
  RAISE WARNING 'push_new_notification failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

CREATE TRIGGER push_new_notification
AFTER INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.push_new_notification();

-- Admin announcement (promo, new arrivals...) to everyone or one group.
CREATE OR REPLACE FUNCTION public.admin_broadcast_notification(
  p_title TEXT,
  p_message TEXT,
  p_action_url TEXT DEFAULT NULL,
  p_audience TEXT DEFAULT 'customers'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only admins can send announcements';
  END IF;
  IF char_length(btrim(COALESCE(p_title, ''))) < 2 OR char_length(btrim(COALESCE(p_message, ''))) < 2 THEN
    RAISE EXCEPTION 'Write a title and a message';
  END IF;
  IF p_audience NOT IN ('everyone', 'customers', 'sellers') THEN
    RAISE EXCEPTION 'Unknown audience';
  END IF;
  IF p_action_url IS NOT NULL AND btrim(p_action_url) <> '' AND btrim(p_action_url) !~ '^/' THEN
    RAISE EXCEPTION 'The link must be a page on Kano Kaftan, e.g. /products';
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url)
  SELECT u.id, left(btrim(p_title), 80), left(btrim(p_message), 300), 'info', 'promotion', NULLIF(btrim(p_action_url), '')
  FROM auth.users u
  WHERE CASE p_audience
    WHEN 'everyone' THEN true
    WHEN 'sellers' THEN public.has_role(u.id, 'vendor')
    ELSE NOT public.has_role(u.id, 'vendor')
  END;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_broadcast_notification(TEXT, TEXT, TEXT, TEXT) TO authenticated;
