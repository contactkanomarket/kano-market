import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ReportTarget = "user" | "message" | "story";
export const REPORT_REASONS = [
  { value: "scam", label: "Scam or fraud" },
  { value: "harassment", label: "Harassment or threats" },
  { value: "spam", label: "Spam" },
  { value: "inappropriate", label: "Inappropriate content" },
  { value: "fake", label: "Fake or misleading" },
  { value: "other", label: "Something else" },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]["value"];
export const REPORT_DETAILS_MAX = 500;

const blockKey = (conversationId: string | undefined) => ["conversation-block", conversationId] as const;

/** Whether I blocked the other person in this chat, or they blocked me. */
export function useConversationBlock(conversationId: string | undefined) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: blockKey(conversationId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("conversation_block_state", { p_conversation_id: conversationId! });
      if (error) {
        console.error("[moderation] could not load block state", { conversationId, error });
        throw error;
      }
      return data?.[0] ?? { i_blocked: false, blocked_me: false };
    },
    enabled: !!conversationId,
  });

  const setBlocked = useMutation({
    mutationFn: async (block: boolean) => {
      const { error } = await supabase.rpc("set_conversation_block", { p_conversation_id: conversationId!, p_block: block });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: blockKey(conversationId) }),
  });

  return {
    iBlocked: state.data?.i_blocked ?? false,
    blockedMe: state.data?.blocked_me ?? false,
    setBlocked,
  };
}

export function useReport() {
  return useMutation({
    mutationFn: async (input: { targetType: ReportTarget; targetId: string; reason: ReportReason; details: string }) => {
      const { error } = await supabase.rpc("report_content", {
        p_target_type: input.targetType,
        p_target_id: input.targetId,
        p_reason: input.reason,
        p_details: input.details.trim() || undefined,
      });
      if (error) throw new Error(error.message);
    },
  });
}
