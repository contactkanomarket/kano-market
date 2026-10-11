-- Kano Market: extra shop categories. Phone categories already exist.
-- Safe to run more than once.

insert into public.categories (name, slug, description)
values
  ('Fashion', 'fashion', 'Clothes, shoes and traditional wear'),
  ('Food', 'food', 'Food and household groceries'),
  ('Home', 'home', 'Home and kitchen goods')
on conflict (slug) do nothing;

-- After you create your account at /auth, run the block below in the SQL editor.
-- Replace the email with the one you signed up with. This makes that account
-- the admin for 30 days. You can also unlock from /admin with the key stored
-- in public.platform_secrets (name = admin_access_key).
--
-- insert into public.user_roles (user_id, role)
-- select id, 'admin'::public.app_role
-- from auth.users
-- where lower(email) = lower('you@email.com')
-- on conflict (user_id, role) do nothing;
--
-- insert into public.admin_unlocks (user_id, unlocked_until)
-- select id, now() + interval '30 days'
-- from auth.users
-- where lower(email) = lower('you@email.com')
-- on conflict (user_id) do update
--   set unlocked_until = excluded.unlocked_until,
--       updated_at = now();
