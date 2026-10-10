import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { MessageCircle } from "lucide-react";
import { MobileLayout } from "@/components/layout/MobileLayout";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useConversations } from "@/hooks/useChat";
import { ChatWithUsButton } from "@/components/chat/ChatWithUsButton";
import { cn } from "@/lib/utils";

export default function Messages() {
  const { user, isLoading: authLoading, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { conversations, isLoading } = useConversations();

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth?redirect=/messages");
  }, [authLoading, user, navigate]);

  return (
    <MobileLayout>
      <div className="px-4 py-6 pb-24">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h1 className="font-display text-xl font-bold">Messages</h1>
          {!isAdmin && <ChatWithUsButton size="sm" variant="outline" label="Chat with us" />}
        </div>

        {isLoading || authLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center text-muted-foreground">
            <MessageCircle className="mb-3 h-12 w-12 opacity-50" />
            <p>No messages yet.</p>
            <p className="text-sm">Questions, or want us to buy something for you? Chat with the Kano Kaftan team.</p>
            <ChatWithUsButton className="mt-4" label="Chat with Kano Kaftan" />
            <Button asChild variant="outline" className="mt-2">
              <Link to="/shops">Browse shops</Link>
            </Button>
          </div>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link to={`/messages/${c.id}`} className="flex items-center gap-3 p-3 hover:bg-muted/50">
                  <Avatar className="h-11 w-11">
                    <AvatarImage src={c.other_party_avatar || undefined} alt="" />
                    <AvatarFallback>{c.other_party_name.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className={cn("truncate", c.unread ? "font-semibold" : "font-medium")}>
                        {c.other_party_name}
                        {c.role === "vendor" && <span className="ml-1 text-xs font-normal text-muted-foreground">(customer)</span>}
                        {c.role === "support_team" && (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            (support · {c.other_party_is_vendor ? "vendor" : "customer"})
                          </span>
                        )}
                      </p>
                      {c.last_message_at && (
                        <span className="flex-shrink-0 text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(c.last_message_at), { addSuffix: false })}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <p className={cn("truncate text-sm", c.unread ? "text-foreground" : "text-muted-foreground")}>
                        {c.last_message_preview}
                      </p>
                      {c.unread && <span className="h-2 w-2 flex-shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </MobileLayout>
  );
}
