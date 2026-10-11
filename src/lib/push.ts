import { supabase } from "@/integrations/supabase/client";

// Browser side of phone (web push) notifications.

const SERVICE_WORKER_TIMEOUT_MS = 8000;

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** The app's service worker, or null if it never activates (e.g. in local dev). */
export async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SERVICE_WORKER_TIMEOUT_MS));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export async function fetchPublicKey(): Promise<string> {
  const { data, error } = await supabase.functions.invoke("push", { body: { action: "public_key" } });
  if (error || !data?.publicKey) throw new Error(data?.error || error?.message || "Could not reach the notification service");
  return data.publicKey as string;
}

export async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("This browser returned an incomplete subscription");
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: json.endpoint,
    p_p256dh: json.keys.p256dh,
    p_auth: json.keys.auth,
    p_user_agent: navigator.userAgent,
  });
  if (error) throw new Error(error.message);
}

/** Removes this device's subscription for the signed-in user (call before signing out). */
export async function forgetThisDevice(): Promise<void> {
  if (!pushSupported()) return;
  try {
    // No waiting here: sign-out should not hang when there is no service worker.
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
    if (error) console.error("Could not remove push subscription", error);
    await subscription.unsubscribe();
  } catch (error) {
    console.error("Could not turn off notifications on this device", error);
  }
}
