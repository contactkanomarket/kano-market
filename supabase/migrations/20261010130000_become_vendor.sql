-- Customers (including Google sign-ups, who can't pick a role at signup)
-- become vendors here. Clients cannot insert roles directly.
CREATE OR REPLACE FUNCTION public.become_vendor(
  p_store_name TEXT,
  p_store_description TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in first';
  END IF;

  IF char_length(btrim(COALESCE(p_store_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Store name must be at least 2 characters';
  END IF;

  IF public.has_role(v_uid, 'vendor') THEN
    RAISE EXCEPTION 'You already have a vendor account';
  END IF;

  INSERT INTO public.user_roles (user_id, role) VALUES (v_uid, 'vendor')
  ON CONFLICT (user_id, role) DO NOTHING;

  UPDATE public.profiles
  SET store_name = btrim(p_store_name),
      store_description = NULLIF(btrim(p_store_description), ''),
      phone = COALESCE(NULLIF(btrim(p_phone), ''), phone)
  WHERE id = v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.become_vendor(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.become_vendor(TEXT, TEXT, TEXT) TO authenticated;
