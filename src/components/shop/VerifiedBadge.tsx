import { BadgeCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export type VerificationTier = "blue" | "gold";

const TIER_STYLE: Record<VerificationTier, { fill: string; label: string }> = {
  blue: { fill: "fill-[#1D9BF0]", label: "Verified seller" },
  gold: { fill: "fill-[#9A7400]", label: "Top seller (gold)" },
};

/** Verified tick: blue for verified sellers, gold for top-tier sellers. */
export function VerifiedBadge({ className, label, tier }: { className?: string; label?: string; tier?: string | null }) {
  const style = TIER_STYLE[tier === "gold" ? "gold" : "blue"];
  return (
    <BadgeCheck
      role="img"
      aria-label={label ?? style.label}
      className={cn("h-4 w-4 flex-shrink-0 text-white", style.fill, className)}
    />
  );
}
