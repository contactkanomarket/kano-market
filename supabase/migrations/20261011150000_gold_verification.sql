-- Two verification levels:
--   blue  = verified seller (existing paid verification)
--   gold  = top-tier seller: a verified (blue) seller pays a higher fee, an admin
--           reviews and approves. Gold shops and their products are listed first.
-- profiles.verification_tier is only set while is_verified is true; turning
-- verification off (revoke or expiry) clears it.

-- ---------------------------------------------------------------------------
-- Settings and state
-- ---------------------------------------------------------------------------
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS gold_verification_fee NUMERIC(12, 2) NOT NULL DEFAULT 25000 CHECK (gold_verification_fee >= 0);

ALTER TABLE public.vendor_verification_requests
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'blue' CHECK (tier IN ('blue', 'gold'));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verification_tier TEXT CHECK (verification_tier IN ('blue', 'gold'));

-- Listing order: 2 = gold, 1 = blue, 0 = not verified. Kept in sync by triggers.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS vendor_rank SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_products_vendor_rank ON public.products(vendor_rank DESC, created_at DESC) WHERE is_active;

-- ---------------------------------------------------------------------------
-- Keep the tier consistent with is_verified
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_verification_tier()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT COALESCE(NEW.is_verified, false) THEN
    NEW.verification_tier := NULL;
  ELSIF NEW.verification_tier IS NULL THEN
    NEW.verification_tier := 'blue';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_verification_tier
BEFORE INSERT OR UPDATE OF is_verified, verification_tier ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_verification_tier();

UPDATE public.profiles SET verification_tier = 'blue' WHERE is_verified AND verification_tier IS NULL;

-- Clients may not change paid-for fields (now including the tier).
CREATE OR REPLACE FUNCTION public.guard_profile_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_client_request() AND NOT public.has_role(auth.uid(), 'admin') AND (
    NEW.is_verified IS DISTINCT FROM OLD.is_verified
    OR NEW.verified_until IS DISTINCT FROM OLD.verified_until
    OR NEW.verification_tier IS DISTINCT FROM OLD.verification_tier
    OR NEW.shop_featured_until IS DISTINCT FROM OLD.shop_featured_until
  ) THEN
    RAISE EXCEPTION 'Only admins can change verification or featured status';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Product listing rank
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vendor_rank_for(p_vendor_id UUID)
RETURNS SMALLINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT CASE p.verification_tier WHEN 'gold' THEN 2 WHEN 'blue' THEN 1 ELSE 0 END
    FROM public.profiles p
    WHERE p.id = p_vendor_id AND p.is_verified
  ), 0)::SMALLINT;
$$;

-- Always computed, so a seller cannot set their own rank.
CREATE OR REPLACE FUNCTION public.set_product_vendor_rank()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.vendor_rank := public.vendor_rank_for(NEW.vendor_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_product_vendor_rank
BEFORE INSERT OR UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.set_product_vendor_rank();

CREATE OR REPLACE FUNCTION public.refresh_vendor_product_rank()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.products
  SET vendor_rank = public.vendor_rank_for(NEW.id)
  WHERE vendor_id = NEW.id
    AND vendor_rank IS DISTINCT FROM public.vendor_rank_for(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER refresh_vendor_product_rank
AFTER UPDATE OF is_verified, verification_tier ON public.profiles
FOR EACH ROW
WHEN (OLD.is_verified IS DISTINCT FROM NEW.is_verified OR OLD.verification_tier IS DISTINCT FROM NEW.verification_tier)
EXECUTE FUNCTION public.refresh_vendor_product_rank();

UPDATE public.products pr SET vendor_rank = public.vendor_rank_for(pr.vendor_id)
WHERE pr.vendor_rank IS DISTINCT FROM public.vendor_rank_for(pr.vendor_id);

-- ---------------------------------------------------------------------------
-- Shops: expose the tier and list gold first
-- ---------------------------------------------------------------------------
ALTER TYPE public.shop_summary ADD ATTRIBUTE verification_tier TEXT;

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
      WHERE pr.vendor_id = p.id AND r.is_approved),
    CASE WHEN p.is_verified THEN p.verification_tier END
  FROM profiles p
  WHERE p.store_name IS NOT NULL
    AND public.has_role(p.id, 'vendor')
$$;

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
  ORDER BY (s.verification_tier = 'gold') DESC NULLS LAST, s.is_verified DESC,
           s.follower_count DESC, s.items_sold DESC, s.product_count DESC, s.store_name
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0)
$$;

-- Homepage logo strip, with the tier (featured_shops is kept for older app versions).
CREATE OR REPLACE FUNCTION public.featured_shop_strip(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, store_name TEXT, store_slug TEXT, avatar_url TEXT, verification_tier TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.store_name, p.store_slug, p.avatar_url, COALESCE(p.verification_tier, 'blue')
  FROM public.profiles p
  WHERE p.shop_featured_until > now()
    AND public.vendor_is_verified(p.id)
    AND p.store_name IS NOT NULL
    AND p.avatar_url IS NOT NULL AND p.avatar_url <> ''
  ORDER BY (p.verification_tier = 'gold') DESC NULLS LAST, p.shop_featured_until DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

GRANT EXECUTE ON FUNCTION public.featured_shop_strip(INTEGER) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Gold application
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_gold_verification(
  p_business_name TEXT,
  p_contact_phone TEXT,
  p_business_address TEXT,
  p_id_type TEXT,
  p_id_number TEXT,
  p_id_document_path TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_fee NUMERIC;
  v_tier TEXT;
  v_req public.vendor_verification_requests%ROWTYPE;
  v_paid BOOLEAN;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'vendor') THEN
    RAISE EXCEPTION 'Only sellers can apply for gold';
  END IF;
  IF NOT public.vendor_is_verified(v_uid) THEN
    RAISE EXCEPTION 'Get the blue verified badge first, then upgrade to gold';
  END IF;

  SELECT verification_tier INTO v_tier FROM public.profiles WHERE id = v_uid;
  IF v_tier = 'gold' THEN
    RAISE EXCEPTION 'Your shop is already gold';
  END IF;

  SELECT gold_verification_fee INTO v_fee FROM public.platform_settings WHERE id = 1;

  SELECT * INTO v_req FROM public.vendor_verification_requests
  WHERE vendor_id = v_uid AND status IN ('awaiting_payment', 'pending_review', 'rejected')
  FOR UPDATE;

  IF FOUND AND v_req.status = 'pending_review' THEN
    RAISE EXCEPTION 'Your details are already being reviewed';
  END IF;
  IF FOUND AND v_req.tier = 'blue' AND v_req.paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'You have an earlier paid request open. Please contact support.';
  END IF;

  IF FOUND THEN
    -- A paid gold request keeps its payment; an unpaid (or old blue) one is re-priced.
    v_paid := v_req.tier = 'gold' AND v_req.paid_at IS NOT NULL;
    UPDATE public.vendor_verification_requests SET
      tier = 'gold',
      business_name = btrim(p_business_name),
      contact_phone = btrim(p_contact_phone),
      business_address = btrim(p_business_address),
      id_type = p_id_type,
      id_number = btrim(p_id_number),
      id_document_path = COALESCE(p_id_document_path, id_document_path),
      notes = NULLIF(btrim(p_notes), ''),
      status = CASE WHEN v_paid OR v_fee = 0 THEN 'pending_review' ELSE 'awaiting_payment' END,
      amount = CASE WHEN v_paid THEN amount ELSE v_fee END,
      paid_at = CASE WHEN v_paid THEN paid_at WHEN v_fee = 0 THEN now() END,
      payment_reference = CASE WHEN v_paid THEN payment_reference END,
      admin_note = NULL
    WHERE id = v_req.id
    RETURNING * INTO v_req;
  ELSE
    INSERT INTO public.vendor_verification_requests (
      vendor_id, tier, business_name, contact_phone, business_address,
      id_type, id_number, id_document_path, notes, amount, status, paid_at
    ) VALUES (
      v_uid, 'gold', btrim(p_business_name), btrim(p_contact_phone), btrim(p_business_address),
      p_id_type, btrim(p_id_number), p_id_document_path, NULLIF(btrim(p_notes), ''), v_fee,
      CASE WHEN v_fee = 0 THEN 'pending_review' ELSE 'awaiting_payment' END,
      CASE WHEN v_fee = 0 THEN now() END
    )
    RETURNING * INTO v_req;
  END IF;

  RETURN jsonb_build_object(
    'request_id', v_req.id,
    'status', v_req.status,
    'needs_payment', v_req.status = 'awaiting_payment',
    'amount', v_req.amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_gold_verification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_gold_verification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- Admin review now understands both levels.
CREATE OR REPLACE FUNCTION public.admin_review_verification(
  p_request_id UUID,
  p_approve BOOLEAN,
  p_note TEXT DEFAULT NULL
)
RETURNS public.vendor_verification_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req public.vendor_verification_requests%ROWTYPE;
  v_period INTEGER;
  v_gold BOOLEAN;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only admins can review verification requests';
  END IF;

  SELECT * INTO v_req FROM public.vendor_verification_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF v_req.status <> 'pending_review' THEN
    RAISE EXCEPTION 'This request is not waiting for review';
  END IF;
  IF NOT p_approve AND (p_note IS NULL OR btrim(p_note) = '') THEN
    RAISE EXCEPTION 'Tell the seller what to fix';
  END IF;

  v_gold := v_req.tier = 'gold';

  UPDATE public.vendor_verification_requests SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    admin_note = NULLIF(btrim(p_note), ''),
    reviewed_by = auth.uid(),
    reviewed_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  IF p_approve THEN
    SELECT verification_period_days INTO v_period FROM public.platform_settings WHERE id = 1;
    UPDATE public.profiles SET
      is_verified = true,
      verification_tier = CASE WHEN v_gold THEN 'gold' ELSE COALESCE(verification_tier, 'blue') END,
      verified_until = CASE WHEN v_period IS NULL THEN NULL ELSE now() + make_interval(days => v_period) END
    WHERE id = v_req.vendor_id;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url)
  VALUES (
    v_req.vendor_id,
    CASE
      WHEN p_approve AND v_gold THEN 'Your shop is now gold'
      WHEN p_approve THEN 'Your shop is verified'
      WHEN v_gold THEN 'Gold upgrade needs changes'
      ELSE 'Verification needs changes' END,
    CASE
      WHEN p_approve AND v_gold THEN 'Your gold badge is live, and your shop and products now show first.'
      WHEN p_approve THEN 'Your verified badge is now live. You can also promote your products and shop on the homepage.'
      ELSE 'Please update your details: ' || btrim(p_note) END,
    CASE WHEN p_approve THEN 'success' ELSE 'warning' END,
    'system',
    '/vendor/verification'
  );

  RETURN v_req;
END;
$$;

-- Admin alert names the level that was paid for.
CREATE OR REPLACE FUNCTION public.confirm_fee_payment(p_reference TEXT, p_amount_kobo BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ver public.vendor_verification_requests%ROWTYPE;
  v_feat public.featured_placements%ROWTYPE;
BEGIN
  SELECT * INTO v_ver FROM public.vendor_verification_requests WHERE payment_reference = p_reference FOR UPDATE;
  IF FOUND THEN
    IF v_ver.paid_at IS NOT NULL THEN
      RETURN 'already_applied';
    END IF;
    IF p_amount_kobo < round(v_ver.amount * 100) THEN
      RAISE EXCEPTION 'Amount paid does not match the verification fee';
    END IF;
    UPDATE public.vendor_verification_requests
    SET paid_at = now(), status = 'pending_review'
    WHERE id = v_ver.id;

    INSERT INTO public.notifications (user_id, title, message, type, category, action_url)
    SELECT ur.user_id,
           CASE WHEN v_ver.tier = 'gold' THEN 'New gold upgrade request' ELSE 'New verification request' END,
           format('%s paid for %s and is waiting for review.', v_ver.business_name,
                  CASE WHEN v_ver.tier = 'gold' THEN 'the gold badge' ELSE 'verification' END),
           'info', 'system', '/admin/vendors'
    FROM public.user_roles ur WHERE ur.role = 'admin';
    RETURN 'applied';
  END IF;

  SELECT * INTO v_feat FROM public.featured_placements WHERE payment_reference = p_reference FOR UPDATE;
  IF FOUND THEN
    IF v_feat.paid_at IS NOT NULL OR v_feat.status <> 'awaiting_payment' THEN
      RETURN 'already_applied';
    END IF;
    IF p_amount_kobo < round(v_feat.amount * 100) THEN
      RAISE EXCEPTION 'Amount paid does not match the featured placement price';
    END IF;
    PERFORM public.activate_featured_placement(v_feat.id);
    RETURN 'applied';
  END IF;

  RAISE EXCEPTION 'No fee payment with this reference';
END;
$$;

-- Live search reads shops through this view; add the tier (new column at the end).
CREATE OR REPLACE VIEW public.public_vendor_profiles
WITH (security_invoker = true) AS
SELECT id, full_name, avatar_url, is_verified, store_name, store_slug,
       store_banner_url, store_description, store_address,
       CASE WHEN is_verified THEN verification_tier END AS verification_tier
FROM public.profiles
WHERE store_name IS NOT NULL;
