import { MessageCircle, Loader2 } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useStartConversation } from "@/hooks/useChat";
import { toast } from "sonner";

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
      navigate(`/messages/${conversationId}`);
    } catch (error: unknown) {
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
