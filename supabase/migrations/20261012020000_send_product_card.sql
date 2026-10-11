-- Product cards in any chat (customer ↔ seller, or support).
-- "Message seller" on a product opens the chat with that product already sent.

CREATE OR REPLACE FUNCTION public.send_product_card(p_conversation_id UUID, p_product_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_name TEXT;
BEGIN
  IF v_uid IS NULL OR NOT public.can_access_conversation(p_conversation_id) THEN
    RAISE EXCEPTION 'Chat not found';
  END IF;
  SELECT name INTO v_name FROM public.products WHERE id = p_product_id AND is_active;
  IF v_name IS NULL THEN RAISE EXCEPTION 'This product is no longer available'; END IF;

  -- Don't repeat the same card if it was just sent.
  IF EXISTS (
    SELECT 1 FROM public.messages
    WHERE conversation_id = p_conversation_id AND sender_id = v_uid AND product_id = p_product_id
      AND created_at > now() - public.product_request_repeat_window()
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.messages (conversation_id, sender_id, body, message_type, product_id)
  VALUES (p_conversation_id, v_uid, format('🛍️ Is this available? %s', v_name), 'text', p_product_id);
END;
$$;
REVOKE ALL ON FUNCTION public.send_product_card(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_product_card(UUID, UUID) TO authenticated;
