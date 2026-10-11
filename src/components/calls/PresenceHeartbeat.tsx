import { usePresenceHeartbeat } from "@/hooks/usePresence";

/** Keeps the signed-in user's "online / last seen" up to date while the app is open. */
export function PresenceHeartbeat() {
  usePresenceHeartbeat();
  return null;
}
