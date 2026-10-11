import { useTranslation } from "react-i18next";
import { Store } from "lucide-react";
import { useStoryRings } from "@/hooks/useStories";
import { StoryRing, storyRingState } from "@/components/stories/StoryRing";
import { VerifiedBadge } from "@/components/shop/VerifiedBadge";

/** Row of sellers with live stories (home page). Hidden when nobody has posted. */
export function StoryStrip() {
  const { t } = useTranslation();
  const { data: rings = [] } = useStoryRings();
  if (rings.length === 0) return null;

  return (
    <section className="py-3" aria-label={t("stories.title", "Stories")}>
      <h2 className="mb-2.5 px-4 font-display text-base font-bold text-foreground">{t("stories.title", "Stories")}</h2>
      <div className="flex gap-3 overflow-x-auto px-4 pb-1 scrollbar-hide">
        {rings.map((ring) => (
          <div key={ring.vendor_id} className="flex w-[72px] shrink-0 flex-col items-center gap-1.5">
            <span className="relative">
              <StoryRing
                vendorId={ring.vendor_id}
                state={storyRingState(ring.verification_tier, ring.all_seen)}
                size={68}
                label={t("stories.viewFrom", { name: ring.store_name, defaultValue: `Story from ${ring.store_name}` })}
              >
                {ring.avatar_url ? (
                  <img src={ring.avatar_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
                    <Store className="h-6 w-6" />
                  </span>
                )}
              </StoryRing>
              {ring.verification_tier && (
                <VerifiedBadge tier={ring.verification_tier} className="absolute -bottom-0.5 -right-0.5 h-5 w-5" />
              )}
            </span>
            <span className="w-full truncate text-center text-[11px] font-medium text-foreground">{ring.store_name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
