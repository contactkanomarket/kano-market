import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

/** Number of bars in a voice note waveform. */
const BAR_COUNT = 32;
const SPEEDS = [1, 1.5, 2] as const;
const MIN_BAR = 0.12;

const peaksCache = new Map<string, number[]>();

/** Deterministic stand-in bars when the audio can't be decoded (e.g. older iPhones and webm). */
function placeholderPeaks(seed: string): number[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    h = (h * 1103515245 + 12345) | 0;
    const wave = 0.5 + 0.35 * Math.sin(i / 2.3);
    return Math.max(MIN_BAR, Math.min(1, wave * (0.6 + ((h >>> 16) % 100) / 250)));
  });
}

async function decodePeaks(src: string): Promise<number[]> {
  const cached = peaksCache.get(src);
  if (cached) return cached;
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("no audio context");
  const data = await (await fetch(src)).arrayBuffer();
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(data);
    const channel = audio.getChannelData(0);
    const block = Math.max(1, Math.floor(channel.length / BAR_COUNT));
    const peaks: number[] = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      for (let j = 0; j < block; j++) sum += Math.abs(channel[i * block + j] ?? 0);
      peaks.push(sum / block);
    }
    const max = Math.max(...peaks, 0.0001);
    const normalised = peaks.map((p) => Math.max(MIN_BAR, p / max));
    peaksCache.set(src, normalised);
    return normalised;
  } finally {
    ctx.close().catch(() => undefined);
  }
}

const formatTime = (secs: number) => {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
};

/**
 * Voice note player: play/pause, a waveform you can tap to jump to a point,
 * time and playback speed. `tone` matches the bubble it sits in.
 */
export function VoicePlayer({ src, tone = "light", className }: { src: string; tone?: "light" | "dark"; className?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [peaks, setPeaks] = useState<number[]>(() => peaksCache.get(src) ?? placeholderPeaks(src));

  useEffect(() => {
    let cancelled = false;
    decodePeaks(src)
      .then((p) => !cancelled && setPeaks(p))
      .catch(() => !cancelled && setPeaks(placeholderPeaks(src)));
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setCurrent(audio.currentTime);
      if (audio.duration && Number.isFinite(audio.duration)) setProgress(audio.currentTime / audio.duration);
    };
    const onMeta = () => {
      // Recorded webm often reports Infinity until fully read; nudge it to compute the real length.
      if (audio.duration === Infinity) {
        audio.currentTime = 1e7;
        audio.addEventListener("timeupdate", function reset() {
          audio.removeEventListener("timeupdate", reset);
          audio.currentTime = 0;
          setDuration(audio.duration);
        });
      } else {
        setDuration(audio.duration);
      }
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
      setCurrent(0);
    };
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    // Metadata may already be loaded (fast or cached files) before these listeners existed.
    if (audio.readyState >= 1) onMeta();
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
    };
  }, [src]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // Only one voice note plays at a time.
      document.querySelectorAll<HTMLAudioElement>("audio[data-voice-note]").forEach((a) => a !== audio && a.pause());
      audio.play().catch((e) => console.warn("[voice] play failed", e));
    } else {
      audio.pause();
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration || !Number.isFinite(duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setProgress(ratio);
  };

  const cycleSpeed = () => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  };

  const dark = tone === "dark";
  return (
    <div className={cn("flex w-[230px] max-w-full items-center gap-2.5", className)}>
      <audio ref={audioRef} src={src} preload="metadata" data-voice-note />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-sm transition-transform active:scale-90",
          dark ? "bg-white/90 text-primary" : "bg-primary text-primary-foreground",
        )}
      >
        {playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          role="slider"
          aria-label="Voice note position"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          tabIndex={0}
          onClick={seek}
          className="flex h-7 cursor-pointer items-center gap-[2px]"
        >
          {peaks.map((peak, i) => {
            const played = i / peaks.length < progress;
            return (
              <span
                key={i}
                className={cn(
                  "w-[3px] flex-1 rounded-full transition-colors",
                  dark ? (played ? "bg-white" : "bg-white/40") : played ? "bg-primary" : "bg-foreground/20",
                )}
                style={{ height: `${Math.round(peak * 100)}%` }}
              />
            );
          })}
        </div>
        <div className={cn("mt-0.5 flex items-center justify-between text-[10px] tabular-nums", dark ? "text-white/75" : "text-muted-foreground")}>
          <span>{formatTime(playing || current ? current : duration)}</span>
          <button type="button" onClick={cycleSpeed} className={cn("rounded-full px-1.5 font-semibold", dark ? "bg-white/20" : "bg-foreground/10")}>
            {SPEEDS[speedIndex]}×
          </button>
        </div>
      </div>
    </div>
  );
}
