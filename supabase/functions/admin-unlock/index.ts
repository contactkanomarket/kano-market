import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getCaller, serviceClient } from "../_shared/supabase.ts";

// Admin sign-in step 2: a signed-in user enters the admin secret key.
//   action "unlock" { key } -> grants the admin role (first time) and unlocks
//                              admin powers for 12 hours
//   action "lock"           -> ends the caller's admin unlock (on logout)
// Secrets: ADMIN_ACCESS_KEY (required, 20+ chars), ADMIN_EMAILS (optional,
// comma-separated allow-list of accounts that may become admin).

const UNLOCK_HOURS = 12;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MINUTES = 15;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function keysMatch(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const caller = await getCaller(req);
    if (!caller) return json({ success: false, error: 'Please sign in first' }, 401);

    const supabase = serviceClient();
    const { action, key } = await req.json();

    if (action === 'lock') {
      await supabase.from('admin_unlocks').update({ unlocked_until: new Date().toISOString() }).eq('user_id', caller.id);
      return json({ success: true });
    }

    if (action !== 'unlock') throw new Error('Unknown action');

    const expected = Deno.env.get('ADMIN_ACCESS_KEY') ?? '';
    if (expected.length < 20) {
      return json({ success: false, error: 'Admin access is not set up yet' }, 503);
    }

    const allowed = (Deno.env.get('ADMIN_EMAILS') ?? '')
      .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes((caller.email ?? '').toLowerCase())) {
      return json({ success: false, error: 'This account cannot access the admin area' }, 403);
    }

    const since = new Date(Date.now() - FAILURE_WINDOW_MINUTES * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('admin_unlock_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', caller.id)
      .eq('succeeded', false)
      .gte('created_at', since);
    if ((count ?? 0) >= MAX_FAILURES) {
      return json({ success: false, error: `Too many wrong attempts. Try again in ${FAILURE_WINDOW_MINUTES} minutes.` }, 429);
    }

    const ok = typeof key === 'string' && key.length > 0 && await keysMatch(key, expected);
    await supabase.from('admin_unlock_attempts').insert({ user_id: caller.id, succeeded: ok });

    if (!ok) {
      return json({ success: false, error: 'Wrong admin key' }, 403);
    }

    const { error: roleError } = await supabase
      .from('user_roles')
      .upsert({ user_id: caller.id, role: 'admin' }, { onConflict: 'user_id,role', ignoreDuplicates: true });
    if (roleError) throw roleError;

    const unlockedUntil = new Date(Date.now() + UNLOCK_HOURS * 60 * 60 * 1000).toISOString();
    const { error: unlockError } = await supabase
      .from('admin_unlocks')
      .upsert({ user_id: caller.id, unlocked_until: unlockedUntil, updated_at: new Date().toISOString() });
    if (unlockError) throw unlockError;

    return json({ success: true, unlocked_until: unlockedUntil });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Admin unlock failed:', error);
    return json({ success: false, error: message }, 400);
  }
});
