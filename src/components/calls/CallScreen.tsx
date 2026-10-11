import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { CallView } from "@/contexts/CallContext";
import { cn } from "@/lib/utils";

function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(h ? 2 : 1, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function statusText(view: CallView, elapsed: string | null): string {
  switch (view.phase) {
    case "outgoing": return "Ringing…";
    case "incoming": return "Incoming voice call";
    case "connecting": return "Connecting…";
    case "active": return view.connection === "reconnecting" ? "Reconnecting…" : elapsed ?? "00:00";
    case "ended": return view.endedText ?? "Call ended";
    default: return "";
  }
}

function RoundButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn("flex h-16 w-16 items-center justify-center rounded-full shadow-lg transition-transform active:scale-95", className)}
      >
        {children}
      </button>
      <span className="text-xs text-white/80">{label}</span>
    </div>
  );
}

/** Full-screen voice call: ringing, connecting, in call and the brief "ended" state. */
export function CallScreen({
  view,
  remoteStream,
  onAccept,
  onHangUp,
  onToggleMute,
}: {
  view: CallView;
  remoteStream: MediaStream | null;
  onAccept: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const elapsed = useElapsed(view.startedAt);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = remoteStream;
    if (remoteStream) audio.play().catch((e) => console.warn("[calls] remote audio did not autoplay", e));
  }, [remoteStream]);

  const ended = view.phase === "ended";
  const ringing = view.phase === "incoming" || view.phase === "outgoing";

  return (
    <div
      role="dialog"
      aria-label={`Voice call with ${view.peerName}`}
      data-no-pull-refresh
      className="fixed inset-0 z-[200] flex flex-col items-center justify-between bg-gradient-to-b from-[#1c1410] via-[#2A0800] to-black px-6 pb-[calc(env(safe-area-inset-bottom)+2.5rem)] pt-[calc(env(safe-area-inset-top)+3.5rem)] text-white animate-in fade-in-0 duration-200"
    >
      <audio ref={audioRef} autoPlay playsInline />

      <div className="flex flex-col items-center gap-4 text-center">
        <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-white/80">HD VOICE</span>
        <div className="relative">
          {ringing && <span className="absolute inset-0 animate-ping rounded-full bg-white/15" />}
          <Avatar className="relative h-28 w-28 border-2 border-white/20">
            <AvatarImage src={view.peerAvatar || undefined} alt="" />
            <AvatarFallback className="bg-white/10 text-4xl text-white">{view.peerName.charAt(0) || "?"}</AvatarFallback>
          </Avatar>
        </div>
        <div>
          <h2 className="text-2xl font-semibold">{view.peerName}</h2>
          <p className={cn("mt-1 text-sm text-white/70", view.phase === "active" && "font-mono text-base text-white/90")}>
            {statusText(view, elapsed)}
          </p>
        </div>
      </div>

      {!ended && (
        <div className="flex items-end justify-center gap-10">
          {view.phase === "incoming" ? (
            <>
              <RoundButton label="Decline" onClick={onHangUp} className="bg-red-500 hover:bg-red-600">
                <PhoneOff className="h-7 w-7" />
              </RoundButton>
              <RoundButton label="Accept" onClick={onAccept} className="bg-green-500 hover:bg-green-600">
                <Phone className="h-7 w-7" />
              </RoundButton>
            </>
          ) : (
            <>
              <RoundButton
                label={view.muted ? "Unmute" : "Mute"}
                onClick={onToggleMute}
                className={view.muted ? "bg-white text-black" : "bg-white/15 hover:bg-white/25"}
              >
                {view.muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
              </RoundButton>
              <RoundButton label="End" onClick={onHangUp} className="bg-red-500 hover:bg-red-600">
                <PhoneOff className="h-7 w-7" />
              </RoundButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}
