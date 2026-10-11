import { useEffect, useState } from "react";
import { Copy, Plus } from "lucide-react";
import type { MessageReaction } from "@/hooks/useChat";
import { cn } from "@/lib/utils";

const QUICK_REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "🙏"];
const MORE_REACTIONS = [
  "🔥", "👏", "🎉", "😍", "🥰", "😊", "😁", "🤣", "😅", "😎", "🤩", "😇",
  "🤔", "😐", "🙄", "😴", "😡", "😭", "😱", "🤯", "👌", "✌️", "🤝", "💪",
  "👀", "💯", "✅", "❌", "💔", "💖", "🌹", "🛍️", "👗", "🧵", "💸", "🇳🇬",
];

/** Emoji bar shown above (or below) a message after a long press. */
export function ReactionPicker({
  mine,
  current,
  onPick,
  onCopy,
  onClose,
}: {
  mine: boolean;
  current: string | null;
  onPick: (emoji: string | null) => void;
  onCopy?: () => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = (emoji: string) => onPick(emoji === current ? null : emoji);

  return (
    <>
      {/* Tap anywhere else to close */}
      <button type="button" aria-label="Close reactions" className="fixed inset-0 z-40 cursor-default bg-black/10" onClick={onClose} />
      <div
        role="menu"
        aria-label="React to message"
        className={cn(
          "absolute bottom-full z-50 mb-2 w-max max-w-[min(20rem,calc(100vw-2rem))] rounded-2xl border bg-popover p-1.5 shadow-xl animate-in fade-in-0 zoom-in-95 duration-150",
          mine ? "right-0" : "left-0",
        )}
      >
        <div className="flex items-center gap-0.5">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitemradio"
              aria-checked={current === emoji}
              aria-label={`React ${emoji}`}
              onClick={() => pick(emoji)}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-full text-2xl transition-transform hover:scale-125 active:scale-95",
                current === emoji && "bg-primary/15",
              )}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            aria-label="More reactions"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-foreground"
          >
            <Plus className={cn("h-5 w-5 transition-transform", expanded && "rotate-45")} />
          </button>
        </div>
        {expanded && (
          <div className="mt-1 grid max-h-44 grid-cols-6 gap-0.5 overflow-y-auto border-t pt-1.5">
            {MORE_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React ${emoji}`}
                onClick={() => pick(emoji)}
                className={cn("flex h-10 items-center justify-center rounded-lg text-xl hover:bg-muted", current === emoji && "bg-primary/15")}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            className="mt-1 flex w-full items-center gap-2 rounded-lg border-t px-2 pb-1 pt-2 text-sm text-foreground hover:bg-muted"
          >
            <Copy className="h-4 w-4" /> Copy text
          </button>
        )}
      </div>
    </>
  );
}

/** Small chips under a message: each emoji with a count; tap to add or remove yours. */
export function ReactionChips({
  reactions,
  userId,
  mine,
  onToggle,
}: {
  reactions: MessageReaction[];
  userId: string | null;
  mine: boolean;
  onToggle: (emoji: string) => void;
}) {
  if (reactions.length === 0) return null;
  const groups = new Map<string, { count: number; byMe: boolean }>();
  for (const r of reactions) {
    const g = groups.get(r.emoji) ?? { count: 0, byMe: false };
    g.count += 1;
    g.byMe ||= r.user_id === userId;
    groups.set(r.emoji, g);
  }
  return (
    <div className={cn("-mt-1.5 flex flex-wrap gap-1", mine ? "justify-end pr-2" : "justify-start pl-2")}>
      {[...groups.entries()].map(([emoji, g]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle(emoji)}
          aria-label={`${emoji} ${g.count}${g.byMe ? ", including you. Tap to remove" : ". Tap to react"}`}
          className={cn(
            "relative z-10 flex h-6 items-center gap-0.5 rounded-full border bg-background px-1.5 text-sm shadow-sm transition-transform active:scale-95",
            g.byMe && "border-primary/40 bg-primary/10",
          )}
        >
          <span>{emoji}</span>
          {g.count > 1 && <span className="text-[11px] font-medium text-muted-foreground">{g.count}</span>}
        </button>
      ))}
    </div>
  );
}
