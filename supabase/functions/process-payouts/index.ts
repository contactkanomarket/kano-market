import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getCaller, isAdmin, serviceClient } from "../_shared/supabase.ts";
import { processPendingPayouts, reconcileProcessingPayouts } from "../_shared/payouts.ts";

// Scheduled payout run (and the admin "send payouts now" button):
//   1. releases second halves whose delivery window has ended,
//   2. sends every pending payout,
//   3. re-checks transfers stuck in processing,
//   4. ends featured placements whose time is up.
// Callable with the CRON_SECRET (scheduler) or by a signed-in admin.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const cronSecret = Deno.env.get('CRON_SECRET');
    const isCron = !!cronSecret && req.headers.get('x-cron-secret') === cronSecret;

    if (!isCron) {
      const caller = await getCaller(req);
      if (!caller || !(await isAdmin(caller.id))) {
        return json({ success: false, error: 'Not allowed' }, 403);
      }
    }

    const supabase = serviceClient();

    const { data: released, error: releaseError } = await supabase.rpc('release_due_payouts');
    if (releaseError) throw releaseError;

    // Featured placements and timed verification badges that ran out.
    const { data: expired, error: expireError } = await supabase.rpc('expire_featured_placements');
    if (expireError) console.error('Expiring featured placements failed:', expireError);

    const summary = await processPendingPayouts(supabase);
    const reconciled = await reconcileProcessingPayouts(supabase);

    return json({ success: true, released, reconciled, expired_placements: expired ?? 0, ...summary });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Payout run failed:', error);
    return json({ success: false, error: message }, 500);
  }
});
