import { useCallback, useEffect, useRef, useState } from "react";
import { Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { savePhoto } from "@/lib/savePhoto";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 280;
const WHEEL_STEP = 0.0015;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

function clampScale(scale: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Full-screen photo with pinch / double-tap / wheel zoom, drag to pan, and Save. */
export function ImageLightbox({ src, alt = "", onClose }: { src: string; alt?: string; onClose: () => void }) {
  const [t, setT] = useState<Transform>(IDENTITY);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number; mid: { x: number; y: number }; origin: Transform } | null>(null);
  const drag = useRef<{ x: number; y: number; origin: Transform; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  /** Zoom to `scale` keeping the screen point (px, py) under the finger. */
  const zoomAt = useCallback((scale: number, px: number, py: number, from: Transform) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const cx = rect ? px - (rect.left + rect.width / 2) : 0;
    const cy = rect ? py - (rect.top + rect.height / 2) : 0;
    const next = clampScale(scale);
    if (next === 1) return IDENTITY;
    const ratio = next / from.scale;
    return { scale: next, x: cx - (cx - from.x) * ratio, y: cy - (cy - from.y) * ratio };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: t.scale,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        origin: t,
      };
      drag.current = null;
    } else {
      drag.current = { x: e.clientX, y: e.clientY, origin: t, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const g = gesture.current;
      setT(zoomAt(g.scale * (dist / g.dist), g.mid.x, g.mid.y, g.origin));
    } else if (drag.current) {
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
      if (drag.current.origin.scale > 1) {
        setT({ ...drag.current.origin, x: drag.current.origin.x + dx, y: drag.current.origin.y + dy });
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || pointers.current.size > 0) return;
    // A tap: double tap zooms in/out; a single tap on the dark area closes when not zoomed.
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      setT((cur) => (cur.scale > 1 ? IDENTITY : zoomAt(DOUBLE_TAP_SCALE, e.clientX, e.clientY, cur)));
    } else {
      lastTap.current = now;
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    setT((cur) => zoomAt(cur.scale * (1 - e.deltaY * WHEEL_STEP * 2), e.clientX, e.clientY, cur));
  };

  const zoomBy = (factor: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const px = rect ? rect.left + rect.width / 2 : 0;
    const py = rect ? rect.top + rect.height / 2 : 0;
    setT((cur) => zoomAt(cur.scale * factor, px, py, cur));
  };

  const save = async () => {
    try {
      await savePhoto(src);
    } catch (error) {
      console.error("[lightbox] save failed", error);
      toast.error("Could not save the photo");
    }
  };

  const zoomed = t.scale > 1;

  return (
    <div className="fixed inset-0 z-[150] flex flex-col bg-black/95 animate-in fade-in-0 duration-200" role="dialog" aria-modal="true" aria-label="Photo" data-no-pull-refresh>
      <div className="relative z-10 flex items-center justify-end gap-2 p-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <button type="button" onClick={() => zoomBy(1 / 1.5)} disabled={!zoomed} aria-label="Zoom out" className="rounded-full bg-white/15 p-2.5 text-white backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-40">
          <ZoomOut className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => zoomBy(1.5)} disabled={t.scale >= MAX_SCALE} aria-label="Zoom in" className="rounded-full bg-white/15 p-2.5 text-white backdrop-blur transition-colors hover:bg-white/25 disabled:opacity-40">
          <ZoomIn className="h-5 w-5" />
        </button>
        <button type="button" onClick={save} aria-label="Save photo" className="rounded-full bg-white/15 p-2.5 text-white backdrop-blur transition-colors hover:bg-white/25">
          <Download className="h-5 w-5" />
        </button>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-full bg-white/15 p-2.5 text-white backdrop-blur transition-colors hover:bg-white/25">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div
        ref={stageRef}
        className="relative flex flex-1 touch-none select-none items-center justify-center overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-h-full max-w-full object-contain will-change-transform"
          style={{
            transform: `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`,
            transition: gesture.current || drag.current ? "none" : "transform 0.2s ease-out",
          }}
        />
      </div>
      <p className="pb-[calc(env(safe-area-inset-bottom)+0.75rem)] text-center text-xs text-white/50">
        {zoomed ? "Drag to look around · double-tap to zoom out" : "Pinch or double-tap to zoom"}
      </p>
    </div>
  );
}
