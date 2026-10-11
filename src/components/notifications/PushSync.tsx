import { usePushSubscriptionSync } from "@/hooks/usePushNotifications";

/** Keeps this phone's notification subscription linked to the signed-in account. */
export function PushSync() {
  usePushSubscriptionSync();
  return null;
}
