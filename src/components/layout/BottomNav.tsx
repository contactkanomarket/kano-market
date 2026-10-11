import { Link, useLocation } from "react-router-dom";
import { Home, Package, Heart, User, MessageCircle } from "lucide-react";
import { useConversations } from "@/hooks/useChat";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

/** Springy ease for the sliding bubble (slight overshoot, then settles). */
const BUBBLE_EASING = "cubic-bezier(0.34, 1.4, 0.64, 1)";
const BUBBLE_MS = 420;

/** Which tab a page belongs to: exact for home, prefix for the rest (e.g. /orders/123 → Orders). */
function isTabActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Floating glass tab bar. A dark bubble slides to the tab you tap and the
 * icon pops, so moving between pages feels alive.
 */
export function BottomNav() {
  const location = useLocation();
  const { t } = useTranslation();
  const { unreadCount } = useConversations();

  const navItems = [
    { icon: Home, label: t("nav.home"), href: "/" },
    { icon: Package, label: t("nav.orders"), href: "/orders" },
    { icon: MessageCircle, label: t("nav.chat"), href: "/messages" },
    { icon: Heart, label: t("nav.favorites"), href: "/wishlist" },
    { icon: User, label: t("nav.profile"), href: "/profile" },
  ];
  const activeIndex = navItems.findIndex((item) => isTabActive(location.pathname, item.href));

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-50 px-3 pb-[max(0.6rem,env(safe-area-inset-bottom))] pointer-events-none"
    >
      <div className="pointer-events-auto relative mx-auto flex h-[62px] max-w-md items-stretch rounded-full border border-white/50 bg-background/75 p-1 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.35)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-background/70">
        {/* The sliding bubble behind the active tab */}
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-1 left-1 rounded-full bg-primary shadow-[0_6px_16px_-6px_hsl(var(--primary)/0.7)] transition-opacity duration-200",
            activeIndex === -1 && "opacity-0",
          )}
          style={{
            width: `calc((100% - 0.5rem) / ${navItems.length})`,
            transform: `translateX(${Math.max(activeIndex, 0) * 100}%)`,
            transition: `transform ${BUBBLE_MS}ms ${BUBBLE_EASING}, opacity 200ms`,
          }}
        />
        {navItems.map((item, index) => {
          const isActive = index === activeIndex;
          return (
            <Link
              key={item.href}
              to={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative z-10 flex flex-1 flex-col items-center justify-center gap-0.5 rounded-full transition-[color,transform] duration-200 active:scale-90",
                isActive ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="relative">
                {/* Re-mounts when the tab becomes active, so the icon pops each time */}
                <item.icon
                  key={isActive ? "on" : "off"}
                  className={cn("h-[22px] w-[22px]", isActive && "animate-in zoom-in-50 spin-in-[-12deg] duration-300")}
                  strokeWidth={isActive ? 2.4 : 2}
                />
                {item.href === "/messages" && unreadCount > 0 && (
                  <span
                    className={cn(
                      "absolute -right-2.5 -top-1.5 min-w-[17px] rounded-full px-1 text-center text-[10px] font-bold leading-[17px] shadow-sm animate-in zoom-in-50",
                      isActive ? "bg-primary-foreground text-primary" : "bg-red-500 text-white",
                    )}
                  >
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </span>
              <span className={cn("text-[10px] leading-tight", isActive ? "font-semibold" : "font-medium")}>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
