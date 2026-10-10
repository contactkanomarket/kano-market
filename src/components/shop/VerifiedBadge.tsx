import { BadgeCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/** Blue "verified seller" tick, used everywhere a verified shop is shown. */
export function VerifiedBadge({ className, label = "Verified seller" }: { className?: string; label?: string }) {
  return (
    <BadgeCheck
      role="img"
      aria-label={label}
      className={cn("h-4 w-4 flex-shrink-0 fill-[#1D9BF0] text-white", className)}
    />
  );
}
