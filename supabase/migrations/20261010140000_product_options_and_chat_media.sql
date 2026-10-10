-- Product sizes/colours, admin product image uploads, and photo/voice messages in chat.

-- ───────────── Product options ─────────────
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS sizes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS colors TEXT[] NOT NULL DEFAULT '{}';

-- Admins post products too, so they need the same upload rights as vendors.
CREATE POLICY "Admins can upload product images"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'product-images' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update product images"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'product-images' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete product images"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'product-images' AND public.has_role(auth.uid(), 'admin'));

-- ───────────── Chat media ─────────────
-- body stays required: media messages carry a short label ("Photo", "Voice note")
-- so inbox previews and notifications keep working unchanged.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text'
    CHECK (message_type IN ('text', 'image', 'voice')),
  ADD COLUMN IF NOT EXISTS media_path TEXT;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_media_matches_type CHECK (
    (message_type = 'text' AND media_path IS NULL)
    OR (message_type <> 'text' AND media_path IS NOT NULL
        AND media_path LIKE conversation_id::text || '/%')
  );

-- Whether the caller may read/post in a conversation (participants, plus admins on support chats).
CREATE OR REPLACE FUNCTION public.can_access_conversation(p_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id
      AND (
        auth.uid() IN (c.customer_id, c.vendor_id)
        OR (c.kind = 'support' AND public.has_role(auth.uid(), 'admin'))
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_access_conversation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_conversation(UUID) TO authenticated;

-- Private bucket: files live at <conversation_id>/<random name> and only that
-- conversation's members can read or upload them (the app uses signed URLs).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media', 'chat-media', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Conversation members can upload chat media"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'chat-media'
  AND public.can_access_conversation(((storage.foldername(name))[1])::uuid)
);

CREATE POLICY "Conversation members can view chat media"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'chat-media'
  AND public.can_access_conversation(((storage.foldername(name))[1])::uuid)
);

-- ───────────── Size / colour on cart and order lines ─────────────
ALTER TABLE public.cart_items
  ADD COLUMN IF NOT EXISTS size TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT;

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS size TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT;

-- Same as the earlier place_order, plus: each line must carry a size/colour the
-- product actually offers, and the choice is copied onto the order line.
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
      v.stock_quantity AS variant_stock,
      c.size,
      c.color,
      p.sizes AS product_sizes,
      p.colors AS product_colors
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

    IF cardinality(v_item.product_sizes) > 0
      AND (v_item.size IS NULL OR NOT v_item.size = ANY (v_item.product_sizes)) THEN
      v_stock_errors := v_stock_errors || format('Please choose a size for "%s"', v_item.product_name);
    END IF;
    IF cardinality(v_item.product_colors) > 0
      AND (v_item.color IS NULL OR NOT v_item.color = ANY (v_item.product_colors)) THEN
      v_stock_errors := v_stock_errors || format('Please choose a colour for "%s"', v_item.product_name);
    END IF;

    v_subtotal := v_subtotal + (v_item.price + v_item.price_adjustment) * v_item.quantity;
  END LOOP;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'Cart is empty';
  END IF;

  IF array_length(v_stock_errors, 1) > 0 THEN
    RAISE EXCEPTION 'Please fix your cart: %', array_to_string(v_stock_errors, '; ');
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
    product_name, variant_name, size, color, quantity, unit_price, total_price
  )
  SELECT
    v_order.id, p.id, v.id, p.vendor_id,
    p.name, COALESCE(v.name, NULLIF(concat_ws(' / ', c.size, c.color), '')), c.size, c.color, c.quantity,
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

-- Admins post and edit products for any vendor, including their images and variants.
CREATE POLICY "Admins can manage all product images"
ON public.product_images FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage all product variants"
ON public.product_variants FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));
