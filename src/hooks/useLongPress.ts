import { useCallback, useEffect, useRef } from "react";

/** How long a finger must rest on a message to open reactions. */
const LONG_PRESS_MS = 450;
/** Moving more than this cancels the long press (the person is scrolling). */
const MOVE_TOLERANCE_PX = 10;

/**
 * Long-press on touch screens; right-click or double-click with a mouse.
 * Returns props to spread on the element.
 */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | undefined>();
  const start = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    start.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        navigator.vibrate?.(15);
        onLongPress();
        start.current = null;
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start.current) return;
      if (Math.abs(e.clientX - start.current.x) > MOVE_TOLERANCE_PX || Math.abs(e.clientY - start.current.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      cancel();
      onLongPress();
    },
    onDoubleClick: () => onLongPress(),
  };
}
