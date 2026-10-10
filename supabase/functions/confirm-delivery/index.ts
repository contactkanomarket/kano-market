import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";
import { processPendingPayouts } from "../_shared/payouts.ts";

// Customer confirms they received the order: releases the vendors' second half.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { orderId } = await req.json();
    if (!orderId) throw new Error('Order ID is required');

    // Runs as the customer, so the database checks they own the order.
    const { error } = await userClient(req).rpc('confirm_order_delivery', { p_order_id: orderId });
    if (error) throw new Error(error.message);

    try {
      await processPendingPayouts(serviceClient(), { orderId });
    } catch (payoutError) {
      console.error('Payout after confirmation failed; scheduled run will retry:', payoutError);
    }

    return json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return json({ success: false, error: message }, 400);
  }
});
