import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";

// Retired: featured placement is now bought per week from Promote
// (vendor-fees function + request_featured_placement), verified sellers only.
serve((req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  return json({ success: false, error: 'Featuring has moved. Open Promote in your seller dashboard.' }, 410);
});
