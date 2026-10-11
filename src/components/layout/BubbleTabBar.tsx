import type { LucideIcon } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

/** Springy ease for the sliding bubble (slight overshoot, then settles). */
const BUBBLE_EASING = "cubic-bezier(0.34, 1.4, 0.64, 1)";
const BUBBLE_MS = 420;
/** A very short buzz when switching tabs (Android only; iPhones don't allow it for web apps). */
const TAB_HAPTIC_MS = 8;

export interface TabItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Small number on the icon (e.g. unread chats). */
  badge?: number;
  /** Which page paths count as this tab (default: the href and anything under it). */
  match?: (pathname: string) => boolean;
}

function isTabActive(pathname: string, item: TabItem): boolean {
  if (item.match) return item.match(pathname);
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Index of the tab a page belongs to (-1 if none); used for slide direction too. */
export function activeTabIndex(pathname: string, items: TabItem[]): number {
  return items.findIndex((item) => isTabActive(pathname, item));
}

/**
 * Floating liquid-glass tab bar. A bubble slides to the tab you tap and the
 * icon pops, so moving between pages feels alive.
 */
export function BubbleTabBar({ items, className }: { items: TabItem[]; className?: string }) {
  const { pathname } = useLocation();
  const activeIndex = activeTabIndex(pathname, items);

  return (
    <nav
      aria-label="Main"
      className={cn("pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3 pb-[max(0.6rem,env(safe-area-inset-bottom))]", className)}
    >
      <div className="liquid-glass pointer-events-auto relative mx-auto flex h-[62px] max-w-md items-stretch rounded-full p-1">
        {/* The sliding bubble behind the active tab */}
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-1 left-1 rounded-full bg-primary shadow-[0_6px_16px_-6px_hsl(var(--primary)/0.7),inset_0_1px_0_hsl(0_0%_100%/0.18)]",
            activeIndex === -1 && "opacity-0",
          )}
          style={{
            width: `calc((100% - 0.5rem) / ${items.length})`,
            transform: `translateX(${Math.max(activeIndex, 0) * 100}%)`,
            transition: `transform ${BUBBLE_MS}ms ${BUBBLE_EASING}, opacity 200ms`,
          }}
        />
        {items.map((item, index) => {
          const isActive = index === activeIndex;
          return (
            <Link
              key={item.href}
              to={item.href}
              aria-current={isActive ? "page" : undefined}
              onClick={() => {
                if (!isActive) navigator.vibrate?.(TAB_HAPTIC_MS);
              }}
              className={cn(
                "relative z-10 flex flex-1 flex-col items-center justify-center gap-0.5 rounded-full transition-[color,transform] duration-200 active:scale-90",
                isActive ? "text-primary-foreground" : "text-foreground/70 hover:text-foreground",
              )}
            >
              <span className="relative">
                {/* Re-mounts when the tab becomes active, so the icon pops each time */}
                <item.icon
                  key={isActive ? "on" : "off"}
                  className={cn("h-[22px] w-[22px]", isActive && "animate-in zoom-in-50 spin-in-[-12deg] duration-300")}
                  strokeWidth={isActive ? 2.4 : 2}
                />
                {!!item.badge && item.badge > 0 && (
                  <span
                    className={cn(
                      "absolute -right-2.5 -top-1.5 min-w-[17px] rounded-full px-1 text-center text-[10px] font-bold leading-[17px] shadow-sm animate-in zoom-in-50",
                      isActive ? "bg-primary-foreground text-primary" : "bg-red-500 text-white",
                    )}
                  >
                    {item.badge > 9 ? "9+" : item.badge}
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
