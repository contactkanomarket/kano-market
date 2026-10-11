import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/supabase.ts";

// Network helpers for voice calls (signed-in users only).
// Always returns public STUN servers. If a relay (TURN) is configured in the
// project secrets, it is added so calls connect on strict mobile networks:
//   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN  -> short-lived Cloudflare TURN credentials
//   or TURN_URLS (comma separated) + TURN_USERNAME + TURN_CREDENTIAL -> any other TURN provider

const CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;

const STUN_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

async function cloudflareTurn(): Promise<Record<string, unknown> | null> {
  const keyId = Deno.env.get("CLOUDFLARE_TURN_KEY_ID");
  const token = Deno.env.get("CLOUDFLARE_TURN_API_TOKEN");
  if (!keyId || !token) return null;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
  });
  if (!res.ok) {
    console.error("Cloudflare TURN credentials failed", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = await res.json();
  return data?.iceServers ?? null;
}

function staticTurn(): Record<string, unknown> | null {
  const urls = Deno.env.get("TURN_URLS");
  const username = Deno.env.get("TURN_USERNAME");
  const credential = Deno.env.get("TURN_CREDENTIAL");
  if (!urls || !username || !credential) return null;
  return { urls: urls.split(",").map((u) => u.trim()).filter(Boolean), username, credential };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const caller = await getCaller(req);
    if (!caller) return json({ success: false, error: "Please sign in" }, 401);

    const relay = (await cloudflareTurn().catch((e) => {
      console.error("Cloudflare TURN error", e);
      return null;
    })) ?? staticTurn();

    return json({ success: true, iceServers: relay ? [...STUN_SERVERS, relay] : STUN_SERVERS, relay: !!relay });
  } catch (e) {
    console.error("call-ice error", e);
    return json({ success: true, iceServers: STUN_SERVERS, relay: false });
  }
});
