import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatDistanceToNowStrict } from "date-fns";
import { Download, Flag, Heart, Loader2, Store, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { useShop } from "@/hooks/useShops";
import { useStoryActions, useStoryRings, useVendorStories } from "@/hooks/useStories";
import { VerifiedBadge } from "@/components/shop/VerifiedBadge";
import { savePhoto } from "@/lib/savePhoto";
import { cn } from "@/lib/utils";
import { ReportDialog } from "@/components/moderation/ReportDialog";

/** How long each photo stays on screen. */
const STORY_DURATION_MS = 6000;
const TICK_MS = 50;
/** Taps on the left part of the screen go back; the rest go forward. */
const BACK_ZONE = 0.3;
/** A press longer than this pauses instead of counting as a tap. */
const HOLD_MS = 220;
/** Dragging down this far closes the viewer. */
const SWIPE_CLOSE_PX = 110;

/** Fresh viewer per seller, so moving to the next seller starts at their first photo. */
export default function StoryViewerPage() {
  const { vendorId } = useParams<{ vendorId: string }>();
  return <StoryViewer key={vendorId} vendorId={vendorId} />;
}

/** Full-screen stories for one seller: tap to skip, hold to pause, like or save. */
function StoryViewer({ vendorId }: { vendorId: string | undefined }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: stories = [], isLoading, isError } = useVendorStories(vendorId);
  const { data: shop } = useShop({ vendorId });
  const { data: rings = [] } = useStoryRings();
  const { markViewed, like } = useStoryActions(vendorId);

  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [held, setHeld] = useState(false);
  /** The story whose photo has finished loading (the timer waits for it). */
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(document.visibilityState !== "visible");
  const [saving, setSaving] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [dragY, setDragY] = useState(0);
  const press = useRef<{ x: number; y: number; at: number } | null>(null);
  const startedAt = useRef(0);
  const elapsedBefore = useRef(0);

  const story = stories[index];
  const loaded = !!story && loadedId === story.id;
  const paused = held || !loaded || hidden || saving || reporting;

  // Start at the first story this person hasn't seen yet.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!firstLoad.current || stories.length === 0) return;
    firstLoad.current = false;
    const firstUnseen = stories.findIndex((s) => !s.seen_by_me);
    setIndex(firstUnseen === -1 ? 0 : firstUnseen);
  }, [stories]);

  const close = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/", { replace: true });
  }, [navigate]);

  /** After the last photo: the next seller with stories, else close. */
  const finish = useCallback(() => {
    const at = rings.findIndex((r) => r.vendor_id === vendorId);
    const next = at >= 0 ? rings.slice(at + 1).find((r) => !r.all_seen) : undefined;
    if (next) navigate(`/stories/${next.vendor_id}`, { replace: true });
    else close();
  }, [rings, vendorId, navigate, close]);

  const goTo = useCallback(
    (next: number) => {
      if (next < 0) {
        setIndex(0);
        setProgress(0);
        elapsedBefore.current = 0;
        startedAt.current = performance.now();
        return;
      }
      if (next >= stories.length) return finish();
      setIndex(next);
    },
    [stories.length, finish],
  );

  // New photo: reset the timer (it starts once the photo has loaded).
  useEffect(() => {
    setProgress(0);
    elapsedBefore.current = 0;
  }, [story?.id]);

  useEffect(() => {
    if (story && loaded) markViewed(story.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- record once per photo shown
  }, [story?.id, loaded]);

  // The progress timer (pauses while held, loading, saving or in the background).
  useEffect(() => {
    if (!story || paused) return;
    startedAt.current = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = elapsedBefore.current + performance.now() - startedAt.current;
      const ratio = Math.min(1, elapsed / STORY_DURATION_MS);
      setProgress(ratio);
      if (ratio >= 1) {
        window.clearInterval(timer);
        goTo(index + 1);
      }
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
      elapsedBefore.current += performance.now() - startedAt.current;
    };
  }, [story, paused, index, goTo]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState !== "visible");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") goTo(index + 1);
      if (e.key === "ArrowLeft") goTo(index - 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [close, goTo, index]);

  // Preload the next photo so it appears instantly.
  useEffect(() => {
    const next = stories[index + 1];
    if (next) new Image().src = next.image_url;
  }, [stories, index]);

  const onPointerDown = (e: React.PointerEvent) => {
    press.current = { x: e.clientX, y: e.clientY, at: Date.now() };
    setHeld(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!press.current) return;
    setDragY(Math.max(0, e.clientY - press.current.y));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    setHeld(false);
    const dy = dragY;
    setDragY(0);
    if (!p) return;
    if (dy > SWIPE_CLOSE_PX) return close();
    const wasTap = Date.now() - p.at < HOLD_MS && Math.abs(e.clientX - p.x) < 12 && dy < 12;
    if (!wasTap) return;
    const rect = e.currentTarget.getBoundingClientRect();
    goTo((e.clientX - rect.left) / rect.width < BACK_ZONE ? index - 1 : index + 1);
  };

  const toggleLike = () => {
    if (!story) return;
    if (!user) {
      toast("Sign in to like stories", { action: { label: "Sign in", onClick: () => navigate(`/auth?redirect=/stories/${vendorId}`) } });
      return;
    }
    if (!story.liked_by_me) navigator.vibrate?.(12);
    like.mutate(
      { storyId: story.id, liked: !story.liked_by_me },
      { onError: (e) => toast.error(e instanceof Error ? e.message : "Could not like this story") },
    );
  };

  const save = async () => {
    if (!story) return;
    setSaving(true);
    try {
      await savePhoto(story.image_url, shop?.store_slug || "story");
    } catch (error) {
      console.error("[stories] save failed", { storyId: story.id, error });
      toast.error("Could not save the photo");
    } finally {
      setSaving(false);
    }
  };

  const shopLink = shop?.store_slug ? `/shop/${shop.store_slug}` : `/vendor/${vendorId}`;

  if (!isLoading && (isError || stories.length === 0)) {
    return (
      <div className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-4 bg-black p-6 text-center text-white">
        <p className="text-lg font-semibold">{isError ? "Could not load this story" : "No live stories right now"}</p>
        <p className="text-sm text-white/60">Stories disappear after 24 hours.</p>
        <div className="flex gap-2">
          <Link to={shopLink} className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">Visit shop</Link>
          <button type="button" onClick={close} className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex select-none flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label={`Stories from ${shop?.store_name ?? "seller"}`}
      data-no-pull-refresh
      style={{ transform: dragY ? `translateY(${dragY}px) scale(${1 - dragY / 2000})` : undefined, opacity: dragY ? 1 - dragY / 600 : 1 }}
    >
      {/* Progress bars + header */}
      <div className="absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/60 to-transparent px-3 pb-6 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <div className="flex gap-1" aria-hidden>
          {stories.map((s, i) => (
            <span key={s.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/35">
              <span
                className="block h-full rounded-full bg-white"
                style={{ width: `${i < index ? 100 : i === index ? progress * 100 : 0}%` }}
              />
            </span>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          <Link to={shopLink} className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-white/40 bg-white/10">
              {shop?.avatar_url ? (
                <img src={shop.avatar_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <Store className="m-2 h-5 w-5" />
              )}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-sm font-semibold">
                <span className="truncate">{shop?.store_name ?? " "}</span>
                {shop?.is_verified && <VerifiedBadge tier={shop.verification_tier} className="h-4 w-4" />}
              </span>
              {story && (
                <span className="block text-[11px] text-white/70">
                  {formatDistanceToNowStrict(new Date(story.created_at), { addSuffix: true })}
                </span>
              )}
            </span>
          </Link>
          {story && user && user.id !== vendorId && (
            <button
              type="button"
              onClick={() => setReporting(true)}
              aria-label="Report this story"
              className="rounded-full p-2 text-white/80 hover:bg-white/10"
            >
              <Flag className="h-5 w-5" />
            </button>
          )}
          <button type="button" onClick={close} aria-label="Close stories" className="rounded-full p-2 hover:bg-white/10">
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Photo; tap left/right to move, hold to pause, drag down to close */}
      <div
        className="relative flex flex-1 touch-none items-center justify-center overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
          setHeld(false);
          setDragY(0);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {story && (
          <img
            key={story.id}
            src={story.image_url}
            alt={story.caption ?? "Story photo"}
            draggable={false}
            onLoad={() => setLoadedId(story.id)}
            onError={() => {
              console.error("[stories] photo failed to load", story.id);
              setLoadedId(story.id); // don't get stuck; move on after the usual time
            }}
            className={cn("max-h-full max-w-full object-contain transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
          />
        )}
        {(!story || !loaded) && <Loader2 className="absolute h-8 w-8 animate-spin text-white/70" />}
      </div>

      {/* Caption + actions */}
      <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/70 to-transparent px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-10">
        {story?.caption && <p className="mb-3 whitespace-pre-wrap break-words text-[15px] leading-snug drop-shadow">{story.caption}</p>}
        <div className="flex items-center gap-2">
          <Link to={shopLink} className="flex-1 rounded-full border border-white/40 bg-white/10 px-4 py-2.5 text-center text-sm font-semibold backdrop-blur hover:bg-white/20">
            Visit shop
          </Link>
          <button
            type="button"
            onClick={toggleLike}
            aria-pressed={!!story?.liked_by_me}
            aria-label={story?.liked_by_me ? "Unlike" : "Like"}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-2.5 backdrop-blur transition-transform active:scale-90 hover:bg-white/20"
          >
            <Heart className={cn("h-6 w-6 transition-colors", story?.liked_by_me && "fill-red-500 text-red-500")} />
            {!!story?.like_count && <span className="text-sm font-semibold tabular-nums">{story.like_count}</span>}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            aria-label="Save photo"
            className="rounded-full bg-white/10 p-2.5 backdrop-blur hover:bg-white/20 disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-6 w-6 animate-spin" /> : <Download className="h-6 w-6" />}
          </button>
        </div>
      </div>
      <ReportDialog open={reporting} onOpenChange={setReporting} targetType="story" targetId={story?.id ?? null} />
    </div>
  );
}
