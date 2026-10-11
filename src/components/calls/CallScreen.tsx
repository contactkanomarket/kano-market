import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, RefreshCcw, Video, VideoOff } from "lucide-react";
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
    case "incoming": return view.kind === "video" ? "Incoming video call" : "Incoming voice call";
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
        className={cn("flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-transform active:scale-95 sm:h-16 sm:w-16", className)}
      >
        {children}
      </button>
      <span className="text-xs text-white/80">{label}</span>
    </div>
  );
}

/** Plays a stream in a <video> (or hidden <audio> for voice-only). */
function useStreamElement<T extends HTMLMediaElement>(stream: MediaStream | null) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) el.play().catch((e) => console.warn("[calls] media did not autoplay", e));
  }, [stream]);
  return ref;
}

/** Full-screen call: ringing, connecting, in call (voice or video) and the brief "ended" state. */
export function CallScreen({
  view,
  remoteStream,
  localStream,
  onAccept,
  onHangUp,
  onToggleMute,
  onToggleCamera,
  onFlipCamera,
}: {
  view: CallView;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  onAccept: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onFlipCamera: () => void;
}) {
  const elapsed = useElapsed(view.startedAt);
  const isVideo = view.kind === "video";
  const remoteVideoRef = useStreamElement<HTMLVideoElement>(isVideo ? remoteStream : null);
  const remoteAudioRef = useStreamElement<HTMLAudioElement>(isVideo ? null : remoteStream);
  const localVideoRef = useStreamElement<HTMLVideoElement>(isVideo ? localStream : null);

  const ended = view.phase === "ended";
  const ringing = view.phase === "incoming" || view.phase === "outgoing";
  const hasLocalVideo = !!localStream?.getVideoTracks().length;
  const showRemoteVideo = isVideo && view.phase === "active" && view.remoteCameraOn && !!remoteStream?.getVideoTracks().length;
  // Before the call connects, a video caller sees themselves full screen (like a mirror).
  const localFullScreen = isVideo && hasLocalVideo && view.cameraOn && (view.phase === "outgoing" || view.phase === "connecting");

  return (
    <div
      role="dialog"
      aria-label={`${isVideo ? "Video" : "Voice"} call with ${view.peerName}`}
      data-no-pull-refresh
      className="fixed inset-0 z-[200] overflow-hidden bg-gradient-to-b from-[#1c1410] via-[#2A0800] to-black text-white animate-in fade-in-0 duration-200"
    >
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {/* Remote video fills the screen */}
      {isVideo && (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className={cn("absolute inset-0 h-full w-full bg-black object-cover transition-opacity", showRemoteVideo ? "opacity-100" : "opacity-0")}
        />
      )}

      {/* Own camera: full screen while ringing, small corner preview once connected */}
      {isVideo && hasLocalVideo && !ended && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className={cn(
            "absolute bg-black object-cover transition-all duration-300",
            view.frontCamera && "-scale-x-100",
            localFullScreen
              ? "inset-0 h-full w-full opacity-60"
              : "right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] h-40 w-28 rounded-2xl border border-white/20 shadow-xl sm:h-48 sm:w-36",
            !view.cameraOn && "opacity-0",
          )}
        />
      )}

      <div className="relative flex h-full flex-col items-center justify-between px-6 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-[calc(env(safe-area-inset-top)+3rem)]">
        {/* Name and status (compact over live video) */}
        {showRemoteVideo ? (
          <div className="self-start rounded-2xl bg-black/35 px-3 py-2 backdrop-blur-sm">
            <p className="text-sm font-semibold">{view.peerName}</p>
            <p className="font-mono text-xs text-white/80">{statusText(view, elapsed)}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 text-center">
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-white/80">
              {isVideo ? "HD VIDEO" : "HD VOICE"}
            </span>
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
              {isVideo && view.phase === "active" && !view.remoteCameraOn && (
                <p className="mt-1 text-xs text-white/60">Camera is off</p>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col items-center gap-4">
          {view.phase === "active" && view.route && (
            <span className="rounded-full bg-black/30 px-2.5 py-0.5 text-[11px] text-white/70">
              {view.route === "direct" ? "Direct connection" : "Via relay server"}
            </span>
          )}

          {!ended && (
            <div className="flex items-end justify-center gap-5 sm:gap-8">
              {view.phase === "incoming" ? (
                <>
                  <RoundButton label="Decline" onClick={onHangUp} className="bg-red-500 hover:bg-red-600">
                    <PhoneOff className="h-7 w-7" />
                  </RoundButton>
                  <RoundButton label="Accept" onClick={onAccept} className="bg-green-500 hover:bg-green-600">
                    {isVideo ? <Video className="h-7 w-7" /> : <Phone className="h-7 w-7" />}
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
                  {isVideo && hasLocalVideo && (
                    <>
                      <RoundButton
                        label={view.cameraOn ? "Camera off" : "Camera on"}
                        onClick={onToggleCamera}
                        className={view.cameraOn ? "bg-white/15 hover:bg-white/25" : "bg-white text-black"}
                      >
                        {view.cameraOn ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6" />}
                      </RoundButton>
                      <RoundButton label="Flip" onClick={onFlipCamera} className="bg-white/15 hover:bg-white/25">
                        <RefreshCcw className="h-6 w-6" />
                      </RoundButton>
                    </>
                  )}
                  <RoundButton label="End" onClick={onHangUp} className="bg-red-500 hover:bg-red-600">
                    <PhoneOff className="h-7 w-7" />
                  </RoundButton>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
