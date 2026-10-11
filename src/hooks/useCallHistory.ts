import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Database } from "@/integrations/supabase/types";

export type CallHistoryItem = Database["public"]["Functions"]["list_my_calls"]["Returns"][number];

export const CALL_HISTORY_QUERY_KEY = ["call-history"] as const;
const HISTORY_LIMIT = 100;

/** The signed-in user's calls, newest first (ringing/active calls excluded). */
export function useCallHistory() {
  const { user } = useAuth();
  return useQuery({
    queryKey: [...CALL_HISTORY_QUERY_KEY, user?.id],
    enabled: !!user,
    queryFn: async (): Promise<CallHistoryItem[]> => {
      const { data, error } = await supabase.rpc("list_my_calls", { p_limit: HISTORY_LIMIT });
      if (error) {
        console.error("[useCallHistory] list_my_calls failed", error);
        throw error;
      }
      return data ?? [];
    },
  });
}

/** A call the person didn't pick up (shown in red). */
export function isMissedForMe(call: CallHistoryItem): boolean {
  return !call.outgoing && (call.status === "missed" || call.status === "cancelled");
}

export function formatCallDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
