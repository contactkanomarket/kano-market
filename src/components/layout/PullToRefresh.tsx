import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

const TRIGGER_DISTANCE = 70; // px the finger must pull (after resistance) to refresh
const MAX_PULL = 110;

/** Installed (home-screen) apps don't get the browser's pull-to-refresh, so add our own. */
function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

/** True when the touch started inside something that scrolls on its own (chat, lists, dialogs). */
function startsInScrolledArea(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    if (el.closest("[role='dialog'], [data-no-pull-refresh]")) return true;
    const style = window.getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight && el.scrollTop > 0) return true;
    el = el.parentElement;
  }
  return false;
}

export function PullToRefresh() {
  const [enabled] = useState(isInstalledApp);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pullRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const onStart = (e: TouchEvent) => {
      if (refreshing || window.scrollY > 0 || e.touches.length !== 1 || startsInScrolledArea(e.target)) {
        startY.current = null;
        return;
      }
      startY.current = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0 || window.scrollY > 0) {
        pullRef.current = 0;
        setPull(0);
        return;
      }
      const distance = Math.min(MAX_PULL, dy * 0.5);
      pullRef.current = distance;
      setPull(distance);
      if (distance > 8 && e.cancelable) e.preventDefault(); // stop the page bouncing while pulling
    };

    const onEnd = () => {
      if (startY.current === null) return;
      startY.current = null;
      if (pullRef.current >= TRIGGER_DISTANCE) {
        setRefreshing(true);
        setPull(TRIGGER_DISTANCE);
        // A full reload also picks up a new version of the app if one was deployed.
        window.setTimeout(() => window.location.reload(), 150);
      } else {
        setPull(0);
      }
      pullRef.current = 0;
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, refreshing]);

  if (!enabled || (pull === 0 && !refreshing)) return null;

  const ready = pull >= TRIGGER_DISTANCE;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center"
      style={{ transform: `translateY(calc(env(safe-area-inset-top, 0px) + ${pull - 40}px))` }}
      aria-live="polite"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full border bg-background shadow-md">
        <RefreshCw
          className={cn("h-5 w-5 text-primary transition-transform", refreshing && "animate-spin")}
          style={refreshing ? undefined : { transform: `rotate(${pull * 3}deg)`, opacity: ready ? 1 : 0.6 }}
        />
        <span className="sr-only">{refreshing ? "Refreshing" : ready ? "Release to refresh" : "Pull to refresh"}</span>
      </div>
    </div>
  );
}
