import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/** Dark gold, matching the gold seller badge. */
const GOLD_RING = "bg-[conic-gradient(from_210deg,#5C4300,#9A7400,#E2B93B,#9A7400,#5C4300)]";
const NEW_RING = "bg-gradient-to-tr from-primary via-primary/80 to-primary/50";
const SEEN_RING = "bg-muted-foreground/30";

export type StoryRingState = "gold" | "new" | "seen";

export function storyRingState(tier: string | null | undefined, allSeen: boolean): StoryRingState {
  if (tier === "gold") return "gold"; // gold sellers keep their gold ring even once seen
  return allSeen ? "seen" : "new";
}

/**
 * A round picture with a story ring around it. Links to the seller's stories
 * when `vendorId` is given; otherwise it is just the picture.
 */
export function StoryRing({
  vendorId,
  state,
  size = 64,
  label,
  className,
  children,
}: {
  vendorId?: string | null;
  state: StoryRingState | null;
  /** Outer size in px. */
  size?: number;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const ringWidth = size >= 80 ? 3 : 2.5;
  const inner = (
    <span
      className={cn(
        "relative block shrink-0 rounded-full",
        state === "gold" ? GOLD_RING : state === "new" ? NEW_RING : state === "seen" ? SEEN_RING : "",
        state && "transition-transform active:scale-95",
        className,
      )}
      style={{ width: size, height: size, padding: state ? ringWidth : 0 }}
    >
      <span className={cn("block h-full w-full overflow-hidden rounded-full bg-card", state && "border-2 border-background")}>{children}</span>
    </span>
  );
  if (!vendorId || !state) return inner;
  return (
    <Link to={`/stories/${vendorId}`} aria-label={label ?? "View story"} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {inner}
    </Link>
  );
}
