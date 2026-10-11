// Ring sounds made with Web Audio (no files to download).
//   ringback: what the caller hears while the other phone rings (Nigerian-style double ring)
//   ringtone: what the person being called hears

type ToneKind = "ringback" | "ringtone";

const RINGBACK = { freqs: [400, 450], bursts: [0.4, 0.2, 0.4], gap: 2, volume: 0.08 };
const RINGTONE_NOTES = [659.25, 783.99, 987.77, 783.99]; // E5 G5 B5 G5
const RINGTONE = { noteLength: 0.18, gap: 1.2, volume: 0.12 };
const VIBRATE_PATTERN = [400, 200, 400, 1200];

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    context ??= new Ctx();
    if (context.state === "suspended") context.resume().catch(() => undefined);
    return context;
  } catch {
    return null;
  }
}

function beep(ctx: AudioContext, freqs: number[], start: number, length: number, volume: number) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.02);
  gain.gain.setValueAtTime(volume, start + length - 0.03);
  gain.gain.linearRampToValueAtTime(0, start + length);
  gain.connect(ctx.destination);
  for (const freq of freqs) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + length);
  }
}

function playCycle(ctx: AudioContext, kind: ToneKind): number {
  const now = ctx.currentTime + 0.05;
  if (kind === "ringback") {
    beep(ctx, RINGBACK.freqs, now, RINGBACK.bursts[0], RINGBACK.volume);
    beep(ctx, RINGBACK.freqs, now + RINGBACK.bursts[0] + RINGBACK.bursts[1], RINGBACK.bursts[2], RINGBACK.volume);
    return RINGBACK.bursts.reduce((a, b) => a + b, 0) + RINGBACK.gap;
  }
  RINGTONE_NOTES.forEach((freq, i) => beep(ctx, [freq], now + i * RINGTONE.noteLength, RINGTONE.noteLength * 0.9, RINGTONE.volume));
  return RINGTONE_NOTES.length * RINGTONE.noteLength + RINGTONE.gap;
}

/** Starts a repeating ring; returns a function that stops it. */
export function startTone(kind: ToneKind): () => void {
  const ctx = audioContext();
  let timer: number | undefined;
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    if (kind === "ringtone") navigator.vibrate?.(VIBRATE_PATTERN);
    const seconds = ctx ? playCycle(ctx, kind) : 2;
    timer = window.setTimeout(loop, seconds * 1000);
  };
  loop();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    navigator.vibrate?.(0);
  };
}

/** Unlocks audio on iPhone; call from a tap (e.g. the call button). */
export function primeAudio() {
  audioContext();
}
