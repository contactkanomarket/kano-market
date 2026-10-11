-- Health-check fixes.

-- 1) Photos: a seller (or customer) may only add, replace or remove files in
--    their own folder (<user id>/...). Admins keep full access. Restrictive
--    policies are ANDed with the existing ones, so this only narrows access.
CREATE POLICY "Product images: own folder only (insert)" ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id <> 'product-images'
    OR (storage.foldername(name))[1] = (SELECT auth.uid())::text
    OR public.has_role((SELECT auth.uid()), 'admin')
  );
CREATE POLICY "Product images: own folder only (update)" ON storage.objects
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    bucket_id <> 'product-images'
    OR (storage.foldername(name))[1] = (SELECT auth.uid())::text
    OR public.has_role((SELECT auth.uid()), 'admin')
  );
CREATE POLICY "Product images: own folder only (delete)" ON storage.objects
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    bucket_id <> 'product-images'
    OR (storage.foldername(name))[1] = (SELECT auth.uid())::text
    OR public.has_role((SELECT auth.uid()), 'admin')
  );
-- Customers (not only sellers) can upload a profile picture into their own folder.
CREATE POLICY "Users can upload their own profile picture" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-images' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text AND name LIKE '%/avatar.%');
CREATE POLICY "Users can replace their own profile picture" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'product-images' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text AND name LIKE '%/avatar.%');

-- 2) Trigger-only functions should not be callable through the API.
REVOKE EXECUTE ON FUNCTION public.check_message_reply() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_single_default_address() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_followers_of_new_product() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.on_message_sent() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.push_new_notification() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_vendor_product_rank() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_order_item_changes() FROM PUBLIC, anon, authenticated;

-- 3) Fixed search_path on every function the checker flagged.
ALTER FUNCTION legacy.is_admin() SET search_path = public;
ALTER FUNCTION public.is_client_request() SET search_path = public;
ALTER FUNCTION public.guard_order_item_changes() SET search_path = public;
ALTER FUNCTION public.shipping_base_fee(numeric) SET search_path = public;
ALTER FUNCTION public.shipping_value_discount(numeric) SET search_path = public;
ALTER FUNCTION public.distance_km(numeric, numeric, numeric, numeric) SET search_path = public;
ALTER FUNCTION public.slugify(text) SET search_path = public;
ALTER FUNCTION public.call_ring_seconds() SET search_path = public;
ALTER FUNCTION public.story_lifetime() SET search_path = public;
ALTER FUNCTION public.story_max_active() SET search_path = public;

-- 4) Indexes for foreign keys used in lookups and joins.
CREATE INDEX IF NOT EXISTS calls_conversation_id_idx ON public.calls (conversation_id);
CREATE INDEX IF NOT EXISTS cart_items_product_id_idx ON public.cart_items (product_id);
CREATE INDEX IF NOT EXISTS cart_items_user_id_idx ON public.cart_items (user_id);
CREATE INDEX IF NOT EXISTS cart_items_variant_id_idx ON public.cart_items (variant_id);
CREATE INDEX IF NOT EXISTS conversations_product_id_idx ON public.conversations (product_id);
CREATE INDEX IF NOT EXISTS delivery_addresses_user_id_idx ON public.delivery_addresses (user_id);
CREATE INDEX IF NOT EXISTS featured_placements_product_id_idx ON public.featured_placements (product_id);
CREATE INDEX IF NOT EXISTS message_reactions_user_id_idx ON public.message_reactions (user_id);
CREATE INDEX IF NOT EXISTS messages_sender_id_idx ON public.messages (sender_id);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_product_id_idx ON public.order_items (product_id);
CREATE INDEX IF NOT EXISTS order_items_variant_id_idx ON public.order_items (variant_id);
CREATE INDEX IF NOT EXISTS order_items_vendor_id_idx ON public.order_items (vendor_id);
CREATE INDEX IF NOT EXISTS orders_user_id_idx ON public.orders (user_id);
CREATE INDEX IF NOT EXISTS product_images_product_id_idx ON public.product_images (product_id);
CREATE INDEX IF NOT EXISTS product_variants_product_id_idx ON public.product_variants (product_id);
CREATE INDEX IF NOT EXISTS products_category_id_idx ON public.products (category_id);
CREATE INDEX IF NOT EXISTS products_vendor_id_idx ON public.products (vendor_id);
CREATE INDEX IF NOT EXISTS reviews_order_item_id_idx ON public.reviews (order_item_id);
CREATE INDEX IF NOT EXISTS reviews_product_id_idx ON public.reviews (product_id);
CREATE INDEX IF NOT EXISTS story_likes_user_id_idx ON public.story_likes (user_id);
CREATE INDEX IF NOT EXISTS story_views_user_id_idx ON public.story_views (user_id);
CREATE INDEX IF NOT EXISTS wishlists_product_id_idx ON public.wishlists (product_id);
