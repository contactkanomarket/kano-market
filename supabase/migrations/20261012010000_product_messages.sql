-- "Buy through Kano Kaftan" from a product: open the support chat and send
-- the product itself as a card, so the team can create the order straight away.
-- It is a normal text message with product_id set; the app draws it as a card.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_product_id_idx ON public.messages (product_id) WHERE product_id IS NOT NULL;

/** Don't send the same product card again if it was sent this recently. */
CREATE OR REPLACE FUNCTION public.product_request_repeat_window()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT interval '30 minutes' $$;

CREATE OR REPLACE FUNCTION public.request_protected_purchase(p_product_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_conversation UUID;
  v_name TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Please sign in to buy through Kano Kaftan'; END IF;
  SELECT name INTO v_name FROM public.products WHERE id = p_product_id AND is_active;
  IF v_name IS NULL THEN RAISE EXCEPTION 'This product is no longer available'; END IF;

  v_conversation := public.start_support_conversation(p_product_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.messages
    WHERE conversation_id = v_conversation AND sender_id = v_uid AND product_id = p_product_id
      AND created_at > now() - public.product_request_repeat_window()
  ) THEN
    INSERT INTO public.messages (conversation_id, sender_id, body, message_type, product_id)
    VALUES (v_conversation, v_uid, format('🛍️ I''d like to buy this through Kano Kaftan: %s', v_name), 'text', p_product_id);
  END IF;

  RETURN v_conversation;
END;
$$;
REVOKE ALL ON FUNCTION public.request_protected_purchase(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_protected_purchase(UUID) TO authenticated;
