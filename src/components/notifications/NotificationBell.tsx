import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, Trash2, Package, CreditCard, AlertCircle, Info, Star, Megaphone, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useNotifications, Notification } from "@/hooks/useNotifications";
import { formatDistanceToNow } from "date-fns";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

const categoryIcons: Record<string, React.ElementType> = {
  order: Package,
  payment: CreditCard,
  product: Package,
  review: Star,
  system: AlertCircle,
  promotion: Megaphone,
  general: MessageCircle,
};

const typeColors: Record<string, string> = {
  info: "bg-blue-100 text-blue-600",
  success: "bg-green-100 text-green-600",
  warning: "bg-yellow-100 text-yellow-600",
  order: "bg-primary/10 text-primary",
  payment: "bg-emerald-100 text-emerald-600",
  system: "bg-muted text-muted-foreground",
};

interface NotificationItemProps {
  notification: Notification;
  isNew: boolean;
  onMarkAsRead: (id: string) => void;
  onDelete: (id: string) => void;
  onNavigate: (url: string | null) => void;
}

function NotificationItem({ notification, isNew, onMarkAsRead, onDelete, onNavigate }: NotificationItemProps) {
  const Icon = categoryIcons[notification.category] || Info;

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "group relative flex items-start gap-3 border-b px-4 py-3 last:border-b-0 transition-colors cursor-pointer hover:bg-muted/50 active:bg-muted",
        !notification.is_read && "bg-primary/[0.04]",
        isNew && "animate-in fade-in-0 slide-in-from-top-3 duration-400"
      )}
      onClick={() => {
        if (!notification.is_read) onMarkAsRead(notification.id);
        onNavigate(notification.action_url);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (!notification.is_read) onMarkAsRead(notification.id);
          onNavigate(notification.action_url);
        }
      }}
    >
      <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full", typeColors[notification.type] || typeColors.info)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 pr-5">
        <p className={cn("line-clamp-2 break-words text-sm leading-snug", !notification.is_read ? "font-semibold text-foreground" : "font-medium text-foreground/80")}>
          {notification.title}
        </p>
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
          {notification.message}
        </p>
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          {!notification.is_read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
          {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
        </p>
      </div>
      <button
        type="button"
        aria-label="Delete notification"
        className="absolute right-2 top-2 rounded-full p-1.5 text-muted-foreground/60 transition-opacity hover:bg-muted hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(notification.id);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function NotificationBell() {
  const navigate = useNavigate();
  const {
    notifications,
    unreadCount,
    isLoading,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    clearAll,
  } = useNotifications();

  const [open, setOpen] = useState(false);
  const [isWiggling, setIsWiggling] = useState(false);
  const [badgeKey, setBadgeKey] = useState(0);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const prevCountRef = useRef(unreadCount);
  const prevNotifIdsRef = useRef<Set<string>>(new Set(notifications.map((n) => n.id)));
  // Skip the animation for the first batch loaded from the server
  const hasLoadedRef = useRef(!isLoading && notifications.length > 0);

  // Detect new notifications and trigger animations
  useEffect(() => {
    const currentIds = new Set(notifications.map((n) => n.id));
    const incoming = hasLoadedRef.current
      ? notifications.filter((n) => !prevNotifIdsRef.current.has(n.id))
      : [];
    if (!isLoading) hasLoadedRef.current = true;

    if (incoming.length > 0) {
      // Wiggle bell
      setIsWiggling(true);
      setTimeout(() => setIsWiggling(false), 600);

      // Pop badge
      setBadgeKey((k) => k + 1);

      // Mark incoming as "new" for slide-in animation, clear after 2s
      setNewIds((prev) => {
        const next = new Set(prev);
        incoming.forEach((n) => next.add(n.id));
        return next;
      });
      setTimeout(() => {
        setNewIds((prev) => {
          const next = new Set(prev);
          incoming.forEach((n) => next.delete(n.id));
          return next;
        });
      }, 2000);
    }

    prevNotifIdsRef.current = currentIds;
    prevCountRef.current = unreadCount;
  }, [notifications, unreadCount, isLoading]);

  const handleNavigate = (url: string | null) => {
    if (!url) return;
    setOpen(false);
    navigate(url);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className={cn("h-5 w-5 transition-transform", isWiggling && "animate-wiggle")} />
          {unreadCount > 0 && (
            <span
              key={badgeKey}
              className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center font-bold animate-in zoom-in-50 duration-300"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        collisionPadding={12}
        className="w-[calc(100vw-24px)] max-w-sm overflow-hidden rounded-xl p-0 shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h4 className="whitespace-nowrap text-base font-semibold">Notifications</h4>
            {unreadCount > 0 && (
              <span className="whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium leading-4 text-primary-foreground">
                {unreadCount} new
              </span>
            )}
          </div>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 whitespace-nowrap px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => markAllAsRead.mutate()}
            >
              <CheckCheck className="mr-1 h-3.5 w-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain" data-no-pull-refresh>
          {isLoading ? (
            <div className="space-y-3 p-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex gap-3 animate-pulse">
                  <div className="h-9 w-9 rounded-full bg-muted shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-muted rounded w-3/4" />
                    <div className="h-3 bg-muted rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <div className="p-8 text-center animate-in fade-in-0 duration-300">
              <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
                <Bell className="h-7 w-7 text-muted-foreground/50" />
              </div>
              <p className="text-sm font-medium text-foreground">All caught up!</p>
              <p className="text-xs text-muted-foreground mt-1">No notifications yet</p>
            </div>
          ) : (
            <div>
              {notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  isNew={newIds.has(notification.id)}
                  onMarkAsRead={(id) => markAsRead.mutate(id)}
                  onDelete={(id) => deleteNotification.mutate(id)}
                  onNavigate={handleNavigate}
                />
              ))}
            </div>
          )}
        </div>

        {notifications.length > 0 && (
          <div className="p-2 border-t bg-muted/20">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => clearAll.mutate()}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Clear all
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
