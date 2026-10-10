-- Vendor monetisation:
--   1. Paid verification: the vendor pays a fee and submits their details, an
--      admin reviews them and approves (badge on) or rejects (vendor can fix and
--      resubmit without paying again).
--   2. Paid featured placement for verified vendors:
--        - a product in the homepage image carousel, for N weeks
--        - the shop's logo in the homepage logo strip, for N weeks
-- Fees and durations live in platform_settings so admins can change them.
-- Money only moves through Paystack; payments are confirmed by trusted code
-- (edge functions with the service role) via confirm_fee_payment().

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS verification_fee NUMERIC(12, 2) NOT NULL DEFAULT 5000 CHECK (verification_fee >= 0),
  -- NULL = verification never expires (one-time fee). Set e.g. 30 for monthly.
  ADD COLUMN IF NOT EXISTS verification_period_days INTEGER CHECK (verification_period_days IS NULL OR verification_period_days BETWEEN 1 AND 3660),
  ADD COLUMN IF NOT EXISTS featured_product_weekly_fee NUMERIC(12, 2) NOT NULL DEFAULT 2000 CHECK (featured_product_weekly_fee >= 0),
  ADD COLUMN IF NOT EXISTS featured_shop_weekly_fee NUMERIC(12, 2) NOT NULL DEFAULT 5000 CHECK (featured_shop_weekly_fee >= 0),
  ADD COLUMN IF NOT EXISTS featured_max_weeks INTEGER NOT NULL DEFAULT 8 CHECK (featured_max_weeks BETWEEN 1 AND 52);

-- ---------------------------------------------------------------------------
-- Profile / product state
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS verified_until TIMESTAMPTZ,        -- NULL with is_verified = no expiry
  ADD COLUMN IF NOT EXISTS shop_featured_until TIMESTAMPTZ;   -- logo strip on the homepage

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS featured_until TIMESTAMPTZ;        -- NULL with featured = admin pick, no expiry

-- True when the vendor's badge is on and has not run out.
CREATE OR REPLACE FUNCTION public.vendor_is_verified(p_vendor_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_vendor_id
      AND is_verified
      AND (verified_until IS NULL OR verified_until > now())
  );
$$;

GRANT EXECUTE ON FUNCTION public.vendor_is_verified(UUID) TO anon, authenticated;

-- Clients may not change paid-for fields. (Not SECURITY DEFINER on purpose:
-- is_client_request() must see the real caller.)
CREATE OR REPLACE FUNCTION public.guard_profile_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_client_request() AND NOT public.has_role(auth.uid(), 'admin') AND (
    NEW.is_verified IS DISTINCT FROM OLD.is_verified
    OR NEW.verified_until IS DISTINCT FROM OLD.verified_until
    OR NEW.shop_featured_until IS DISTINCT FROM OLD.shop_featured_until
  ) THEN
    RAISE EXCEPTION 'Only admins can change verification or featured status';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_product_featured()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_client_request() AND NOT public.has_role(auth.uid(), 'admin') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.featured := false;
      NEW.featured_until := NULL;
    ELSIF (NEW.featured AND NOT OLD.featured)
       OR NEW.featured_until IS DISTINCT FROM OLD.featured_until THEN
      RAISE EXCEPTION 'Featured placement must be purchased';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Verification requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment', 'pending_review', 'approved', 'rejected')),
  business_name TEXT NOT NULL CHECK (char_length(btrim(business_name)) BETWEEN 2 AND 120),
  contact_phone TEXT NOT NULL CHECK (char_length(btrim(contact_phone)) BETWEEN 7 AND 20),
  business_address TEXT NOT NULL CHECK (char_length(btrim(business_address)) BETWEEN 5 AND 300),
  id_type TEXT NOT NULL CHECK (id_type IN ('nin', 'drivers_licence', 'voters_card', 'passport', 'cac')),
  id_number TEXT NOT NULL CHECK (char_length(btrim(id_number)) BETWEEN 4 AND 40),
  id_document_path TEXT CHECK (id_document_path IS NULL OR id_document_path LIKE vendor_id::text || '/%'),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 1000),
  amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_reference TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  admin_note TEXT,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open request per vendor (approved ones stay as history).
CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_one_open
ON public.vendor_verification_requests(vendor_id)
WHERE status IN ('awaiting_payment', 'pending_review', 'rejected');

CREATE INDEX IF NOT EXISTS idx_verification_status ON public.vendor_verification_requests(status, created_at);

ALTER TABLE public.vendor_verification_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Vendors can view their verification requests"
ON public.vendor_verification_requests FOR SELECT
USING (vendor_id = auth.uid());

CREATE POLICY "Admins can view verification requests"
ON public.vendor_verification_requests FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_vendor_verification_requests_updated_at
BEFORE UPDATE ON public.vendor_verification_requests
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Private bucket for ID documents: <vendor_id>/<file>, readable by the vendor and admins.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('verification-docs', 'verification-docs', false, 5242880,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Vendors can upload their verification documents"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'verification-docs' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Vendors and admins can view verification documents"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'verification-docs'
  AND ((storage.foldername(name))[1] = auth.uid()::text OR public.has_role(auth.uid(), 'admin'))
);

-- Vendor submits (or resubmits) their details.
-- Returns the request and whether a payment is still needed.
CREATE OR REPLACE FUNCTION public.submit_verification(
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
  v_req public.vendor_verification_requests%ROWTYPE;
  v_paid BOOLEAN;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'vendor') THEN
    RAISE EXCEPTION 'Only sellers can apply for verification';
  END IF;

  IF public.vendor_is_verified(v_uid) THEN
    RAISE EXCEPTION 'Your shop is already verified';
  END IF;

  SELECT verification_fee INTO v_fee FROM public.platform_settings WHERE id = 1;

  SELECT * INTO v_req FROM public.vendor_verification_requests
  WHERE vendor_id = v_uid AND status IN ('awaiting_payment', 'pending_review', 'rejected')
  FOR UPDATE;

  IF FOUND AND v_req.status = 'pending_review' THEN
    RAISE EXCEPTION 'Your details are already being reviewed';
  END IF;

  IF FOUND THEN
    v_paid := v_req.paid_at IS NOT NULL;
    UPDATE public.vendor_verification_requests SET
      business_name = btrim(p_business_name),
      contact_phone = btrim(p_contact_phone),
      business_address = btrim(p_business_address),
      id_type = p_id_type,
      id_number = btrim(p_id_number),
      id_document_path = COALESCE(p_id_document_path, id_document_path),
      notes = NULLIF(btrim(p_notes), ''),
      status = CASE WHEN v_paid OR v_fee = 0 THEN 'pending_review' ELSE 'awaiting_payment' END,
      amount = CASE WHEN v_paid THEN amount ELSE v_fee END,
      paid_at = CASE WHEN NOT v_paid AND v_fee = 0 THEN now() ELSE paid_at END,
      admin_note = NULL
    WHERE id = v_req.id
    RETURNING * INTO v_req;
  ELSE
    INSERT INTO public.vendor_verification_requests (
      vendor_id, business_name, contact_phone, business_address,
      id_type, id_number, id_document_path, notes, amount, status, paid_at
    ) VALUES (
      v_uid, btrim(p_business_name), btrim(p_contact_phone), btrim(p_business_address),
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

REVOKE ALL ON FUNCTION public.submit_verification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_verification(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- Admin approves or rejects a paid request.
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
      verified_until = CASE WHEN v_period IS NULL THEN NULL ELSE now() + make_interval(days => v_period) END
    WHERE id = v_req.vendor_id;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url)
  VALUES (
    v_req.vendor_id,
    CASE WHEN p_approve THEN 'Your shop is verified' ELSE 'Verification needs changes' END,
    CASE WHEN p_approve
      THEN 'Your verified badge is now live. You can also promote your products and shop on the homepage.'
      ELSE 'Please update your details: ' || btrim(p_note) END,
    CASE WHEN p_approve THEN 'success' ELSE 'warning' END,
    'system',
    '/vendor/verification'
  );

  RETURN v_req;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_review_verification(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_verification(UUID, BOOLEAN, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Featured placements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.featured_placements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'shop')),
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  weeks INTEGER NOT NULL CHECK (weeks BETWEEN 1 AND 52),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment', 'active', 'expired', 'cancelled')),
  payment_reference TEXT UNIQUE,
  paid_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'product') = (product_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_featured_placements_vendor ON public.featured_placements(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_featured_placements_active ON public.featured_placements(status, ends_at);

ALTER TABLE public.featured_placements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Vendors can view their featured placements"
ON public.featured_placements FOR SELECT
USING (vendor_id = auth.uid());

CREATE POLICY "Admins can view featured placements"
ON public.featured_placements FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));

-- Vendor starts a placement; payment is collected by the vendor-fees function.
CREATE OR REPLACE FUNCTION public.request_featured_placement(
  p_kind TEXT,
  p_weeks INTEGER,
  p_product_id UUID DEFAULT NULL
)
RETURNS public.featured_placements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_settings public.platform_settings%ROWTYPE;
  v_row public.featured_placements%ROWTYPE;
  v_amount NUMERIC;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'vendor') THEN
    RAISE EXCEPTION 'Only sellers can buy featured placement';
  END IF;
  IF NOT public.vendor_is_verified(v_uid) THEN
    RAISE EXCEPTION 'Get your shop verified first to be featured on the homepage';
  END IF;

  SELECT * INTO v_settings FROM public.platform_settings WHERE id = 1;

  IF p_kind NOT IN ('product', 'shop') THEN
    RAISE EXCEPTION 'Choose a product or your shop';
  END IF;
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > v_settings.featured_max_weeks THEN
    RAISE EXCEPTION 'Choose between 1 and % weeks', v_settings.featured_max_weeks;
  END IF;

  IF p_kind = 'product' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.products WHERE id = p_product_id AND vendor_id = v_uid AND is_active
    ) THEN
      RAISE EXCEPTION 'Choose one of your published products';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.product_images WHERE product_id = p_product_id) THEN
      RAISE EXCEPTION 'Add a photo to this product first; the homepage carousel shows its picture';
    END IF;
    v_amount := v_settings.featured_product_weekly_fee * p_weeks;
  ELSE
    p_product_id := NULL;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND avatar_url IS NOT NULL AND avatar_url <> '') THEN
      RAISE EXCEPTION 'Add a shop logo first (Settings → Shop branding); the homepage strip shows your logo';
    END IF;
    v_amount := v_settings.featured_shop_weekly_fee * p_weeks;
  END IF;

  -- Cancel earlier unpaid attempts for the same thing so the vendor's list stays clean.
  UPDATE public.featured_placements SET status = 'cancelled'
  WHERE vendor_id = v_uid AND status = 'awaiting_payment' AND kind = p_kind
    AND product_id IS NOT DISTINCT FROM p_product_id;

  INSERT INTO public.featured_placements (vendor_id, kind, product_id, weeks, amount)
  VALUES (v_uid, p_kind, p_product_id, p_weeks, v_amount)
  RETURNING * INTO v_row;

  -- Free promotions (fee set to 0 by an admin) start straight away.
  IF v_amount = 0 THEN
    PERFORM public.activate_featured_placement(v_row.id);
    SELECT * INTO v_row FROM public.featured_placements WHERE id = v_row.id;
  END IF;

  RETURN v_row;
END;
$$;

-- Starts (or extends) a paid placement. Trusted callers only.
CREATE OR REPLACE FUNCTION public.activate_featured_placement(p_placement_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.featured_placements%ROWTYPE;
  v_start TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_row FROM public.featured_placements WHERE id = p_placement_id FOR UPDATE;
  IF NOT FOUND OR v_row.status <> 'awaiting_payment' THEN
    RETURN;
  END IF;

  -- Back-to-back purchases queue up instead of overlapping.
  IF v_row.kind = 'product' THEN
    SELECT GREATEST(now(), COALESCE(featured_until, now())) INTO v_start
    FROM public.products WHERE id = v_row.product_id;
  ELSE
    SELECT GREATEST(now(), COALESCE(shop_featured_until, now())) INTO v_start
    FROM public.profiles WHERE id = v_row.vendor_id;
  END IF;

  UPDATE public.featured_placements SET
    status = 'active',
    paid_at = COALESCE(paid_at, now()),
    starts_at = v_start,
    ends_at = v_start + make_interval(days => 7 * v_row.weeks)
  WHERE id = p_placement_id
  RETURNING * INTO v_row;

  IF v_row.kind = 'product' THEN
    -- An admin pick without an end date stays without one.
    UPDATE public.products SET
      featured = true,
      featured_until = CASE WHEN featured AND featured_until IS NULL THEN NULL ELSE v_row.ends_at END
    WHERE id = v_row.product_id;
  ELSE
    UPDATE public.profiles SET shop_featured_until = v_row.ends_at WHERE id = v_row.vendor_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_featured_placement(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_featured_placement(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.request_featured_placement(TEXT, INTEGER, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_featured_placement(TEXT, INTEGER, UUID) TO authenticated;

-- Ends placements whose time is up. Run hourly (process-payouts calls it).
CREATE OR REPLACE FUNCTION public.expire_featured_placements()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.featured_placements SET status = 'expired'
  WHERE status = 'active' AND ends_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.products SET featured = false, featured_until = NULL
  WHERE featured AND featured_until IS NOT NULL AND featured_until <= now();

  UPDATE public.profiles SET shop_featured_until = NULL
  WHERE shop_featured_until IS NOT NULL AND shop_featured_until <= now();

  UPDATE public.profiles SET is_verified = false
  WHERE is_verified AND verified_until IS NOT NULL AND verified_until <= now();

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_featured_placements() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_featured_placements() TO service_role;

-- ---------------------------------------------------------------------------
-- Payment confirmation (service role only), shared by verify + webhook.
-- Returns 'applied', 'already_applied', or raises.
-- ---------------------------------------------------------------------------
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
    SELECT ur.user_id, 'New verification request',
           format('%s paid for verification and is waiting for review.', v_ver.business_name),
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

REVOKE ALL ON FUNCTION public.confirm_fee_payment(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_fee_payment(TEXT, BIGINT) TO service_role;

-- ---------------------------------------------------------------------------
-- Homepage feeds
-- ---------------------------------------------------------------------------
-- Logo strip: verified shops with an active shop placement.
CREATE OR REPLACE FUNCTION public.featured_shops(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, store_name TEXT, store_slug TEXT, avatar_url TEXT, is_verified BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.store_name, p.store_slug, p.avatar_url, true
  FROM public.profiles p
  WHERE p.shop_featured_until > now()
    AND public.vendor_is_verified(p.id)
    AND p.store_name IS NOT NULL
    AND p.avatar_url IS NOT NULL AND p.avatar_url <> ''
  ORDER BY p.shop_featured_until DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

GRANT EXECUTE ON FUNCTION public.featured_shops(INTEGER) TO anon, authenticated;
