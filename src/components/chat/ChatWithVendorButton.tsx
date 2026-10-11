import { MessageCircle, Loader2 } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useStartConversation } from "@/hooks/useChat";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

interface ChatWithVendorButtonProps extends Omit<ButtonProps, "onClick"> {
  vendorId: string;
  productId?: string;
  label?: string;
}

export function ChatWithVendorButton({ vendorId, productId, label = "Chat with seller", ...buttonProps }: ChatWithVendorButtonProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const startConversation = useStartConversation();

  if (user?.id === vendorId) return null;

  const handleClick = async () => {
    if (!user) {
      toast.info("Sign in to chat with sellers");
      navigate(`/auth?redirect=${encodeURIComponent(location.pathname)}`);
      return;
    }
    try {
      const conversationId = await startConversation.mutateAsync({ vendorId, productId });
      // From a product page: send the product as a card so the seller sees exactly what you mean.
      if (productId) {
        const { error } = await supabase.rpc("send_product_card", { p_conversation_id: conversationId, p_product_id: productId });
        // Not fatal: the chat still opens, just without the card.
        if (error) console.warn("[ChatWithVendorButton] could not send product card", { productId, error });
      }
      navigate(`/messages/${conversationId}`);
    } catch (error: unknown) {
      console.error("[ChatWithVendorButton] could not open chat", { vendorId, productId, error });
      toast.error(error instanceof Error ? error.message : "Could not open chat");
    }
  };

  return (
    <Button {...buttonProps} onClick={handleClick} disabled={startConversation.isPending || buttonProps.disabled}>
      {startConversation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageCircle className="mr-2 h-4 w-4" />}
      {label}
    </Button>
  );
}
