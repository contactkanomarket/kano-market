import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, isToday, isYesterday } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/** How often an open app tells the server "I'm here". */
const HEARTBEAT_MS = 60 * 1000;
/** Seen within this long counts as online (a little over two heartbeats). */
const ONLINE_WINDOW_MS = 2.5 * 60 * 1000;
/** How often an open chat re-checks the other person. */
const PRESENCE_POLL_MS = 30 * 1000;

async function touchLastSeen() {
  const { error } = await supabase.rpc("touch_last_seen");
  if (error) console.error("[presence] touch_last_seen failed", error);
}

/** Mounted once for the whole app: keeps the signed-in user's "last seen" fresh while the app is open. */
export function usePresenceHeartbeat() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    let timer: number | undefined;
    const beat = () => {
      if (document.visibilityState === "visible") touchLastSeen();
    };
    const onVisibility = () => {
      window.clearInterval(timer);
      if (document.visibilityState === "visible") {
        beat();
        timer = window.setInterval(beat, HEARTBEAT_MS);
      }
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user]);
}

export interface Presence {
  online: boolean;
  lastSeenAt: Date | null;
}

/** Whether the other person in a chat is online, and when they were last seen. */
export function useConversationPresence(conversationId: string | undefined) {
  return useQuery({
    queryKey: ["conversation-presence", conversationId],
    enabled: !!conversationId,
    refetchInterval: PRESENCE_POLL_MS,
    refetchIntervalInBackground: false,
    queryFn: async (): Promise<Presence> => {
      const { data, error } = await supabase.rpc("conversation_presence", { p_conversation_id: conversationId! });
      if (error) {
        console.error("[presence] conversation_presence failed", error);
        throw error;
      }
      const lastSeenAt = data ? new Date(data as string) : null;
      return { lastSeenAt, online: !!lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_WINDOW_MS };
    },
  });
}

/** "last seen today at 14:05", "last seen yesterday at 09:12", "last seen 3 Oct". */
export function formatLastSeen(date: Date): string {
  if (isToday(date)) return `last seen today at ${format(date, "HH:mm")}`;
  if (isYesterday(date)) return `last seen yesterday at ${format(date, "HH:mm")}`;
  if (Date.now() - date.getTime() < 7 * 24 * 60 * 60 * 1000) return `last seen ${format(date, "EEEE")} at ${format(date, "HH:mm")}`;
  return `last seen ${format(date, "d MMM")}`;
}
