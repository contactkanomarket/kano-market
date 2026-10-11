-- Vendor stories: sellers post a photo that stays up for 24 hours. Shoppers
-- tap the ring around a seller's picture to see it, like it or save it.
-- Gold sellers get a gold ring and are listed first.

CREATE TABLE IF NOT EXISTS public.vendor_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  caption TEXT CHECK (caption IS NULL OR char_length(caption) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  -- Set when the seller takes a story down (kept for their stats).
  removed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS vendor_stories_active_idx ON public.vendor_stories (vendor_id, expires_at DESC) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.story_views (
  story_id UUID NOT NULL REFERENCES public.vendor_stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);

-- liked = false means "unliked" (rows are never deleted).
CREATE TABLE IF NOT EXISTS public.story_likes (
  story_id UUID NOT NULL REFERENCES public.vendor_stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  liked BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);

ALTER TABLE public.vendor_stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.story_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.story_likes ENABLE ROW LEVEL SECURITY;

-- Everyone sees live stories; sellers also see their own old ones.
CREATE POLICY "Anyone can view live stories" ON public.vendor_stories
  FOR SELECT USING (
    (removed_at IS NULL AND expires_at > now()) OR vendor_id = auth.uid()
  );
-- Writes go through the functions below only.
CREATE POLICY "People see their own story views" ON public.story_views
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "People see their own story likes" ON public.story_likes
  FOR SELECT USING (user_id = auth.uid());

/** Longest a story can be up. */
CREATE OR REPLACE FUNCTION public.story_lifetime()
RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '24 hours' $$;

/** Most live stories one seller can have at once. */
CREATE OR REPLACE FUNCTION public.story_max_active()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;

CREATE OR REPLACE FUNCTION public.create_story(p_image_url TEXT, p_caption TEXT DEFAULT NULL)
RETURNS public.vendor_stories
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.vendor_stories;
  v_active INTEGER;
  v_caption TEXT := NULLIF(btrim(COALESCE(p_caption, '')), '');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Please sign in'; END IF;
  IF NOT public.has_role(v_uid, 'vendor') THEN
    RAISE EXCEPTION 'Only sellers can post stories';
  END IF;
  -- Must be a photo this seller uploaded to the public product-images bucket.
  IF p_image_url IS NULL
     OR p_image_url !~ '^https://'
     OR position(format('/storage/v1/object/public/product-images/%s/stories/', v_uid) IN p_image_url) = 0 THEN
    RAISE EXCEPTION 'Upload the story photo first';
  END IF;
  IF v_caption IS NOT NULL AND char_length(v_caption) > 200 THEN
    RAISE EXCEPTION 'Caption must be 200 characters or fewer';
  END IF;
  SELECT count(*) INTO v_active FROM public.vendor_stories
  WHERE vendor_id = v_uid AND removed_at IS NULL AND expires_at > now();
  IF v_active >= public.story_max_active() THEN
    RAISE EXCEPTION 'You can have up to % live stories. Remove one first.', public.story_max_active();
  END IF;

  INSERT INTO public.vendor_stories (vendor_id, image_url, caption, expires_at)
  VALUES (v_uid, p_image_url, v_caption, now() + public.story_lifetime())
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_story(p_story_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.vendor_stories SET removed_at = now()
  WHERE id = p_story_id AND removed_at IS NULL
    AND (vendor_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
  IF NOT FOUND THEN RAISE EXCEPTION 'Story not found'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_story_viewed(p_story_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF; -- guests can watch; they just aren't counted
  INSERT INTO public.story_views (story_id, user_id)
  SELECT s.id, auth.uid() FROM public.vendor_stories s
  WHERE s.id = p_story_id AND s.removed_at IS NULL AND s.expires_at > now()
    AND s.vendor_id <> auth.uid() -- a seller watching their own story doesn't count
  ON CONFLICT (story_id, user_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_story_like(p_story_id UUID, p_liked BOOLEAN)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Please sign in to like stories'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vendor_stories WHERE id = p_story_id AND removed_at IS NULL AND expires_at > now()) THEN
    RAISE EXCEPTION 'This story has ended';
  END IF;
  INSERT INTO public.story_likes (story_id, user_id, liked, updated_at)
  VALUES (p_story_id, auth.uid(), COALESCE(p_liked, false), now())
  ON CONFLICT (story_id, user_id) DO UPDATE SET liked = EXCLUDED.liked, updated_at = now();
  SELECT count(*) INTO v_count FROM public.story_likes WHERE story_id = p_story_id AND liked;
  RETURN v_count;
END;
$$;

/** One entry per seller with a live story, for the rings on the home page. */
CREATE OR REPLACE FUNCTION public.story_rings(p_limit INTEGER DEFAULT 30)
RETURNS TABLE (
  vendor_id UUID,
  store_name TEXT,
  store_slug TEXT,
  avatar_url TEXT,
  verification_tier TEXT,
  latest_at TIMESTAMPTZ,
  story_count INTEGER,
  all_seen BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.id, p.store_name, p.store_slug, p.avatar_url,
         CASE WHEN p.is_verified THEN p.verification_tier END,
         max(s.created_at), count(*)::int,
         bool_and(v.story_id IS NOT NULL OR s.vendor_id = auth.uid())
  FROM public.vendor_stories s
  JOIN public.profiles p ON p.id = s.vendor_id
  LEFT JOIN public.story_views v ON v.story_id = s.id AND v.user_id = auth.uid()
  WHERE s.removed_at IS NULL AND s.expires_at > now() AND p.store_name IS NOT NULL
  GROUP BY p.id
  -- Unseen first, then gold sellers, then newest.
  ORDER BY bool_and(v.story_id IS NOT NULL OR s.vendor_id = auth.uid()),
           (p.is_verified AND p.verification_tier = 'gold') DESC,
           max(s.created_at) DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$$;

/** A seller's live stories, oldest first (the order they play in). */
CREATE OR REPLACE FUNCTION public.vendor_live_stories(p_vendor_id UUID)
RETURNS TABLE (
  id UUID,
  image_url TEXT,
  caption TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  like_count INTEGER,
  liked_by_me BOOLEAN,
  seen_by_me BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT s.id, s.image_url, s.caption, s.created_at, s.expires_at,
         (SELECT count(*)::int FROM public.story_likes l WHERE l.story_id = s.id AND l.liked),
         EXISTS (SELECT 1 FROM public.story_likes l WHERE l.story_id = s.id AND l.user_id = auth.uid() AND l.liked),
         EXISTS (SELECT 1 FROM public.story_views v WHERE v.story_id = s.id AND v.user_id = auth.uid())
  FROM public.vendor_stories s
  WHERE s.vendor_id = p_vendor_id AND s.removed_at IS NULL AND s.expires_at > now()
  ORDER BY s.created_at;
$$;

/** The signed-in seller's stories (last 30 days) with views and likes. */
CREATE OR REPLACE FUNCTION public.my_stories()
RETURNS TABLE (
  id UUID,
  image_url TEXT,
  caption TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  view_count INTEGER,
  like_count INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT s.id, s.image_url, s.caption, s.created_at, s.expires_at, s.removed_at,
         (SELECT count(*)::int FROM public.story_views v WHERE v.story_id = s.id),
         (SELECT count(*)::int FROM public.story_likes l WHERE l.story_id = s.id AND l.liked)
  FROM public.vendor_stories s
  WHERE s.vendor_id = auth.uid() AND s.created_at > now() - interval '30 days'
  ORDER BY s.created_at DESC;
$$;

-- Signed-in people only (each function also checks).
REVOKE ALL ON FUNCTION public.create_story(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_story(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_story_like(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_stories() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_story(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_story(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_story_like(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_stories() TO authenticated;
