import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  base64UrlToBytes,
  fetchPublicKey,
  forgetThisDevice,
  getRegistration,
  isIos,
  isStandalone,
  pushSupported,
  saveSubscription,
} from "@/lib/push";

export type PushStatus =
  | "loading"
  | "unsupported" // browser can't do web push at all
  | "needs-install" // iPhone/iPad: only works after "Add to Home Screen"
  | "blocked" // the user said no in the browser prompt
  | "off"
  | "on";

/**
 * Phone notifications for the signed-in user: shows the current state and turns them on/off.
 * Turning on also switches on order and promotion alerts in the profile, since
 * the person just asked for them.
 */
export function usePushNotifications() {
  const { user } = useAuth();
  const [status, setStatus] = useState<PushStatus>("loading");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!pushSupported()) {
      setStatus(isIos() && !isStandalone() ? "needs-install" : "unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("blocked");
      return;
    }
    try {
      const registration = await getRegistration();
      if (!registration) {
        setStatus("unsupported");
        return;
      }
      const subscription = await registration.pushManager.getSubscription();
      setStatus(subscription && Notification.permission === "granted" ? "on" : "off");
    } catch (error) {
      console.error("Could not read notification state", error);
      setStatus("off");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!user) throw new Error("Please sign in first");
    setBusy(true);
    try {
      // Must be asked straight from the tap, before any other await.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "blocked" : "off");
        throw new Error(
          permission === "denied"
            ? "Notifications are blocked for this site. Allow them in your phone's settings, then try again."
            : "Notifications were not allowed",
        );
      }
      const registration = await getRegistration();
      if (!registration) throw new Error("The app is still loading. Try again in a moment.");
      const publicKey = await fetchPublicKey();
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }));
      await saveSubscription(subscription);
      const { error } = await supabase
        .from("profiles")
        .update({ notification_push: true, notification_orders: true, notification_promotions: true })
        .eq("id", user.id);
      if (error) console.error("Could not update notification preferences", error);
      setStatus("on");
    } finally {
      setBusy(false);
    }
  }, [user]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await forgetThisDevice();
      setStatus("off");
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke("push", { body: { action: "test" } });
    if (error || !data?.success) throw new Error(data?.error || error?.message || "Could not send a test notification");
  }, []);

  return { status, busy, enable, disable, sendTest, refresh };
}

/**
 * Keeps this device linked to whoever is signed in: if the browser already has
 * a subscription (e.g. after switching accounts), it is saved for the current user.
 */
export function usePushSubscriptionSync() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user || !pushSupported() || Notification.permission !== "granted") return;
    let cancelled = false;
    (async () => {
      try {
        const registration = await getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription && !cancelled) await saveSubscription(subscription);
      } catch (error) {
        console.error("Could not sync push subscription", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);
}
