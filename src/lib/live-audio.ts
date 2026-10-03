/**
 * Live student microphone chunks over Supabase Realtime broadcast.
 * 16 kHz mono PCM with linear downsample + gapless playback for natural voice.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export const LIVE_MIC_EVENT = "mic-chunk";
export const LIVE_MIC_INTERVAL_MS = 80;
export const LIVE_MIC_STALE_MS = 3_500;
/** Target capture/encode rate — 16 kHz is speech-intelligible without robotic aliasing. */
export const LIVE_MIC_TARGET_RATE = 16_000;

export type LiveMicChunkPayload = {
  attemptId: string;
  studentId?: string | null;
  examId?: string | null;
  ts: number;
  /** base64 of Int16 PCM little-endian mono @ sampleRate */
  pcm: string;
  sampleRate: number;
  rms?: number;
};

export function liveMicChannelName(schoolId: string): string {
  return `live-mic:${schoolId}`;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
  }
  return out;
}

/** Linear-interpolation downsample (much less robotic than nearest-neighbor). */
function downsampleLinear(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate) return buffer;
  const ratio = fromRate / toRate;
  const newLen = Math.floor(buffer.length / ratio);
  if (newLen <= 0) return new Float32Array(0);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = buffer[idx] ?? 0;
    const b = buffer[Math.min(idx + 1, buffer.length - 1)] ?? a;
    result[i] = a + (b - a) * frac;
  }
  return result;
}

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToAb(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export type LiveMicPublisher = { stop: () => void };

export function startLiveMicPublisher(opts: {
  schoolId: string;
  attemptId: string;
  studentId?: string | null;
  examId?: string | null;
  getStream: () => MediaStream | null;
}): LiveMicPublisher {
  const { schoolId, attemptId } = opts;
  if (!schoolId || !attemptId) {
    return { stop: () => undefined };
  }

  let stopped = false;
  let channel: RealtimeChannel | null = null;
  let audioCtx: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let timer: number | null = null;
  let pending: Float32Array[] = [];
  let inputRate = 48000;

  const TARGET_RATE = LIVE_MIC_TARGET_RATE;

  function flush() {
    if (stopped || !channel || !pending.length) return;
    let total = 0;
    for (const p of pending) total += p.length;
    if (total < Math.max(320, Math.floor(inputRate * 0.04))) return;
    const merged = new Float32Array(total);
    let off = 0;
    for (const p of pending) {
      merged.set(p, off);
      off += p.length;
    }
    pending = [];
    const down = downsampleLinear(merged, inputRate, TARGET_RATE);
    if (down.length < 64) return;
    let sum = 0;
    for (let i = 0; i < down.length; i++) sum += down[i] * down[i];
    const rms = Math.sqrt(sum / down.length);
    if (rms < 0.0012) return;
    const pcm = floatTo16BitPCM(down);
    const b64 = abToBase64(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    const payload: LiveMicChunkPayload = {
      attemptId,
      studentId: opts.studentId ?? null,
      examId: opts.examId ?? null,
      ts: Date.now(),
      pcm: b64,
      sampleRate: TARGET_RATE,
      rms,
    };
    try {
      void channel.send({ type: "broadcast", event: LIVE_MIC_EVENT, payload });
    } catch {
      /* ignore */
    }
  }

  function attach(stream: MediaStream) {
    const tracks = stream.getAudioTracks().filter((t) => t.readyState === "live");
    if (!tracks.length) return false;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AC();
      inputRate = audioCtx.sampleRate || 48000;
      source = audioCtx.createMediaStreamSource(new MediaStream(tracks));
      processor = audioCtx.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (e) => {
        if (stopped) return;
        const input = e.inputBuffer.getChannelData(0);
        pending.push(new Float32Array(input));
        let len = 0;
        for (const p of pending) len += p.length;
        while (len > inputRate * 0.5 && pending.length > 1) {
          len -= pending[0].length;
          pending.shift();
        }
      };
      source.connect(processor);
      try {
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        processor.connect(gain);
        gain.connect(audioCtx.destination);
      } catch {
        processor.connect(audioCtx.destination);
      }
      return true;
    } catch (e) {
      console.warn("[live-mic] attach failed", e);
      return false;
    }
  }

  function tick() {
    if (stopped) return;
    const stream = opts.getStream();
    if (stream && !source) {
      attach(stream);
    }
    flush();
  }

  try {
    channel = supabase.channel(liveMicChannelName(schoolId), {
      config: { broadcast: { self: false } },
    });
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        const stream = opts.getStream();
        if (stream) attach(stream);
        timer = window.setInterval(tick, LIVE_MIC_INTERVAL_MS);
      }
    });
  } catch (e) {
    console.warn("[live-mic] channel failed", e);
  }

  return {
    stop: () => {
      stopped = true;
      if (timer != null) {
        try {
          window.clearInterval(timer);
        } catch {
          /* ignore */
        }
        timer = null;
      }
      try {
        processor?.disconnect();
        source?.disconnect();
        void audioCtx?.close();
      } catch {
        /* ignore */
      }
      processor = null;
      source = null;
      audioCtx = null;
      pending = [];
      if (channel) {
        try {
          void supabase.removeChannel(channel);
        } catch {
          /* ignore */
        }
        channel = null;
      }
    },
  };
}

export type LiveMicSubscriber = { stop: () => void };

export function startLiveMicSubscriber(opts: {
  schoolId: string;
  onChunk: (payload: LiveMicChunkPayload) => void;
}): LiveMicSubscriber {
  const { schoolId, onChunk } = opts;
  if (!schoolId) return { stop: () => undefined };
  let channel: RealtimeChannel | null = null;
  try {
    channel = supabase.channel(liveMicChannelName(schoolId), {
      config: { broadcast: { self: false } },
    });
    channel
      .on("broadcast", { event: LIVE_MIC_EVENT }, (msg) => {
        const p = (msg as { payload?: LiveMicChunkPayload }).payload;
        if (!p || !p.pcm || !p.attemptId) return;
        onChunk(p);
      })
      .subscribe();
  } catch (e) {
    console.warn("[live-mic] subscribe failed", e);
  }
  return {
    stop: () => {
      if (channel) {
        try {
          void supabase.removeChannel(channel);
        } catch {
          /* ignore */
        }
        channel = null;
      }
    },
  };
}

/** Per-context gapless scheduler so chunks abut without clicks/gaps. */
const nextPlayAt = new WeakMap<AudioContext, number>();

/**
 * Play a PCM chunk with gapless scheduling.
 * Returns false if AudioContext blocked.
 */
export function playMicChunk(
  ctx: AudioContext,
  payload: LiveMicChunkPayload,
  volume = 1,
): boolean {
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const ab = base64ToAb(payload.pcm);
    const int16 = new Int16Array(ab);
    if (!int16.length) return false;
    const float = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 0x8000;
    const rate = payload.sampleRate || LIVE_MIC_TARGET_RATE;
    const buffer = ctx.createBuffer(1, float.length, rate);
    buffer.copyToChannel(float, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    let planned = nextPlayAt.get(ctx) ?? now;
    // If we fell more than ~350ms behind, reset schedule to avoid growing lag
    if (planned < now - 0.35) planned = now;
    const startAt = Math.max(now + 0.005, planned);
    const dur = buffer.duration;
    const vol = Math.max(0, Math.min(1.4, volume));
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(vol, startAt + 0.008);
    gain.gain.setValueAtTime(vol, Math.max(startAt + 0.008, startAt + dur - 0.012));
    gain.gain.linearRampToValueAtTime(0.0001, startAt + dur);
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(startAt);
    nextPlayAt.set(ctx, startAt + dur);
    return true;
  } catch {
    return false;
  }
}

export function isLiveMicFresh(ts: number | null | undefined, now = Date.now()): boolean {
  if (ts == null) return false;
  return now - ts <= LIVE_MIC_STALE_MS;
}
