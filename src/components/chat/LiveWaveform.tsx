import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const BAR_COUNT = 28;
const MIN_SCALE = 0.12;
/** Sound level is sampled this often; bars scroll left like a recorder. */
const SAMPLE_MS = 90;

/** Scrolling bars that follow the microphone level while recording. */
export function LiveWaveform({ stream, className }: { stream: MediaStream | null; className?: string }) {
  const barsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = barsRef.current;
    if (!stream || !container) return;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = Array(BAR_COUNT).fill(MIN_SCALE);
    const bars = Array.from(container.children) as HTMLElement[];

    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / samples.length);
      levels.shift();
      levels.push(Math.max(MIN_SCALE, Math.min(1, rms * 4.5)));
      bars.forEach((bar, i) => (bar.style.transform = `scaleY(${levels[i]})`));
    }, SAMPLE_MS);

    return () => {
      window.clearInterval(timer);
      source.disconnect();
      ctx.close().catch(() => undefined);
    };
  }, [stream]);

  return (
    <div ref={barsRef} className={cn("flex h-7 items-center gap-[3px]", className)} aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          className="h-full w-[3px] flex-1 origin-center rounded-full bg-red-500/80 transition-transform duration-100"
          style={{ transform: `scaleY(${MIN_SCALE})` }}
        />
      ))}
    </div>
  );
}
