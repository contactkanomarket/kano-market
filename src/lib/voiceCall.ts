import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

// Peer-to-peer HD voice for one call. The two browsers exchange connection
// details (offer / answer / network candidates) over a Realtime broadcast
// channel named after the call id; the audio itself goes directly between them,
// or through a relay (TURN) when the network needs one.

/** Opus at 64 kbps mono, full band: wideband "HD voice" quality. */
const HD_VOICE_BITRATE = 64_000;
/** Callee repeats "ready" until the caller's offer arrives (the caller may join the channel a moment later). */
const READY_RETRY_MS = 1500;
/** A dropped connection gets this long to recover before the call counts as failed. */
const RECONNECT_GRACE_MS = 15_000;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const HD_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48_000,
};

export type CallConnectionState = "connecting" | "connected" | "reconnecting" | "failed" | "closed";

type SignalEvent = "ready" | "offer" | "answer" | "ice" | "hangup";

/** STUN plus any relay (TURN) configured on the server; falls back to public STUN only. */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const { data, error } = await supabase.functions.invoke("call-ice", { body: {} });
    if (error) throw error;
    if (Array.isArray(data?.iceServers) && data.iceServers.length) return data.iceServers as RTCIceServer[];
  } catch (error) {
    console.warn("[voiceCall] Using public STUN only; relay config unavailable", error);
  }
  return DEFAULT_ICE_SERVERS;
}

export async function getHdMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser can't make calls. Try Chrome, or the installed app.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: HD_MIC_CONSTRAINTS, video: false });
  } catch (error) {
    const name = (error as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error("Microphone access is blocked. Allow the microphone for Kano Kaftan in your phone settings.");
    }
    if (name === "NotFoundError") throw new Error("No microphone was found on this device.");
    throw new Error("Could not start the microphone.");
  }
}

/** Ask Opus for full-band HD voice with loss protection, in both directions. */
function preferHdOpus(sdp: string): string {
  const match = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!match) return sdp;
  const pt = match[1];
  const params = `minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxplaybackrate=48000;maxaveragebitrate=${HD_VOICE_BITRATE};usedtx=0`;
  const fmtp = new RegExp(`a=fmtp:${pt} [^\\r\\n]*`);
  return fmtp.test(sdp)
    ? sdp.replace(fmtp, `a=fmtp:${pt} ${params}`)
    : sdp.replace(match[0], `${match[0]}\r\na=fmtp:${pt} ${params}`);
}

interface VoiceCallOptions {
  callId: string;
  role: "caller" | "callee";
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  onRemoteStream: (stream: MediaStream) => void;
  onStateChange: (state: CallConnectionState) => void;
  /** The other side hung up. */
  onRemoteHangup: () => void;
}

export class VoiceCall {
  private pc: RTCPeerConnection;
  private channel: RealtimeChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private readyTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private gotOffer = false;
  private closed = false;

  constructor(private readonly opts: VoiceCallOptions) {
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers, bundlePolicy: "max-bundle" });
    opts.localStream.getAudioTracks().forEach((track) => this.pc.addTrack(track, opts.localStream));

    this.pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) opts.onRemoteStream(stream);
    };
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.send("ice", { candidate: event.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => this.handleConnectionState();
  }

  /** Join the signaling channel. The callee announces itself; the caller answers with an offer. */
  async start(): Promise<void> {
    this.channel = supabase.channel(`call:${this.opts.callId}`, { config: { broadcast: { self: false } } });
    this.channel
      .on("broadcast", { event: "ready" }, () => {
        if (this.opts.role === "caller") this.sendOffer();
      })
      .on("broadcast", { event: "offer" }, ({ payload }) => this.handleOffer(payload.sdp))
      .on("broadcast", { event: "answer" }, ({ payload }) => this.handleAnswer(payload.sdp))
      .on("broadcast", { event: "ice" }, ({ payload }) => this.handleCandidate(payload.candidate))
      .on("broadcast", { event: "hangup" }, () => {
        if (!this.closed) this.opts.onRemoteHangup();
      });

    await new Promise<void>((resolve, reject) => {
      this.channel!.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve();
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(new Error("Could not connect the call"));
      });
    });

    this.opts.onStateChange("connecting");
    if (this.opts.role === "callee") {
      const announce = () => {
        if (this.gotOffer || this.closed) return window.clearInterval(this.readyTimer);
        this.send("ready", {});
      };
      announce();
      this.readyTimer = window.setInterval(announce, READY_RETRY_MS);
    }
  }

  setMuted(muted: boolean) {
    this.opts.localStream.getAudioTracks().forEach((track) => (track.enabled = !muted));
  }

  /** End the call on this side and tell the other side. */
  hangup() {
    if (this.closed) return;
    this.send("hangup", {});
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.readyTimer);
    window.clearTimeout(this.reconnectTimer);
    this.opts.localStream.getTracks().forEach((track) => track.stop());
    this.pc.close();
    if (this.channel) supabase.removeChannel(this.channel);
    this.opts.onStateChange("closed");
  }

  private send(event: SignalEvent, payload: Record<string, unknown>) {
    this.channel?.send({ type: "broadcast", event, payload }).catch((error) => {
      console.error("[voiceCall] signal send failed", event, error);
    });
  }

  private async sendOffer(iceRestart = false) {
    if (this.closed) return;
    try {
      const offer = await this.pc.createOffer({ iceRestart, offerToReceiveAudio: true });
      const sdp = preferHdOpus(offer.sdp ?? "");
      await this.pc.setLocalDescription({ type: "offer", sdp });
      await this.capSendBitrate();
      this.send("offer", { sdp });
    } catch (error) {
      console.error("[voiceCall] offer failed", error);
    }
  }

  private async handleOffer(sdp: string) {
    if (this.opts.role !== "callee" || this.closed) return;
    this.gotOffer = true;
    window.clearInterval(this.readyTimer);
    try {
      await this.pc.setRemoteDescription({ type: "offer", sdp });
      await this.flushCandidates();
      const answer = await this.pc.createAnswer();
      const hdSdp = preferHdOpus(answer.sdp ?? "");
      await this.pc.setLocalDescription({ type: "answer", sdp: hdSdp });
      await this.capSendBitrate();
      this.send("answer", { sdp: hdSdp });
    } catch (error) {
      console.error("[voiceCall] answering offer failed", error);
    }
  }

  private async handleAnswer(sdp: string) {
    if (this.opts.role !== "caller" || this.closed || this.pc.signalingState !== "have-local-offer") return;
    try {
      await this.pc.setRemoteDescription({ type: "answer", sdp });
      await this.flushCandidates();
    } catch (error) {
      console.error("[voiceCall] applying answer failed", error);
    }
  }

  private async handleCandidate(candidate: RTCIceCandidateInit) {
    if (this.closed || !candidate) return;
    if (!this.pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      console.warn("[voiceCall] bad network candidate", error);
    }
  }

  private async flushCandidates() {
    const queued = this.pendingCandidates.splice(0);
    for (const candidate of queued) await this.handleCandidate(candidate);
  }

  private async capSendBitrate() {
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== "audio") continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = HD_VOICE_BITRATE;
      try {
        await sender.setParameters(params);
      } catch {
        // Some browsers don't allow this; the SDP setting above still applies.
      }
    }
  }

  private handleConnectionState() {
    if (this.closed) return;
    const state = this.pc.connectionState;
    if (state === "connected") {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.opts.onStateChange("connected");
    } else if (state === "disconnected" || state === "failed") {
      this.opts.onStateChange("reconnecting");
      // The caller asks for a fresh network path; give it a while before giving up.
      if (this.opts.role === "caller") this.sendOffer(true);
      if (!this.reconnectTimer) {
        this.reconnectTimer = window.setTimeout(() => {
          if (this.pc.connectionState !== "connected") this.opts.onStateChange("failed");
        }, RECONNECT_GRACE_MS);
      }
    }
  }
}
