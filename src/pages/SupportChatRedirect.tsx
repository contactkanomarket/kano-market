import { useEffect, useRef } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useStartSupportConversation } from "@/hooks/useChat";

/** /chat (older links): opens the user's chat with the Kano Market team. */
export default function SupportChatRedirect() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const startSupport = useStartSupportConversation();
  const started = useRef(false);

  useEffect(() => {
    if (!user || started.current) return;
    started.current = true;
    startSupport
      .mutateAsync(params.get("product") ?? undefined)
      .then((id) => navigate(`/messages/${id}`, { replace: true }))
      .catch(() => navigate("/messages", { replace: true }));
  }, [user, params, navigate, startSupport]);

  if (!isLoading && !user) return <Navigate to="/auth?redirect=/chat" replace />;

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  );
}
