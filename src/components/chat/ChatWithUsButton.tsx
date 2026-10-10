import { Headset, Loader2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useStartSupportConversation } from "@/hooks/useChat";
import { toast } from "sonner";

interface ChatWithUsButtonProps extends Omit<ButtonProps, "onClick"> {
  productId?: string;
  label?: string;
}

/** Opens a chat with the Kano Kaftan team (protected purchase / support). */
export function ChatWithUsButton({ productId, label = "Buy through Kano Kaftan", ...buttonProps }: ChatWithUsButtonProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const startSupport = useStartSupportConversation();

  const handleClick = async () => {
    if (!user) {
      toast.info("Sign in to chat with us");
      navigate(`/auth?redirect=${encodeURIComponent(location.pathname)}`);
      return;
    }
    try {
      const conversationId = await startSupport.mutateAsync(productId);
      navigate(`/messages/${conversationId}`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not open chat");
    }
  };

  return (
    <Button {...buttonProps} onClick={handleClick} disabled={startSupport.isPending || buttonProps.disabled}>
      {startSupport.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Headset className="mr-2 h-4 w-4" />}
      {label}
    </Button>
  );
}
