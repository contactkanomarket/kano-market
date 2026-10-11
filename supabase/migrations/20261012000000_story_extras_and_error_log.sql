-- Story extras (follower alerts, who viewed, old-photo clean-up) and the app error log.

-- ── Followers hear about new stories ──────────────────────────────────────
/** A seller posting several stories in a row only alerts followers once in this window. */
CREATE OR REPLACE FUNCTION public.story_alert_cooldown()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT interval '6 hours' $$;

CREATE OR REPLACE FUNCTION public.notify_followers_of_new_story()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_store TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.vendor_stories
    WHERE vendor_id = NEW.vendor_id AND id <> NEW.id AND created_at > now() - public.story_alert_cooldown()
  ) THEN
    RETURN NEW;
  END IF;
  SELECT store_name INTO v_store FROM public.profiles WHERE id = NEW.vendor_id;
  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  SELECT f.user_id,
         format('%s posted a story', COALESCE(v_store, 'A shop you follow')),
         COALESCE(NEW.caption, 'Tap to see it before it disappears in 24 hours'),
         'info', 'promotion',
         '/stories/' || NEW.vendor_id,
         jsonb_build_object('story_id', NEW.id, 'vendor_id', NEW.vendor_id)
  FROM public.shop_follows f
  WHERE f.vendor_id = NEW.vendor_id AND f.user_id <> NEW.vendor_id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never stop a story from posting because an alert failed.
  RAISE WARNING 'notify_followers_of_new_story failed: %', SQLERRM;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER vendor_stories_notify_followers
  AFTER INSERT ON public.vendor_stories
  FOR EACH ROW EXECUTE FUNCTION public.notify_followers_of_new_story();
REVOKE EXECUTE ON FUNCTION public.notify_followers_of_new_story() FROM PUBLIC, anon, authenticated;

-- ── Who viewed my story ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.story_viewers(p_story_id UUID)
RETURNS TABLE (user_id UUID, name TEXT, avatar_url TEXT, viewed_at TIMESTAMPTZ, liked BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.vendor_stories WHERE id = p_story_id AND vendor_id = auth.uid()) THEN
    RAISE EXCEPTION 'Story not found';
  END IF;
  RETURN QUERY
  SELECT v.user_id,
         COALESCE(NULLIF(p.store_name, ''), NULLIF(btrim(p.full_name), ''), 'Kano Kaftan shopper'),
         p.avatar_url,
         v.viewed_at,
         COALESCE(l.liked, false)
  FROM public.story_views v
  LEFT JOIN public.profiles p ON p.id = v.user_id
  LEFT JOIN public.story_likes l ON l.story_id = v.story_id AND l.user_id = v.user_id
  WHERE v.story_id = p_story_id
  ORDER BY COALESCE(l.liked, false) DESC, v.viewed_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.story_viewers(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.story_viewers(UUID) TO authenticated;

-- ── Old story photos are removed from storage after 30 days ───────────────
ALTER TABLE public.vendor_stories ADD COLUMN IF NOT EXISTS photo_deleted_at TIMESTAMPTZ;

/** How long story photos are kept (sellers see 30 days of stats). */
CREATE OR REPLACE FUNCTION public.story_photo_retention()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT interval '30 days' $$;

/** Asks the story-cleanup function to delete old photos (run daily by pg_cron). */
CREATE OR REPLACE FUNCTION public.run_story_cleanup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cfg public.push_config%ROWTYPE;
BEGIN
  SELECT * INTO v_cfg FROM public.push_config WHERE id = 1;
  IF v_cfg.function_url IS NULL OR v_cfg.hook_secret IS NULL THEN
    RAISE WARNING 'run_story_cleanup: push_config not set up';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := regexp_replace(v_cfg.function_url, '/push/?$', '/story-cleanup'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_cfg.hook_secret),
    body := '{}'::jsonb
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.run_story_cleanup() FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('story-photo-cleanup', '17 3 * * *', 'SELECT public.run_story_cleanup()');

-- ── App error log (so admins hear about crashes on people's phones) ──────
CREATE TABLE IF NOT EXISTS public.client_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Same message on the same page = same problem; counted instead of stored again.
  fingerprint TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  page TEXT,
  user_agent TEXT,
  release TEXT,
  last_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  affected_users INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS client_errors_fingerprint_idx ON public.client_errors (fingerprint);
CREATE INDEX IF NOT EXISTS client_errors_last_seen_idx ON public.client_errors (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS client_errors_last_user_idx ON public.client_errors (last_user_id);
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view app errors" ON public.client_errors
  FOR SELECT USING (public.has_role((SELECT auth.uid()), 'admin'));

/** Stops a crash loop on one phone from flooding the log. */
CREATE OR REPLACE FUNCTION public.client_errors_hourly_cap()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT 300 $$;

CREATE OR REPLACE FUNCTION public.log_client_error(
  p_message TEXT,
  p_stack TEXT DEFAULT NULL,
  p_page TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_release TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_message TEXT := left(btrim(COALESCE(p_message, '')), 500);
  v_page TEXT := left(regexp_replace(COALESCE(p_page, ''), '[?#].*$', ''), 300);
  v_fingerprint TEXT;
  v_row public.client_errors%ROWTYPE;
  v_new_user BOOLEAN;
BEGIN
  IF v_message = '' THEN RETURN; END IF;
  -- Collapse ids/numbers so "/products/abc-123" style pages group together.
  v_fingerprint := md5(regexp_replace(v_message, '[0-9a-f]{8}-[0-9a-f-]{27}|\d+', '#', 'g') || '|' ||
                       regexp_replace(v_page, '/[^/]*\d[^/]*', '/:id', 'g'));

  IF (SELECT COALESCE(sum(occurrences), 0) FROM public.client_errors WHERE last_seen_at > now() - interval '1 hour')
     >= public.client_errors_hourly_cap() THEN
    RETURN;
  END IF;

  SELECT * INTO v_row FROM public.client_errors WHERE fingerprint = v_fingerprint FOR UPDATE;
  IF FOUND THEN
    v_new_user := auth.uid() IS NOT NULL AND v_row.last_user_id IS DISTINCT FROM auth.uid();
    UPDATE public.client_errors
    SET occurrences = occurrences + 1,
        affected_users = affected_users + CASE WHEN v_new_user THEN 1 ELSE 0 END,
        last_seen_at = now(),
        last_user_id = COALESCE(auth.uid(), last_user_id),
        stack = COALESCE(left(p_stack, 4000), stack),
        user_agent = COALESCE(left(p_user_agent, 300), user_agent),
        release = COALESCE(left(p_release, 60), release),
        -- It came back after being marked fixed.
        resolved_at = NULL
    WHERE id = v_row.id;
    IF v_row.resolved_at IS NULL THEN RETURN; END IF;
  ELSE
    INSERT INTO public.client_errors (fingerprint, message, stack, page, user_agent, release, last_user_id)
    VALUES (v_fingerprint, v_message, left(p_stack, 4000), v_page, left(p_user_agent, 300), left(p_release, 60), auth.uid());
  END IF;

  -- New problem (or one that came back): tell the admins once.
  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  SELECT ur.user_id, 'App error on a customer''s phone', left(v_message, 140), 'warning', 'system',
         '/admin/errors', jsonb_build_object('fingerprint', v_fingerprint)
  FROM public.user_roles ur WHERE ur.role = 'admin';
END;
$$;
GRANT EXECUTE ON FUNCTION public.log_client_error(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_error_resolved(p_error_id UUID, p_resolved BOOLEAN)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'Admins only'; END IF;
  UPDATE public.client_errors SET resolved_at = CASE WHEN p_resolved THEN now() END WHERE id = p_error_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Error not found'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_error_resolved(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_error_resolved(UUID, BOOLEAN) TO authenticated;
