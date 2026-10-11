-- Admin sets a seller's badge directly: none, blue (verified) or gold (top tier).
-- No payment involved; the seller is notified of the change.
CREATE OR REPLACE FUNCTION public.admin_set_verification_tier(p_vendor_id UUID, p_tier TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old TEXT;
  v_was_verified BOOLEAN;
  v_period INTEGER;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only admins can change verification';
  END IF;
  IF p_tier NOT IN ('none', 'blue', 'gold') THEN
    RAISE EXCEPTION 'Choose none, blue or gold';
  END IF;
  IF NOT public.has_role(p_vendor_id, 'vendor') THEN
    RAISE EXCEPTION 'This account is not a seller';
  END IF;

  SELECT CASE WHEN public.vendor_is_verified(id) THEN COALESCE(verification_tier, 'blue') ELSE 'none' END,
         public.vendor_is_verified(id)
  INTO v_old, v_was_verified
  FROM public.profiles WHERE id = p_vendor_id
  FOR UPDATE;

  IF v_old = p_tier THEN
    RETURN p_tier;
  END IF;

  IF p_tier = 'none' THEN
    UPDATE public.profiles SET is_verified = false, verified_until = NULL WHERE id = p_vendor_id;
  ELSE
    SELECT verification_period_days INTO v_period FROM public.platform_settings WHERE id = 1;
    UPDATE public.profiles SET
      is_verified = true,
      verification_tier = p_tier,
      -- Moving between blue and gold keeps the current expiry; a new badge gets the normal period.
      verified_until = CASE
        WHEN v_was_verified THEN verified_until
        WHEN v_period IS NULL THEN NULL
        ELSE now() + make_interval(days => v_period) END
    WHERE id = p_vendor_id;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url)
  VALUES (
    p_vendor_id,
    CASE p_tier
      WHEN 'gold' THEN 'Your shop is now gold'
      WHEN 'blue' THEN CASE WHEN v_old = 'gold' THEN 'Your shop is now blue verified' ELSE 'Your shop is verified' END
      ELSE 'Your verified badge was removed' END,
    CASE p_tier
      WHEN 'gold' THEN 'Kano Kaftan gave your shop the gold badge. Your shop and products now show first.'
      WHEN 'blue' THEN CASE WHEN v_old = 'gold'
        THEN 'Your shop now has the blue verified badge instead of gold.'
        ELSE 'Kano Kaftan verified your shop. Your blue badge is now live.' END
      ELSE 'Your shop no longer has a verified badge. Contact support if you have questions.' END,
    CASE WHEN p_tier = 'none' OR (p_tier = 'blue' AND v_old = 'gold') THEN 'warning' ELSE 'success' END,
    'system',
    '/vendor/verification'
  );

  RETURN p_tier;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_verification_tier(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_verification_tier(UUID, TEXT) TO authenticated;
