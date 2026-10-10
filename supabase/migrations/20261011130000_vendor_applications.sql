-- Sellers apply; admins approve. Nobody can make themselves a seller.
--
-- New sellers sign up on the seller application page (email + password). The
-- application travels in the sign-up metadata, so it is saved even when email
-- confirmation is on and there is no session yet. Signed-in customers can also
-- apply with submit_vendor_application(). An admin approves, which grants the
-- vendor role and copies the shop details to the profile.

CREATE TABLE IF NOT EXISTS public.vendor_applications (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note TEXT,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_applications_status ON public.vendor_applications(status, created_at);

ALTER TABLE public.vendor_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Applicants can view their application"
ON public.vendor_applications FOR SELECT
USING (user_id = auth.uid());

CREATE POLICY "Admins can view vendor applications"
ON public.vendor_applications FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_vendor_applications_updated_at
BEFORE UPDATE ON public.vendor_applications
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Saves (or resubmits) an application and tells the admins. Trusted callers only.
CREATE OR REPLACE FUNCTION public.save_vendor_application(
  p_user_id UUID,
  p_full_name TEXT,
  p_shop_name TEXT,
  p_phone TEXT,
  p_city TEXT,
  p_state TEXT,
  p_description TEXT
)
RETURNS public.vendor_applications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.vendor_applications%ROWTYPE;
BEGIN
  INSERT INTO public.vendor_applications (user_id, full_name, shop_name, phone, city, state, description, status)
  VALUES (
    p_user_id,
    left(COALESCE(NULLIF(btrim(p_full_name), ''), 'Seller'), 120),
    left(btrim(p_shop_name), 60),
    left(btrim(p_phone), 20),
    left(btrim(p_city), 60),
    left(btrim(p_state), 40),
    left(btrim(p_description), 600),
    'pending'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    shop_name = EXCLUDED.shop_name,
    phone = EXCLUDED.phone,
    city = EXCLUDED.city,
    state = EXCLUDED.state,
    description = EXCLUDED.description,
    status = 'pending',
    admin_note = NULL,
    reviewed_by = NULL,
    reviewed_at = NULL
  WHERE public.vendor_applications.status <> 'approved'
  RETURNING * INTO v_row;

  IF v_row.user_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, message, type, category, action_url)
    SELECT ur.user_id, 'New seller application',
           format('%s (%s, %s) wants to sell on Kano Kaftan.', v_row.shop_name, v_row.city, v_row.state),
           'info', 'system', '/admin/vendors?tab=applications'
    FROM public.user_roles ur WHERE ur.role = 'admin';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.save_vendor_application(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_vendor_application(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- Every sign-up starts as a customer. A seller application in the sign-up
-- metadata is saved for review; it never grants the vendor role by itself.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  v_app JSONB := v_meta -> 'vendor_application';
  v_name TEXT := COALESCE(NULLIF(btrim(v_meta ->> 'full_name'), ''), NULLIF(btrim(v_meta ->> 'name'), ''), '');
  v_phone TEXT := NULLIF(left(btrim(COALESCE(v_meta ->> 'phone', '')), 20), '');
BEGIN
  INSERT INTO public.profiles (id, email, full_name, phone)
  VALUES (NEW.id, COALESCE(NEW.email, ''), v_name, v_phone);

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'customer')
  ON CONFLICT (user_id, role) DO NOTHING;

  IF jsonb_typeof(v_app) = 'object'
     AND char_length(btrim(COALESCE(v_app ->> 'shop_name', ''))) >= 2 THEN
    PERFORM public.save_vendor_application(
      NEW.id,
      v_name,
      v_app ->> 'shop_name',
      COALESCE(NULLIF(btrim(v_app ->> 'phone'), ''), v_phone, ''),
      COALESCE(v_app ->> 'city', ''),
      COALESCE(v_app ->> 'state', ''),
      COALESCE(v_app ->> 'description', '')
    );
  END IF;

  RETURN NEW;
END;
$$;

-- A signed-in customer applies (or fixes a rejected application).
CREATE OR REPLACE FUNCTION public.submit_vendor_application(
  p_shop_name TEXT,
  p_phone TEXT,
  p_city TEXT,
  p_state TEXT,
  p_description TEXT,
  p_full_name TEXT DEFAULT NULL
)
RETURNS public.vendor_applications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.vendor_applications%ROWTYPE;
  v_name TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in first';
  END IF;
  IF public.has_role(v_uid, 'vendor') THEN
    RAISE EXCEPTION 'You already have a seller account';
  END IF;
  IF char_length(btrim(COALESCE(p_shop_name, ''))) < 2 THEN
    RAISE EXCEPTION 'Enter your shop name';
  END IF;
  IF btrim(COALESCE(p_phone, '')) !~ '^(\+?234|0)[789][01][0-9]{8}$' THEN
    RAISE EXCEPTION 'Enter a valid Nigerian phone number';
  END IF;
  IF char_length(btrim(COALESCE(p_city, ''))) < 2 OR char_length(btrim(COALESCE(p_state, ''))) < 2 THEN
    RAISE EXCEPTION 'Enter your town and state';
  END IF;
  IF char_length(btrim(COALESCE(p_description, ''))) < 20 THEN
    RAISE EXCEPTION 'Tell us a little more about what you sell';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vendor_applications WHERE user_id = v_uid AND status = 'pending') THEN
    RAISE EXCEPTION 'Your application is already being reviewed';
  END IF;

  SELECT COALESCE(NULLIF(btrim(p_full_name), ''), full_name) INTO v_name FROM public.profiles WHERE id = v_uid;

  v_row := public.save_vendor_application(v_uid, v_name, p_shop_name, p_phone, p_city, p_state, p_description);
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_vendor_application(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_vendor_application(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- Admin approves (grants the seller role, sets up the shop) or rejects with a reason.
CREATE OR REPLACE FUNCTION public.admin_review_vendor_application(
  p_user_id UUID,
  p_approve BOOLEAN,
  p_note TEXT DEFAULT NULL
)
RETURNS public.vendor_applications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.vendor_applications%ROWTYPE;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Only admins can review seller applications';
  END IF;

  SELECT * INTO v_row FROM public.vendor_applications WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application not found';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This application has already been reviewed';
  END IF;
  IF NOT p_approve AND (p_note IS NULL OR btrim(p_note) = '') THEN
    RAISE EXCEPTION 'Tell the applicant why, so they can fix it';
  END IF;

  UPDATE public.vendor_applications SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    admin_note = NULLIF(btrim(p_note), ''),
    reviewed_by = auth.uid(),
    reviewed_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_row;

  IF p_approve THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (p_user_id, 'vendor')
    ON CONFLICT (user_id, role) DO NOTHING;

    UPDATE public.profiles SET
      store_name = v_row.shop_name,
      store_description = v_row.description,
      phone = COALESCE(NULLIF(phone, ''), v_row.phone),
      full_name = COALESCE(NULLIF(full_name, ''), v_row.full_name),
      store_address = COALESCE(store_address, '{}'::jsonb)
        || jsonb_build_object('city', v_row.city, 'state', v_row.state)
    WHERE id = p_user_id;
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, category, action_url)
  VALUES (
    p_user_id,
    CASE WHEN p_approve THEN 'Your shop is ready' ELSE 'Your seller application needs changes' END,
    CASE WHEN p_approve
      THEN 'Welcome to Kano Kaftan! Sign in to your seller dashboard to add your products.'
      ELSE 'Please update your application: ' || btrim(p_note) END,
    CASE WHEN p_approve THEN 'success' ELSE 'warning' END,
    'system',
    CASE WHEN p_approve THEN '/vendor/dashboard' ELSE '/sell' END
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_review_vendor_application(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_vendor_application(UUID, BOOLEAN, TEXT) TO authenticated;

-- The old instant "become a vendor" skipped review. Only trusted code may use it now.
REVOKE EXECUTE ON FUNCTION public.become_vendor(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
