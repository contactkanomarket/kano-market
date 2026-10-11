import { useRef, useState } from "react";

/** How far (px) a message must be dragged to the right to start a reply. */
const TRIGGER_PX = 64;
/** The bubble follows the finger up to this far, then stops. */
const MAX_DRAG_PX = 90;
/** Movement before deciding whether the gesture is a sideways swipe or a scroll. */
const DECIDE_PX = 8;

/**
 * Swipe a message to the right to reply (like WhatsApp). Touch only; a vertical
 * movement is left to the page scroll. Returns the drag offset and pointer handlers.
 */
export function useSwipeToReply(onReply: () => void) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number; mode: "undecided" | "swipe" | "scroll" } | null>(null);
  const triggered = useRef(false);

  const reset = () => {
    start.current = null;
    triggered.current = false;
    setOffset(0);
  };

  return {
    offset,
    progress: Math.min(1, offset / TRIGGER_PX),
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === "mouse") return;
        start.current = { x: e.clientX, y: e.clientY, mode: "undecided" };
        triggered.current = false;
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = start.current;
        if (!s || s.mode === "scroll") return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (s.mode === "undecided") {
          if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
          s.mode = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5 ? "swipe" : "scroll";
          if (s.mode === "scroll") return;
        }
        const next = Math.max(0, Math.min(MAX_DRAG_PX, dx));
        setOffset(next);
        if (next >= TRIGGER_PX && !triggered.current) {
          triggered.current = true;
          navigator.vibrate?.(10);
        }
      },
      onPointerUp: () => {
        const fire = triggered.current;
        reset();
        if (fire) onReply();
      },
      onPointerCancel: reset,
    },
  };
}
