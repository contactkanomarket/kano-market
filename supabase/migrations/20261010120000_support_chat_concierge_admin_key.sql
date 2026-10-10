-- 1. "Chat with Kano Kaftan" support threads for customers and vendors.
-- 2. Concierge orders: an admin builds the order in the chat, the customer pays,
--    the admin records the delivery company's pickup code and marks delivery.
-- 3. Admin access needs the admin secret key (checked by the admin-unlock
--    edge function); admin powers last for 12 hours per unlock.

-- ---------------------------------------------------------------------------
-- Support conversations
-- ---------------------------------------------------------------------------
-- kind = 'vendor': customer <-> shop (vendor_id set)
-- kind = 'support': any user <-> the Kano Kaftan team (vendor_id NULL;
--   all admins share the thread; vendor_last_read_at tracks the team's reads)

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'vendor' CHECK (kind IN ('vendor', 'support'));

ALTER TABLE public.conversations ALTER COLUMN vendor_id DROP NOT NULL;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_kind_vendor CHECK ((kind = 'vendor') = (vendor_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_support_thread
  ON public.conversations(customer_id) WHERE kind = 'support';

CREATE POLICY "Admins can view support conversations"
ON public.conversations FOR SELECT
USING (kind = 'support' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can view support messages"
ON public.messages FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = conversation_id AND c.kind = 'support'
) AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can reply in support conversations"
ON public.messages FOR INSERT
WITH CHECK (
  sender_id = auth.uid()
  AND public.has_role(auth.uid(), 'admin')
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id AND c.kind = 'support'
  )
);

-- Conversation summary + one notification per unread streak.
CREATE OR REPLACE FUNCTION public.on_message_sent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations%ROWTYPE;
  v_from_customer BOOLEAN;
  v_other_read_at TIMESTAMPTZ;
  v_sender_name TEXT;
  v_title TEXT;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = NEW.conversation_id FOR UPDATE;

  v_from_customer := NEW.sender_id = v_conv.customer_id;
  v_other_read_at := CASE WHEN v_from_customer THEN v_conv.vendor_last_read_at ELSE v_conv.customer_last_read_at END;

  UPDATE public.conversations
  SET last_message_at = NEW.created_at,
      last_message_preview = left(btrim(NEW.body), 140),
      last_sender_id = NEW.sender_id,
      customer_last_read_at = CASE WHEN v_from_customer THEN NEW.created_at ELSE customer_last_read_at END,
      vendor_last_read_at = CASE WHEN NOT v_from_customer THEN NEW.created_at ELSE vendor_last_read_at END
  WHERE id = NEW.conversation_id;

  -- Skip if this side already has an unread message waiting on the other side.
  IF v_conv.last_message_at IS NOT NULL
    AND ((v_conv.last_sender_id = v_conv.customer_id) = v_from_customer)
    AND v_other_read_at < v_conv.last_message_at
  THEN
    RETURN NEW;
  END IF;

  IF v_from_customer THEN
    SELECT COALESCE(NULLIF(store_name, ''), NULLIF(split_part(btrim(full_name), ' ', 1), ''))
    INTO v_sender_name FROM public.profiles WHERE id = NEW.sender_id;
    v_title := format('New message from %s', COALESCE(v_sender_name, 'a customer'));
  ELSIF v_conv.kind = 'support' THEN
    v_title := 'New message from Kano Kaftan';
  ELSE
    SELECT store_name INTO v_sender_name FROM public.profiles WHERE id = NEW.sender_id;
    v_title := format('New message from %s', COALESCE(v_sender_name, 'the seller'));
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  SELECT r.user_id, v_title, left(btrim(NEW.body), 140), 'info', 'message',
         '/messages/' || NEW.conversation_id,
         jsonb_build_object('conversation_id', NEW.conversation_id)
  FROM (
    SELECT v_conv.customer_id AS user_id WHERE NOT v_from_customer
    UNION
    SELECT v_conv.vendor_id WHERE v_from_customer AND v_conv.kind = 'vendor'
    UNION
    SELECT ur.user_id FROM public.user_roles ur
    WHERE v_from_customer AND v_conv.kind = 'support' AND ur.role = 'admin'
  ) r
  WHERE r.user_id IS NOT NULL;

  RETURN NEW;
END;
$$;

-- Open (or reuse) the signed-in user's thread with the Kano Kaftan team.
CREATE OR REPLACE FUNCTION public.start_support_conversation(p_product_id UUID DEFAULT NULL)
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
    RAISE EXCEPTION 'Please sign in to chat with us';
  END IF;

  IF p_product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
    p_product_id := NULL;
  END IF;

  INSERT INTO public.conversations (customer_id, vendor_id, product_id, kind)
  VALUES (v_uid, NULL, p_product_id, 'support')
  ON CONFLICT (customer_id) WHERE kind = 'support'
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
      vendor_last_read_at = CASE
        WHEN vendor_id = auth.uid() THEN now()
        WHEN kind = 'support' AND customer_id <> auth.uid() THEN now()
        ELSE vendor_last_read_at
      END
  WHERE id = p_conversation_id
    AND (auth.uid() IN (customer_id, vendor_id)
         OR (kind = 'support' AND public.has_role(auth.uid(), 'admin')));
END;
$$;

-- Inbox (replaces list_my_conversations, which is kept for older clients).
-- role: 'customer' (my thread with a shop), 'vendor' (a customer wrote to my
-- shop), 'support_user' (my thread with Kano Kaftan), 'support_team' (admin
-- view of someone's support thread).
CREATE OR REPLACE FUNCTION public.list_inbox(p_conversation_id UUID DEFAULT NULL)
RETURNS TABLE (
  id UUID,
  kind TEXT,
  role TEXT,
  other_party_id UUID,
  other_party_name TEXT,
  other_party_avatar TEXT,
  other_party_is_vendor BOOLEAN,
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
  WITH me AS (SELECT auth.uid() AS uid, public.has_role(auth.uid(), 'admin') AS is_admin)
  SELECT
    c.id,
    c.kind,
    CASE
      WHEN c.kind = 'vendor' AND c.customer_id = me.uid THEN 'customer'
      WHEN c.kind = 'vendor' THEN 'vendor'
      WHEN c.customer_id = me.uid THEN 'support_user'
      ELSE 'support_team'
    END,
    CASE WHEN c.customer_id = me.uid THEN c.vendor_id ELSE c.customer_id END,
    CASE
      WHEN c.kind = 'support' AND c.customer_id = me.uid THEN 'Kano Kaftan'
      WHEN c.customer_id = me.uid THEN COALESCE(v.store_name, 'Shop')
      ELSE COALESCE(NULLIF(cu.store_name, ''), NULLIF(split_part(btrim(cu.full_name), ' ', 1), ''), 'Customer')
    END,
    CASE WHEN c.customer_id = me.uid THEN v.avatar_url ELSE cu.avatar_url END,
    c.customer_id <> me.uid AND public.has_role(c.customer_id, 'vendor'),
    v.store_slug,
    c.product_id,
    pr.name,
    pr.slug,
    c.last_message_at,
    c.last_message_preview,
    c.last_message_at IS NOT NULL
      AND c.last_sender_id IS DISTINCT FROM me.uid
      AND c.last_message_at > CASE WHEN c.customer_id = me.uid THEN c.customer_last_read_at ELSE c.vendor_last_read_at END
      AND NOT (c.kind = 'support' AND c.customer_id <> me.uid AND c.last_sender_id <> c.customer_id)
  FROM conversations c
  CROSS JOIN me
  LEFT JOIN profiles v ON v.id = c.vendor_id
  LEFT JOIN profiles cu ON cu.id = c.customer_id
  LEFT JOIN products pr ON pr.id = c.product_id
  WHERE (me.uid IN (c.customer_id, c.vendor_id) OR (c.kind = 'support' AND me.is_admin))
    AND (p_conversation_id IS NULL OR c.id = p_conversation_id)
    AND (p_conversation_id IS NOT NULL OR c.last_message_at IS NOT NULL)
  ORDER BY c.last_message_at DESC NULLS LAST
$$;

REVOKE ALL ON FUNCTION public.start_support_conversation(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_inbox(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_support_conversation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_inbox(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Concierge orders + delivery pickup codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.order_deliveries (
  order_id UUID PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  delivery_company TEXT NOT NULL,
  pickup_code TEXT NOT NULL,
  tracking_reference TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.order_deliveries ENABLE ROW LEVEL SECURITY;

-- The pickup code is for the customer and the team only, never the vendor.
CREATE POLICY "Customers can see their delivery code"
ON public.order_deliveries FOR SELECT
USING (public.is_order_customer(order_id, auth.uid()));

CREATE POLICY "Admins can view deliveries"
ON public.order_deliveries FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_order_deliveries_updated_at
BEFORE UPDATE ON public.order_deliveries
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Admin builds an order for a customer (prices come from the catalogue,
-- delivery fee from the delivery company) and posts the pay link in the chat.
-- p_items: [{"product_id": "...", "variant_id": "..." | null, "quantity": 1}, ...]
CREATE OR REPLACE FUNCTION public.admin_create_order(
  p_customer_id UUID,
  p_items JSONB,
  p_delivery_fee NUMERIC,
  p_shipping_address JSONB,
  p_notes TEXT DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL
)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_item JSONB;
  v_product public.products%ROWTYPE;
  v_variant public.product_variants%ROWTYPE;
  v_qty INTEGER;
  v_unit NUMERIC;
  v_subtotal NUMERIC := 0;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Admins only';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item';
  END IF;

  IF p_delivery_fee IS NULL OR p_delivery_fee < 0 THEN
    RAISE EXCEPTION 'Enter the delivery fee';
  END IF;

  IF COALESCE(btrim(p_shipping_address ->> 'full_name'), '') = ''
    OR COALESCE(btrim(p_shipping_address ->> 'phone'), '') = ''
    OR COALESCE(btrim(p_shipping_address ->> 'street_address'), '') = ''
    OR COALESCE(btrim(p_shipping_address ->> 'city'), '') = ''
    OR COALESCE(btrim(p_shipping_address ->> 'state'), '') = ''
  THEN
    RAISE EXCEPTION 'Delivery address needs name, phone, street, city and state';
  END IF;

  INSERT INTO public.orders (
    user_id, status, payment_status, escrow_status,
    subtotal, shipping_fee, total, shipping_address, notes, delivery_type
  )
  VALUES (
    p_customer_id, 'pending_payment', 'pending', 'held',
    0, round(p_delivery_fee, 2), 0,
    jsonb_strip_nulls(jsonb_build_object(
      'full_name', btrim(p_shipping_address ->> 'full_name'),
      'phone', btrim(p_shipping_address ->> 'phone'),
      'street_address', btrim(p_shipping_address ->> 'street_address'),
      'city', btrim(p_shipping_address ->> 'city'),
      'state', btrim(p_shipping_address ->> 'state'),
      'landmark', NULLIF(btrim(p_shipping_address ->> 'landmark'), '')
    )),
    NULLIF(btrim(p_notes), ''),
    'concierge'
  )
  RETURNING * INTO v_order;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := (v_item ->> 'quantity')::INTEGER;
    IF v_qty IS NULL OR v_qty < 1 THEN
      RAISE EXCEPTION 'Quantity must be at least 1';
    END IF;

    SELECT * INTO v_product FROM public.products WHERE id = (v_item ->> 'product_id')::UUID;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found';
    END IF;

    v_variant := NULL;
    IF NULLIF(v_item ->> 'variant_id', '') IS NOT NULL THEN
      SELECT * INTO v_variant FROM public.product_variants
      WHERE id = (v_item ->> 'variant_id')::UUID AND product_id = v_product.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found for %', v_product.name;
      END IF;
    END IF;

    IF v_qty > COALESCE(v_variant.stock_quantity, v_product.stock_quantity) THEN
      RAISE EXCEPTION '"%" only has % in stock', v_product.name, COALESCE(v_variant.stock_quantity, v_product.stock_quantity);
    END IF;

    v_unit := v_product.price + COALESCE(v_variant.price_adjustment, 0);
    v_subtotal := v_subtotal + v_unit * v_qty;

    INSERT INTO public.order_items (
      order_id, product_id, variant_id, vendor_id,
      product_name, variant_name, quantity, unit_price, total_price
    )
    VALUES (
      v_order.id, v_product.id, v_variant.id, v_product.vendor_id,
      v_product.name, v_variant.name, v_qty, v_unit, v_unit * v_qty
    );
  END LOOP;

  UPDATE public.orders
  SET subtotal = v_subtotal, total = v_subtotal + round(p_delivery_fee, 2)
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  VALUES (
    p_customer_id, 'Your order is ready to pay',
    format('Order #%s: ₦%s including delivery. Tap to pay securely.', left(v_order.id::TEXT, 8), to_char(v_order.total, 'FM999,999,999,990.00')),
    'order', 'order', '/orders/' || v_order.id,
    jsonb_build_object('order_id', v_order.id)
  );

  IF p_conversation_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.conversations
    WHERE id = p_conversation_id AND kind = 'support' AND customer_id = p_customer_id
  ) THEN
    INSERT INTO public.messages (conversation_id, sender_id, body)
    VALUES (
      p_conversation_id, auth.uid(),
      format(E'Your order #%s is ready: ₦%s (items ₦%s + delivery ₦%s).\nPay securely here: /orders/%s',
        left(v_order.id::TEXT, 8),
        to_char(v_order.total, 'FM999,999,999,990.00'),
        to_char(v_order.subtotal, 'FM999,999,999,990.00'),
        to_char(v_order.shipping_fee, 'FM999,999,999,990.00'),
        v_order.id)
    );
  END IF;

  RETURN v_order;
END;
$$;

-- Admin records the delivery company and the pickup code the rider will ask for.
CREATE OR REPLACE FUNCTION public.admin_set_delivery(
  p_order_id UUID,
  p_delivery_company TEXT,
  p_pickup_code TEXT,
  p_tracking_reference TEXT DEFAULT NULL
)
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

  IF COALESCE(btrim(p_delivery_company), '') = '' OR COALESCE(btrim(p_pickup_code), '') = '' THEN
    RAISE EXCEPTION 'Enter the delivery company and pickup code';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'The customer has not paid for this order yet';
  END IF;

  INSERT INTO public.order_deliveries (order_id, delivery_company, pickup_code, tracking_reference, created_by)
  VALUES (p_order_id, btrim(p_delivery_company), btrim(p_pickup_code), NULLIF(btrim(p_tracking_reference), ''), auth.uid())
  ON CONFLICT (order_id) DO UPDATE
  SET delivery_company = EXCLUDED.delivery_company,
      pickup_code = EXCLUDED.pickup_code,
      tracking_reference = EXCLUDED.tracking_reference;

  UPDATE public.orders
  SET status = CASE WHEN status IN ('payment_confirmed', 'processing', 'ready_for_pickup') THEN 'shipped' ELSE status END,
      tracking_updates = COALESCE(tracking_updates, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'status', 'shipped',
        'message', format('Sent with %s', btrim(p_delivery_company)),
        'timestamp', now()
      ))
  WHERE id = p_order_id;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url, metadata)
  VALUES (
    v_order.user_id, 'Your order is on its way',
    format('Sent with %s. Your pickup code is %s. Give it to the rider when your parcel arrives.', btrim(p_delivery_company), btrim(p_pickup_code)),
    'order', 'order', '/orders/' || p_order_id,
    jsonb_build_object('order_id', p_order_id)
  );
END;
$$;

-- Admin confirms the rider collected the pickup code: releases the vendor's second half.
CREATE OR REPLACE FUNCTION public.admin_mark_delivered(p_order_id UUID)
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

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'This order has not been paid';
  END IF;
  IF v_order.dispute_status = 'open' THEN
    RAISE EXCEPTION 'Resolve the open dispute first';
  END IF;
  IF v_order.escrow_status <> 'held' THEN
    RAISE EXCEPTION 'Payment for this order has already been released';
  END IF;

  UPDATE public.orders
  SET status = 'completed',
      confirmed_at = now(),
      escrow_status = 'released',
      shipped_at = COALESCE(shipped_at, now()),
      tracking_updates = COALESCE(tracking_updates, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'status', 'completed',
        'message', 'Delivered (pickup code confirmed)',
        'timestamp', now()
      ))
  WHERE id = p_order_id;

  UPDATE public.payouts
  SET status = 'pending'
  WHERE order_id = p_order_id AND tranche = 2 AND status = 'held';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_order(UUID, JSONB, NUMERIC, JSONB, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_delivery(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_mark_delivered(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_order(UUID, JSONB, NUMERIC, JSONB, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_delivery(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_mark_delivered(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Admin secret key
-- ---------------------------------------------------------------------------
-- admin-unlock (edge function) checks the key and records an unlock here.
-- The admin role only counts while an unlock is active, so the key protects
-- the data itself, not just the admin screens.

CREATE TABLE IF NOT EXISTS public.admin_unlocks (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  unlocked_until TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_unlock_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  succeeded BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_unlock_attempts_user ON public.admin_unlock_attempts(user_id, created_at DESC);

ALTER TABLE public.admin_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_unlock_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can see their own admin unlock"
ON public.admin_unlocks FOR SELECT
USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
  AND (
    _role <> 'admin'
    OR EXISTS (
      SELECT 1 FROM public.admin_unlocks
      WHERE user_id = _user_id AND unlocked_until > now()
    )
  )
$$;
