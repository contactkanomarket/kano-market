-- Vendor shops (branding, short links, follows, directory) and customer-vendor chat.

-- ---------------------------------------------------------------------------
-- Shop branding + short link (/shop/<store_slug>)
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS store_slug TEXT,
  ADD COLUMN IF NOT EXISTS store_banner_url TEXT;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_store_slug_format
  CHECK (store_slug IS NULL OR store_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(store_slug) BETWEEN 3 AND 40);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_store_slug ON public.profiles(store_slug);

CREATE OR REPLACE FUNCTION public.slugify(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(trim(BOTH '-' FROM regexp_replace(lower(COALESCE(p_text, '')), '[^a-z0-9]+', '-', 'g')), 34)
$$;

-- Give every shop a unique slug from its name; normalise slugs vendors type in.
CREATE OR REPLACE FUNCTION public.set_store_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_base TEXT;
  v_candidate TEXT;
  v_n INTEGER := 1;
BEGIN
  IF NEW.store_slug IS NOT NULL THEN
    NEW.store_slug := public.slugify(NEW.store_slug);
    IF NEW.store_slug = '' THEN
      NEW.store_slug := NULL;
    END IF;
  END IF;

  IF NEW.store_slug IS NULL AND NEW.store_name IS NOT NULL THEN
    v_base := public.slugify(NEW.store_name);
    IF char_length(v_base) < 3 THEN
      v_base := rtrim('shop-' || v_base, '-');
    END IF;
    v_candidate := v_base;
    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE store_slug = v_candidate AND id <> NEW.id) LOOP
      v_n := v_n + 1;
      v_candidate := v_base || '-' || v_n;
    END LOOP;
    NEW.store_slug := v_candidate;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_store_slug ON public.profiles;
CREATE TRIGGER set_store_slug
BEFORE INSERT OR UPDATE OF store_name, store_slug ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_store_slug();

-- Backfill existing shops (fires the trigger).
UPDATE public.profiles SET store_slug = NULL WHERE store_name IS NOT NULL AND store_slug IS NULL;

DROP VIEW IF EXISTS public.public_vendor_profiles;
CREATE VIEW public.public_vendor_profiles
WITH (security_invoker = true)
AS
SELECT
  id,
  full_name,
  avatar_url,
  is_verified,
  store_name,
  store_slug,
  store_banner_url,
  store_description,
  store_address
FROM public.profiles
WHERE store_name IS NOT NULL;

GRANT SELECT ON public.public_vendor_profiles TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Follows
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shop_follows (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, vendor_id),
  CHECK (user_id <> vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_shop_follows_vendor ON public.shop_follows(vendor_id);

ALTER TABLE public.shop_follows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see the shops they follow"
ON public.shop_follows FOR SELECT
USING (user_id = auth.uid());

CREATE POLICY "Users can follow shops"
ON public.shop_follows FOR INSERT
WITH CHECK (user_id = auth.uid() AND public.has_role(vendor_id, 'vendor'));

CREATE POLICY "Users can unfollow shops"
ON public.shop_follows FOR DELETE
USING (user_id = auth.uid());

-- Tell followers when a shop lists something new.
CREATE OR REPLACE FUNCTION public.notify_followers_of_new_product()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store TEXT;
BEGIN
  IF NOT NEW.is_active THEN
    RETURN NEW;
  END IF;

  SELECT store_name INTO v_store FROM public.profiles WHERE id = NEW.vendor_id;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  SELECT f.user_id,
         format('New from %s', COALESCE(v_store, 'a shop you follow')),
         NEW.name,
         'info', 'promotion',
         '/products/' || NEW.slug,
         jsonb_build_object('product_id', NEW.id, 'vendor_id', NEW.vendor_id)
  FROM public.shop_follows f
  WHERE f.vendor_id = NEW.vendor_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_followers_of_new_product ON public.products;
CREATE TRIGGER notify_followers_of_new_product
AFTER INSERT ON public.products
FOR EACH ROW EXECUTE FUNCTION public.notify_followers_of_new_product();

-- ---------------------------------------------------------------------------
-- Shop listing / stats (public, safe columns only)
-- ---------------------------------------------------------------------------

CREATE TYPE public.shop_summary AS (
  id UUID,
  store_name TEXT,
  store_slug TEXT,
  store_description TEXT,
  avatar_url TEXT,
  store_banner_url TEXT,
  is_verified BOOLEAN,
  city TEXT,
  state TEXT,
  joined_at TIMESTAMPTZ,
  product_count BIGINT,
  follower_count BIGINT,
  items_sold BIGINT,
  rating NUMERIC,
  review_count BIGINT
);

CREATE OR REPLACE FUNCTION public.shop_summaries()
RETURNS SETOF public.shop_summary
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.store_name,
    p.store_slug,
    p.store_description,
    p.avatar_url,
    p.store_banner_url,
    p.is_verified,
    p.store_address ->> 'city',
    p.store_address ->> 'state',
    p.created_at,
    (SELECT count(*) FROM products pr WHERE pr.vendor_id = p.id AND pr.is_active),
    (SELECT count(*) FROM shop_follows f WHERE f.vendor_id = p.id),
    (SELECT COALESCE(sum(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.vendor_id = p.id AND o.payment_status = 'paid'),
    (SELECT round(avg(r.rating), 1) FROM reviews r JOIN products pr ON pr.id = r.product_id
      WHERE pr.vendor_id = p.id AND r.is_approved),
    (SELECT count(*) FROM reviews r JOIN products pr ON pr.id = r.product_id
      WHERE pr.vendor_id = p.id AND r.is_approved)
  FROM profiles p
  WHERE p.store_name IS NOT NULL
    AND public.has_role(p.id, 'vendor')
$$;

-- Directory: shops with at least one active product, verified first.
CREATE OR REPLACE FUNCTION public.list_shops(p_search TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 24, p_offset INTEGER DEFAULT 0)
RETURNS SETOF public.shop_summary
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.shop_summaries() s
  WHERE s.product_count > 0
    AND (p_search IS NULL OR btrim(p_search) = '' OR s.store_name ILIKE '%' || btrim(p_search) || '%')
  ORDER BY s.is_verified DESC, s.follower_count DESC, s.items_sold DESC, s.product_count DESC, s.store_name
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0)
$$;

-- One shop by slug, or by vendor id (old /vendor/:id links).
CREATE OR REPLACE FUNCTION public.get_shop(p_slug TEXT DEFAULT NULL, p_vendor_id UUID DEFAULT NULL)
RETURNS SETOF public.shop_summary
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.shop_summaries() s
  WHERE (p_slug IS NOT NULL AND s.store_slug = lower(p_slug))
     OR (p_vendor_id IS NOT NULL AND s.id = p_vendor_id)
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.get_shop_reviews(p_vendor_id UUID, p_limit INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  rating INTEGER,
  review_text TEXT,
  seller_reply TEXT,
  created_at TIMESTAMPTZ,
  product_name TEXT,
  product_slug TEXT,
  reviewer_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id, r.rating, r.review_text, r.seller_reply, r.created_at,
    pr.name, pr.slug,
    COALESCE(NULLIF(split_part(btrim(u.full_name), ' ', 1), ''), 'Customer')
  FROM reviews r
  JOIN products pr ON pr.id = r.product_id
  LEFT JOIN profiles u ON u.id = r.user_id
  WHERE pr.vendor_id = p_vendor_id AND r.is_approved
  ORDER BY r.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
$$;

GRANT EXECUTE ON FUNCTION public.list_shops(TEXT, INTEGER, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shop(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shop_reviews(UUID, INTEGER) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  last_sender_id UUID,
  customer_last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  vendor_last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, vendor_id),
  CHECK (customer_id <> vendor_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_vendor ON public.conversations(vendor_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON public.conversations(customer_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(conversation_id, created_at);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view their conversations"
ON public.conversations FOR SELECT
USING (auth.uid() = customer_id OR auth.uid() = vendor_id);

CREATE POLICY "Participants can view messages"
ON public.messages FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = conversation_id AND auth.uid() IN (c.customer_id, c.vendor_id)
));

CREATE POLICY "Participants can send messages"
ON public.messages FOR INSERT
WITH CHECK (
  sender_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id AND auth.uid() IN (c.customer_id, c.vendor_id)
  )
);

-- Keep the conversation summary current and notify the other side once per
-- unread streak (not on every message).
CREATE OR REPLACE FUNCTION public.on_message_sent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations%ROWTYPE;
  v_recipient UUID;
  v_recipient_read_at TIMESTAMPTZ;
  v_sender_name TEXT;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = NEW.conversation_id FOR UPDATE;

  IF NEW.sender_id = v_conv.customer_id THEN
    v_recipient := v_conv.vendor_id;
    v_recipient_read_at := v_conv.vendor_last_read_at;
  ELSE
    v_recipient := v_conv.customer_id;
    v_recipient_read_at := v_conv.customer_last_read_at;
  END IF;

  UPDATE public.conversations
  SET last_message_at = NEW.created_at,
      last_message_preview = left(btrim(NEW.body), 140),
      last_sender_id = NEW.sender_id,
      customer_last_read_at = CASE WHEN NEW.sender_id = customer_id THEN NEW.created_at ELSE customer_last_read_at END,
      vendor_last_read_at = CASE WHEN NEW.sender_id = vendor_id THEN NEW.created_at ELSE vendor_last_read_at END
  WHERE id = NEW.conversation_id;

  IF v_conv.last_message_at IS NULL
    OR v_conv.last_sender_id = v_recipient
    OR v_recipient_read_at >= v_conv.last_message_at
  THEN
    IF NEW.sender_id = v_conv.vendor_id THEN
      SELECT store_name INTO v_sender_name FROM public.profiles WHERE id = NEW.sender_id;
    ELSE
      SELECT NULLIF(split_part(btrim(full_name), ' ', 1), '') INTO v_sender_name FROM public.profiles WHERE id = NEW.sender_id;
    END IF;

    INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
    VALUES (
      v_recipient,
      format('New message from %s', COALESCE(v_sender_name, 'a customer')),
      left(btrim(NEW.body), 140),
      'info', 'message',
      '/messages/' || NEW.conversation_id,
      jsonb_build_object('conversation_id', NEW.conversation_id)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_message_sent ON public.messages;
CREATE TRIGGER on_message_sent
AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.on_message_sent();

-- Open (or reuse) the customer's conversation with a shop.
CREATE OR REPLACE FUNCTION public.start_conversation(p_vendor_id UUID, p_product_id UUID DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in to chat with sellers';
  END IF;

  IF v_uid = p_vendor_id THEN
    RAISE EXCEPTION 'You cannot message your own shop';
  END IF;

  IF NOT public.has_role(p_vendor_id, 'vendor') THEN
    RAISE EXCEPTION 'Shop not found';
  END IF;

  IF p_product_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.products WHERE id = p_product_id AND vendor_id = p_vendor_id
  ) THEN
    p_product_id := NULL;
  END IF;

  INSERT INTO public.conversations (customer_id, vendor_id, product_id)
  VALUES (v_uid, p_vendor_id, p_product_id)
  ON CONFLICT (customer_id, vendor_id)
  DO UPDATE SET product_id = COALESCE(EXCLUDED.product_id, public.conversations.product_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_conversation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
  SET customer_last_read_at = CASE WHEN customer_id = auth.uid() THEN now() ELSE customer_last_read_at END,
      vendor_last_read_at = CASE WHEN vendor_id = auth.uid() THEN now() ELSE vendor_last_read_at END
  WHERE id = p_conversation_id AND auth.uid() IN (customer_id, vendor_id);
END;
$$;

-- Inbox rows with the other person's display name (customers' profiles are
-- otherwise private, so vendors only see a first name).
CREATE OR REPLACE FUNCTION public.list_my_conversations(p_conversation_id UUID DEFAULT NULL)
RETURNS TABLE (
  id UUID,
  role TEXT,
  other_party_id UUID,
  other_party_name TEXT,
  other_party_avatar TEXT,
  shop_slug TEXT,
  product_id UUID,
  product_name TEXT,
  product_slug TEXT,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  unread BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    CASE WHEN c.customer_id = auth.uid() THEN 'customer' ELSE 'vendor' END,
    CASE WHEN c.customer_id = auth.uid() THEN c.vendor_id ELSE c.customer_id END,
    CASE WHEN c.customer_id = auth.uid()
      THEN COALESCE(v.store_name, 'Shop')
      ELSE COALESCE(NULLIF(split_part(btrim(cu.full_name), ' ', 1), ''), 'Customer')
    END,
    CASE WHEN c.customer_id = auth.uid() THEN v.avatar_url ELSE cu.avatar_url END,
    v.store_slug,
    c.product_id,
    pr.name,
    pr.slug,
    c.last_message_at,
    c.last_message_preview,
    c.last_message_at IS NOT NULL
      AND c.last_sender_id IS DISTINCT FROM auth.uid()
      AND c.last_message_at > CASE WHEN c.customer_id = auth.uid() THEN c.customer_last_read_at ELSE c.vendor_last_read_at END
  FROM conversations c
  JOIN profiles v ON v.id = c.vendor_id
  LEFT JOIN profiles cu ON cu.id = c.customer_id
  LEFT JOIN products pr ON pr.id = c.product_id
  WHERE auth.uid() IN (c.customer_id, c.vendor_id)
    AND (p_conversation_id IS NULL OR c.id = p_conversation_id)
    AND (p_conversation_id IS NOT NULL OR c.last_message_at IS NOT NULL)
  ORDER BY c.last_message_at DESC NULLS LAST
$$;

REVOKE ALL ON FUNCTION public.start_conversation(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_conversation_read(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_my_conversations(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_conversation(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_conversations(UUID) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
