-- Secure order/payment data and add two-part vendor payouts.
--
-- Money flow:
--   1. Customer pays the platform (Paystack).
--   2. For each vendor in the order: commission is taken, the remainder is split
--      into two payouts. Tranche 1 is sent as soon as payment is confirmed.
--   3. Tranche 2 is sent when the customer confirms delivery, or automatically
--      `auto_release_days` after the order ships, unless a dispute is open.
--
-- All money-related columns can only be changed by trusted code (edge functions
-- using the service role, or the SECURITY DEFINER functions below).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- True when the current statement comes straight from a browser client
-- (PostgREST as anon/authenticated). Service-role edge functions and
-- SECURITY DEFINER functions run as other roles and are trusted, so the
-- guard triggers below must NOT be SECURITY DEFINER themselves.
CREATE OR REPLACE FUNCTION public.is_client_request()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_user IN ('anon', 'authenticated')
$$;

-- ---------------------------------------------------------------------------
-- Signup: never let a user pick the admin role
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', '')
  );

  INSERT INTO public.user_roles (user_id, role)
  VALUES (
    NEW.id,
    CASE WHEN NEW.raw_user_meta_data ->> 'role' = 'vendor' THEN 'vendor'::app_role
         ELSE 'customer'::app_role
    END
  );

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Platform settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.platform_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  commission_percent NUMERIC(5, 2) NOT NULL DEFAULT 10 CHECK (commission_percent >= 0 AND commission_percent <= 100),
  auto_release_days INTEGER NOT NULL DEFAULT 7 CHECK (auto_release_days BETWEEN 1 AND 60),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform settings are viewable by everyone"
ON public.platform_settings FOR SELECT
USING (true);

CREATE POLICY "Admins can update platform settings"
ON public.platform_settings FOR UPDATE
USING (has_role(auth.uid(), 'admin'))
WITH CHECK (has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_platform_settings_updated_at
BEFORE UPDATE ON public.platform_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------------------
-- Vendor bank accounts (private; written only by the vendor-payout-account
-- edge function after Paystack resolves the account)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vendor_payout_accounts (
  vendor_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  bank_code TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  recipient_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_payout_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Vendors can view their own payout account"
ON public.vendor_payout_accounts FOR SELECT
USING (vendor_id = auth.uid());

CREATE POLICY "Admins can view all payout accounts"
ON public.vendor_payout_accounts FOR SELECT
USING (has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_vendor_payout_accounts_updated_at
BEFORE UPDATE ON public.vendor_payout_accounts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------------------
-- Payouts
-- ---------------------------------------------------------------------------
-- status:
--   held       tranche 2 waiting for delivery confirmation / auto-release
--   on_hold    tranche 2 frozen by an open dispute
--   pending    ready to send
--   processing transfer sent to Paystack, waiting for the result
--   paid       money arrived
--   failed     Paystack rejected the transfer (admin can retry)
--   cancelled  will not be paid (e.g. dispute resolved for the customer)

CREATE TABLE IF NOT EXISTS public.payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  vendor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  tranche SMALLINT NOT NULL CHECK (tranche IN (1, 2)),
  gross_amount NUMERIC(12, 2) NOT NULL,
  commission_percent NUMERIC(5, 2) NOT NULL,
  commission_amount NUMERIC(12, 2) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('held', 'on_hold', 'pending', 'processing', 'paid', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  reference TEXT UNIQUE,
  transfer_code TEXT,
  failure_reason TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, vendor_id, tranche)
);

CREATE INDEX IF NOT EXISTS idx_payouts_status ON public.payouts(status);
CREATE INDEX IF NOT EXISTS idx_payouts_vendor ON public.payouts(vendor_id);

ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Vendors can view their own payouts"
ON public.payouts FOR SELECT
USING (vendor_id = auth.uid());

CREATE POLICY "Admins can view all payouts"
ON public.payouts FOR SELECT
USING (has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_payouts_updated_at
BEFORE UPDATE ON public.payouts
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------------------
-- Orders: shipping + dispute tracking
-- ---------------------------------------------------------------------------

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_status TEXT CHECK (dispute_status IN ('open', 'resolved_vendor', 'resolved_customer')),
  ADD COLUMN IF NOT EXISTS dispute_reason TEXT,
  ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_resolved_at TIMESTAMPTZ;

-- Orders and their items are created only through place_order().
DROP POLICY IF EXISTS "Users can create their own orders" ON public.orders;
DROP POLICY IF EXISTS "Users can create order items for their orders" ON public.order_items;

-- Guard order columns against direct edits from the browser.
CREATE OR REPLACE FUNCTION public.guard_order_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_is_admin BOOLEAN;
  v_release_days INTEGER;
BEGIN
  IF public.is_client_request() THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Orders must be placed through checkout';
    END IF;

    v_is_admin := public.has_role(v_uid, 'admin');

    -- Customer cancelling an unpaid order is the only payment_status change allowed.
    IF NOT (
      OLD.user_id = v_uid
      AND OLD.payment_status = 'pending'
      AND NEW.payment_status = 'cancelled'
      AND NEW.status = 'cancelled'
    ) AND NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
      RAISE EXCEPTION 'payment_status cannot be changed directly';
    END IF;

    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
      OR NEW.shipping_fee IS DISTINCT FROM OLD.shipping_fee
      OR NEW.total IS DISTINCT FROM OLD.total
      OR NEW.shipping_address IS DISTINCT FROM OLD.shipping_address
      OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
      OR NEW.escrow_status IS DISTINCT FROM OLD.escrow_status
      OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
      OR NEW.auto_release_at IS DISTINCT FROM OLD.auto_release_at
      OR NEW.shipped_at IS DISTINCT FROM OLD.shipped_at
      OR NEW.dispute_status IS DISTINCT FROM OLD.dispute_status
      OR NEW.dispute_reason IS DISTINCT FROM OLD.dispute_reason
      OR NEW.disputed_at IS DISTINCT FROM OLD.disputed_at
      OR NEW.dispute_resolved_at IS DISTINCT FROM OLD.dispute_resolved_at
    THEN
      RAISE EXCEPTION 'Payment and delivery fields cannot be changed directly';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status AND NOT v_is_admin THEN
      IF OLD.user_id = v_uid AND OLD.payment_status = 'pending' AND NEW.status = 'cancelled' THEN
        NULL; -- customer cancelling an unpaid order
      ELSIF public.is_order_vendor(OLD.id, v_uid)
        AND OLD.payment_status = 'paid'
        AND OLD.status NOT IN ('completed', 'cancelled')
        AND NEW.status IN ('processing', 'ready_for_pickup', 'shipped', 'out_for_delivery', 'delivered')
      THEN
        NULL; -- vendor moving a paid order through fulfilment
      ELSE
        RAISE EXCEPTION 'You cannot change this order to %', NEW.status;
      END IF;
    END IF;
  END IF;

  -- Start the auto-release clock the first time the order leaves the vendor.
  IF TG_OP = 'UPDATE'
    AND OLD.shipped_at IS NULL
    AND NEW.payment_status = 'paid'
    AND NEW.status IN ('shipped', 'out_for_delivery', 'delivered')
  THEN
    SELECT auto_release_days INTO v_release_days FROM public.platform_settings WHERE id = 1;
    NEW.shipped_at := now();
    NEW.auto_release_at := now() + make_interval(days => COALESCE(v_release_days, 7));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_order_changes ON public.orders;
CREATE TRIGGER guard_order_changes
BEFORE INSERT OR UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.guard_order_changes();

-- Order item prices and quantities are fixed once placed.
CREATE OR REPLACE FUNCTION public.guard_order_item_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.is_client_request() THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Order items must be created through checkout';
    END IF;

    IF NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.product_id IS DISTINCT FROM OLD.product_id
      OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
      OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
      OR NEW.quantity IS DISTINCT FROM OLD.quantity
      OR NEW.unit_price IS DISTINCT FROM OLD.unit_price
      OR NEW.total_price IS DISTINCT FROM OLD.total_price
    THEN
      RAISE EXCEPTION 'Order item prices and quantities cannot be changed';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_order_item_changes ON public.order_items;
CREATE TRIGGER guard_order_item_changes
BEFORE INSERT OR UPDATE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.guard_order_item_changes();

-- Featured placement is paid for; vendors cannot switch it on themselves.
CREATE OR REPLACE FUNCTION public.guard_product_featured()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_client_request() AND NOT public.has_role(auth.uid(), 'admin') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.featured := false;
    ELSIF NEW.featured AND NOT OLD.featured THEN
      RAISE EXCEPTION 'Featured placement must be purchased';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_product_featured ON public.products;
CREATE TRIGGER guard_product_featured
BEFORE INSERT OR UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.guard_product_featured();

-- Only admins can verify vendors.
CREATE OR REPLACE FUNCTION public.guard_profile_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_client_request()
    AND NEW.is_verified IS DISTINCT FROM OLD.is_verified
    AND NOT public.has_role(auth.uid(), 'admin')
  THEN
    RAISE EXCEPTION 'Only admins can change verification status';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_verification ON public.profiles;
CREATE TRIGGER guard_profile_verification
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_verification();

-- ---------------------------------------------------------------------------
-- Checkout: price the cart on the server
-- ---------------------------------------------------------------------------
-- Mirrors src/lib/shipping.ts. Keep the two in sync.

CREATE OR REPLACE FUNCTION public.shipping_base_fee(p_distance_km NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_distance_km IS NULL THEN 1500
    WHEN p_distance_km <= 5 THEN 500
    WHEN p_distance_km <= 15 THEN 800
    WHEN p_distance_km <= 30 THEN 1200
    WHEN p_distance_km <= 50 THEN 1800
    WHEN p_distance_km <= 100 THEN 2500
    WHEN p_distance_km <= 200 THEN 3500
    WHEN p_distance_km <= 400 THEN 5000
    ELSE 6500
  END::NUMERIC
$$;

CREATE OR REPLACE FUNCTION public.shipping_value_discount(p_subtotal NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_subtotal >= 500000 THEN 0.70
    WHEN p_subtotal >= 200000 THEN 0.50
    WHEN p_subtotal >= 100000 THEN 0.35
    WHEN p_subtotal >= 50000 THEN 0.20
    ELSE 0
  END::NUMERIC
$$;

CREATE OR REPLACE FUNCTION public.distance_km(lat1 NUMERIC, lon1 NUMERIC, lat2 NUMERIC, lon2 NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (6371 * 2 * atan2(
    sqrt(a),
    sqrt(1 - a)
  ))::NUMERIC
  FROM (
    SELECT
      power(sin(radians((lat2 - lat1)::float8) / 2), 2)
      + cos(radians(lat1::float8)) * cos(radians(lat2::float8))
      * power(sin(radians((lon2 - lon1)::float8) / 2), 2) AS a
  ) s
$$;

CREATE OR REPLACE FUNCTION public.place_order(
  p_address_id UUID,
  p_promo_code TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_address public.delivery_addresses%ROWTYPE;
  v_promo public.shipping_promo_codes%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_item RECORD;
  v_subtotal NUMERIC := 0;
  v_item_count INTEGER := 0;
  v_distance NUMERIC;
  v_base_fee NUMERIC;
  v_shipping_fee NUMERIC;
  v_stock_errors TEXT[] := '{}';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to place an order';
  END IF;

  SELECT * INTO v_address
  FROM public.delivery_addresses
  WHERE id = p_address_id AND user_id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery address not found';
  END IF;

  FOR v_item IN
    SELECT
      c.quantity,
      p.id AS product_id,
      p.name AS product_name,
      p.price,
      p.vendor_id,
      p.is_active,
      p.stock_quantity AS product_stock,
      v.id AS variant_id,
      v.name AS variant_name,
      COALESCE(v.price_adjustment, 0) AS price_adjustment,
      v.stock_quantity AS variant_stock
    FROM public.cart_items c
    JOIN public.products p ON p.id = c.product_id
    LEFT JOIN public.product_variants v ON v.id = c.variant_id
    WHERE c.user_id = v_uid
    FOR UPDATE OF p
  LOOP
    v_item_count := v_item_count + 1;

    IF NOT v_item.is_active THEN
      v_stock_errors := v_stock_errors || format('"%s" is no longer available', v_item.product_name);
    ELSIF v_item.quantity > COALESCE(v_item.variant_stock, v_item.product_stock) THEN
      v_stock_errors := v_stock_errors || format(
        '"%s"%s only has %s in stock, but you requested %s',
        v_item.product_name,
        CASE WHEN v_item.variant_name IS NOT NULL THEN format(' (%s)', v_item.variant_name) ELSE '' END,
        COALESCE(v_item.variant_stock, v_item.product_stock),
        v_item.quantity
      );
    END IF;

    v_subtotal := v_subtotal + (v_item.price + v_item.price_adjustment) * v_item.quantity;
  END LOOP;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'Cart is empty';
  END IF;

  IF array_length(v_stock_errors, 1) > 0 THEN
    RAISE EXCEPTION 'Insufficient stock: %', array_to_string(v_stock_errors, '; ');
  END IF;

  -- Distance to the farthest vendor with known coordinates.
  IF v_address.latitude IS NOT NULL AND v_address.longitude IS NOT NULL THEN
    SELECT max(public.distance_km(
      v_address.latitude, v_address.longitude,
      (pr.store_address ->> 'latitude')::NUMERIC,
      (pr.store_address ->> 'longitude')::NUMERIC
    ))
    INTO v_distance
    FROM public.profiles pr
    WHERE pr.id IN (
      SELECT p.vendor_id FROM public.cart_items c
      JOIN public.products p ON p.id = c.product_id
      WHERE c.user_id = v_uid
    )
    AND (pr.store_address ->> 'latitude') IS NOT NULL
    AND (pr.store_address ->> 'longitude') IS NOT NULL;
  END IF;

  v_base_fee := public.shipping_base_fee(v_distance);

  IF p_promo_code IS NOT NULL AND btrim(p_promo_code) <> '' THEN
    SELECT * INTO v_promo
    FROM public.shipping_promo_codes
    WHERE code = upper(btrim(p_promo_code))
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > now());

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid or expired promo code';
    END IF;

    IF v_promo.discount_type = 'free' THEN
      v_shipping_fee := 0;
    ELSE
      v_shipping_fee := v_base_fee - round(v_base_fee * v_promo.discount_value / 100.0);
    END IF;
  ELSE
    v_shipping_fee := v_base_fee - round(v_base_fee * public.shipping_value_discount(v_subtotal));
  END IF;

  INSERT INTO public.orders (
    user_id, status, payment_status, escrow_status,
    subtotal, shipping_fee, total, shipping_address, notes
  )
  VALUES (
    v_uid, 'pending_payment', 'pending', 'held',
    v_subtotal, v_shipping_fee, v_subtotal + v_shipping_fee,
    jsonb_strip_nulls(jsonb_build_object(
      'full_name', v_address.full_name,
      'phone', v_address.phone,
      'street_address', v_address.street_address,
      'city', v_address.city,
      'state', v_address.state,
      'landmark', v_address.landmark
    )),
    NULLIF(btrim(p_notes), '')
  )
  RETURNING * INTO v_order;

  INSERT INTO public.order_items (
    order_id, product_id, variant_id, vendor_id,
    product_name, variant_name, quantity, unit_price, total_price
  )
  SELECT
    v_order.id, p.id, v.id, p.vendor_id,
    p.name, v.name, c.quantity,
    p.price + COALESCE(v.price_adjustment, 0),
    (p.price + COALESCE(v.price_adjustment, 0)) * c.quantity
  FROM public.cart_items c
  JOIN public.products p ON p.id = c.product_id
  LEFT JOIN public.product_variants v ON v.id = c.variant_id
  WHERE c.user_id = v_uid;

  DELETE FROM public.cart_items WHERE user_id = v_uid;

  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION public.place_order(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_order(UUID, TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Payment confirmation (service role only)
-- ---------------------------------------------------------------------------
-- Marks the order paid if the amount matches, reduces stock and creates the
-- two payouts per vendor. Returns true only for the call that actually
-- marked the order paid, so callers can send notifications exactly once.

CREATE OR REPLACE FUNCTION public.mark_order_paid(
  p_order_id UUID,
  p_reference TEXT,
  p_amount_kobo BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_commission NUMERIC;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.payment_status = 'paid' THEN
    RETURN false;
  END IF;

  IF round(v_order.total * 100) <> p_amount_kobo THEN
    RAISE EXCEPTION 'Amount paid (% kobo) does not match order total (% kobo)',
      p_amount_kobo, round(v_order.total * 100);
  END IF;

  UPDATE public.orders
  SET payment_status = 'paid',
      status = 'payment_confirmed',
      escrow_status = 'held',
      payment_reference = p_reference,
      tracking_updates = COALESCE(tracking_updates, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'status', 'payment_confirmed',
        'message', 'Payment received and held securely',
        'timestamp', now()
      ))
  WHERE id = p_order_id;

  UPDATE public.products p
  SET stock_quantity = GREATEST(0, p.stock_quantity - oi.qty)
  FROM (
    SELECT product_id, sum(quantity) AS qty
    FROM public.order_items WHERE order_id = p_order_id
    GROUP BY product_id
  ) oi
  WHERE p.id = oi.product_id;

  UPDATE public.product_variants v
  SET stock_quantity = GREATEST(0, v.stock_quantity - oi.qty)
  FROM (
    SELECT variant_id, sum(quantity) AS qty
    FROM public.order_items WHERE order_id = p_order_id AND variant_id IS NOT NULL
    GROUP BY variant_id
  ) oi
  WHERE v.id = oi.variant_id;

  SELECT commission_percent INTO v_commission FROM public.platform_settings WHERE id = 1;
  v_commission := COALESCE(v_commission, 0);

  INSERT INTO public.payouts (
    order_id, vendor_id, tranche, gross_amount, commission_percent,
    commission_amount, amount, status
  )
  SELECT
    p_order_id, s.vendor_id, t.tranche, s.gross, v_commission, s.commission,
    CASE WHEN t.tranche = 1 THEN s.first_half ELSE s.net - s.first_half END,
    CASE WHEN t.tranche = 1 THEN 'pending' ELSE 'held' END
  FROM (
    SELECT
      vendor_id,
      gross,
      commission,
      gross - commission AS net,
      floor((gross - commission) * 100 / 2) / 100 AS first_half
    FROM (
      SELECT
        vendor_id,
        sum(total_price) AS gross,
        round(sum(total_price) * v_commission / 100, 2) AS commission
      FROM public.order_items
      WHERE order_id = p_order_id
      GROUP BY vendor_id
    ) g
  ) s
  CROSS JOIN (VALUES (1::SMALLINT), (2::SMALLINT)) AS t(tranche)
  ON CONFLICT (order_id, vendor_id, tranche) DO NOTHING;

  RETURN true;
END;
$$;

-- Release second payouts whose auto-release date has passed.
CREATE OR REPLACE FUNCTION public.release_due_payouts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH due AS (
    SELECT id FROM public.orders
    WHERE payment_status = 'paid'
      AND auto_release_at IS NOT NULL
      AND auto_release_at <= now()
      AND dispute_status IS DISTINCT FROM 'open'
      AND escrow_status = 'held'
    FOR UPDATE
  ), released AS (
    UPDATE public.payouts p
    SET status = 'pending'
    FROM due
    WHERE p.order_id = due.id AND p.tranche = 2 AND p.status = 'held'
    RETURNING p.order_id
  )
  UPDATE public.orders o
  SET escrow_status = 'released',
      status = CASE WHEN o.status IN ('shipped', 'out_for_delivery', 'delivered') THEN 'completed' ELSE o.status END,
      tracking_updates = COALESCE(o.tracking_updates, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'status', 'completed',
        'message', 'Delivery window ended; vendor payment released',
        'timestamp', now()
      ))
  FROM due
  WHERE o.id = due.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_order_paid(UUID, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_due_payouts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(UUID, TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_due_payouts() TO service_role;

-- ---------------------------------------------------------------------------
-- Customer actions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.confirm_order_delivery(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'This order has not been paid';
  END IF;

  IF v_order.dispute_status = 'open' THEN
    RAISE EXCEPTION 'This order has an open dispute';
  END IF;

  IF v_order.status NOT IN ('ready_for_pickup', 'shipped', 'out_for_delivery', 'delivered') THEN
    RAISE EXCEPTION 'This order has not been shipped yet';
  END IF;

  UPDATE public.orders
  SET status = 'completed',
      confirmed_at = now(),
      escrow_status = 'released',
      tracking_updates = COALESCE(tracking_updates, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'status', 'completed',
        'message', 'Customer confirmed delivery',
        'timestamp', now()
      ))
  WHERE id = p_order_id;

  UPDATE public.payouts
  SET status = 'pending'
  WHERE order_id = p_order_id AND tranche = 2 AND status = 'held';
END;
$$;

CREATE OR REPLACE FUNCTION public.open_order_dispute(p_order_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Please describe the problem (at least 10 characters)';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.payment_status <> 'paid' OR v_order.escrow_status <> 'held' THEN
    RAISE EXCEPTION 'Payment for this order has already been released';
  END IF;

  IF v_order.dispute_status IS NOT NULL THEN
    RAISE EXCEPTION 'A dispute has already been opened for this order';
  END IF;

  UPDATE public.orders
  SET dispute_status = 'open',
      dispute_reason = btrim(p_reason),
      disputed_at = now()
  WHERE id = p_order_id;

  UPDATE public.payouts
  SET status = 'on_hold'
  WHERE order_id = p_order_id AND tranche = 2 AND status = 'held';

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  SELECT ur.user_id,
         'Order dispute opened',
         format('Order #%s: %s', left(p_order_id::TEXT, 8), left(btrim(p_reason), 140)),
         'warning', 'order', '/admin/finance',
         jsonb_build_object('order_id', p_order_id)
  FROM public.user_roles ur
  WHERE ur.role = 'admin';
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_order_delivery(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.open_order_dispute(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_order_delivery(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_order_dispute(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin actions
-- ---------------------------------------------------------------------------

-- p_outcome: 'release' pays the vendor's second half,
--            'refund' cancels it (refund the customer in Paystack).
CREATE OR REPLACE FUNCTION public.admin_resolve_dispute(p_order_id UUID, p_outcome TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admins only';
  END IF;

  IF p_outcome NOT IN ('release', 'refund') THEN
    RAISE EXCEPTION 'Outcome must be release or refund';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND OR v_order.dispute_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'No open dispute for this order';
  END IF;

  IF p_outcome = 'release' THEN
    UPDATE public.payouts SET status = 'pending'
    WHERE order_id = p_order_id AND tranche = 2 AND status IN ('held', 'on_hold');

    UPDATE public.orders
    SET dispute_status = 'resolved_vendor',
        dispute_resolved_at = now(),
        escrow_status = 'released',
        status = 'completed'
    WHERE id = p_order_id;
  ELSE
    UPDATE public.payouts SET status = 'cancelled'
    WHERE order_id = p_order_id AND status IN ('held', 'on_hold', 'pending', 'failed');

    UPDATE public.orders
    SET dispute_status = 'resolved_customer',
        dispute_resolved_at = now(),
        escrow_status = 'refunded',
        status = 'cancelled'
    WHERE id = p_order_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_retry_payout(p_payout_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admins only';
  END IF;

  UPDATE public.payouts
  SET status = 'pending', failure_reason = NULL
  WHERE id = p_payout_id AND status = 'failed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only failed payouts can be retried';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_dispute(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_retry_payout(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_dispute(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_retry_payout(UUID) TO authenticated;
