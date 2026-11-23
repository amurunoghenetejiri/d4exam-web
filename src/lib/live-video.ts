/**
 * Live camera + screen JPEG frame publish/subscribe over Supabase Realtime broadcast.
 * Camera frames are mirrored (selfie); screen frames are not.
 * Android native screen uses MediaProjection JPEGs directly when available.
 *
 * CRITICAL channel contract (must stay matched):
 *   Camera:  live-cam:{schoolId}     event: cam-frame
 *   Screen:  live-screen:{schoolId}  event: screen-frame
 * Every frame payload includes attemptId so the officer can route to the right card.
 */
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { awaitLatestNativeScreenJpeg, getLatestNativeScreenJpeg } from "@/lib/screen-share";

let sharedVideo: HTMLVideoElement | null = null;
let sharedCanvas: HTMLCanvasElement | null = null;

function getSharedVideo(): HTMLVideoElement | null {
  if (typeof document === "undefined") return null;
  if (!sharedVideo) {
    sharedVideo = document.createElement("video");
    sharedVideo.muted = true;
    sharedVideo.playsInline = true;
    sharedVideo.setAttribute("playsinline", "true");
    sharedVideo.setAttribute("webkit-playsinline", "true");
  }
  return sharedVideo;
}

function getSharedCanvas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (!sharedCanvas) sharedCanvas = document.createElement("canvas");
  return sharedCanvas;
}

export async function captureJpegFromStream(
  stream: MediaStream,
  opts?: { maxWidth?: number; quality?: number; mirror?: boolean },
): Promise<string | null> {
  const tracks = stream.getVideoTracks();
  if (!tracks.some((t) => t.readyState === "live" && t.enabled !== false)) return null;

  const maxWidth = opts?.maxWidth ?? 360;
  const quality = opts?.quality ?? 0.52;
  const mirror = opts?.mirror !== false;

  const video = getSharedVideo();
  const canvas = getSharedCanvas();
  if (!video || !canvas) return null;

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }
  try {
    if (video.paused) await video.play();
  } catch {
    return null;
  }
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      const onMeta = () => {
        video.removeEventListener("loadedmetadata", onMeta);
        resolve();
      };
      video.addEventListener("loadedmetadata", onMeta);
      window.setTimeout(() => resolve(), 300);
    });
  }

  const t0 = video.currentTime;
  await new Promise((r) => window.setTimeout(r, 16));
  if (video.readyState >= 2 && video.currentTime === t0 && !video.paused) {
    try {
      video.srcObject = stream;
      await video.play();
    } catch {
      return null;
    }
  }

  const vw = video.videoWidth || 0;
  const vh = video.videoHeight || 0;
  if (vw < 8 || vh < 8) return null;

  const scale = Math.min(1, maxWidth / vw);
  const w = Math.max(8, Math.round(vw * scale));
  const h = Math.max(8, Math.round(vh * scale));

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;

  ctx.save();
  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  try {
    ctx.drawImage(video, 0, 0, w, h);
  } catch {
    ctx.restore();
    return null;
  }
  ctx.restore();

  try {
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return null;
  }
}

export type LiveCamPublisher = { stop: () => void };

export const LIVE_CAM_EVENT = "cam-frame";
export const LIVE_CAM_FRAME_INTERVAL_MS = 280;
export const LIVE_CAM_STALE_MS = 8_000;
export const LIVE_CAM_DISPLAY_MS = 90_000;

export type LiveCamFramePayload = {
  attemptId: string;
  studentId: string;
  examId: string;
  frame: string;
  ts: number;
  faceStatus?: string;
  cameraActive?: boolean;
  answeredCount?: number;
  totalQuestions?: number;
  timeRemainingSec?: number | null;
  studentName?: string;
  matricNumber?: string;
  courseCode?: string;
  examTitle?: string;
};

export function liveCamChannelName(schoolId: string): string {
  return `live-cam:${schoolId}`;
}

export function startLiveCamPublisher(opts: {
  schoolId: string;
  attemptId: string;
  studentId: string;
  examId: string;
  getStream: () => MediaStream | null;
  intervalMs?: number;
  getFaceMeta?: () => {
    faceStatus?: string;
    cameraActive?: boolean;
    answeredCount?: number;
    totalQuestions?: number;
    timeRemainingSec?: number | null;
    tabSwitchCount?: number;
    studentName?: string;
    matricNumber?: string;
    courseCode?: string;
    examTitle?: string;
  };
}): LiveCamPublisher {
  const intervalMs = opts.intervalMs ?? LIVE_CAM_FRAME_INTERVAL_MS;
  let stopped = false;
  let channel: RealtimeChannel | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let publishing = false;
  // MUST match startLiveCamSubscriber — school-level only (no per-attempt suffix).
  const channelName = liveCamChannelName(opts.schoolId);

  const clearTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const ensureTimer = () => {
    if (stopped || timer) return;
    void sendFrame();
    timer = setInterval(() => void sendFrame(), intervalMs);
  };

  const sendFrame = async () => {
    if (stopped || publishing) return;
    const stream = opts.getStream();
    if (!stream) return;
    const live = stream.getVideoTracks().some((tr) => tr.readyState === "live" && tr.enabled !== false);
    if (!live) return;
    publishing = true;
    try {
      const frame = await captureJpegFromStream(stream, { maxWidth: 320, quality: 0.55, mirror: true });
      if (stopped || !frame || !channel) return;
      const meta = opts.getFaceMeta?.() || {};
      void channel.send({
        type: "broadcast",
        event: LIVE_CAM_EVENT,
        payload: {
          attemptId: opts.attemptId,
          studentId: opts.studentId,
          examId: opts.examId,
          frame,
          ts: Date.now(),
          faceStatus: meta.faceStatus ?? "ok",
          cameraActive: meta.cameraActive !== false,
          answeredCount: meta.answeredCount,
          totalQuestions: meta.totalQuestions,
          timeRemainingSec: meta.timeRemainingSec,
          tabSwitchCount: meta.tabSwitchCount,
          studentName: meta.studentName,
          matricNumber: meta.matricNumber,
          courseCode: meta.courseCode,
          examTitle: meta.examTitle,
        },
      });
    } catch (e) {
      console.warn("[live-cam]", e);
    } finally {
      publishing = false;
    }
  };

  const attach = () => {
    if (stopped) return;
    if (channel) {
      try {
        void supabase.removeChannel(channel);
      } catch {
        /* ignore */
      }
      channel = null;
    }
    clearTimer();
    channel = supabase.channel(channelName, {
      config: { broadcast: { ack: false, self: false } },
    });
    void channel.subscribe((status) => {
      if (stopped) return;
      if (status === "SUBSCRIBED") {
        ensureTimer();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimer();
        if (!stopped) {
          window.setTimeout(() => {
            if (!stopped) attach();
          }, 2000);
        }
      }
    });
  };

  attach();

  return {
    stop: () => {
      stopped = true;
      clearTimer();
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    },
  };
}

export type LiveCamSubscriber = { stop: () => void };

export function startLiveCamSubscriber(opts: {
  schoolId: string;
  onFrame: (p: LiveCamFramePayload) => void;
}): LiveCamSubscriber {
  const lastTsByAttempt = new Map<string, number>();
  const channel = supabase.channel(liveCamChannelName(opts.schoolId), {
    config: { broadcast: { ack: false, self: false } },
  });

  channel.on("broadcast", { event: LIVE_CAM_EVENT }, ({ payload }) => {
    const raw = payload as LiveCamFramePayload & { attempt_id?: string; student_id?: string };
    if (!raw?.frame) return;
    const attemptId = raw.attemptId || raw.attempt_id || "";
    if (!attemptId) return;
    const p: LiveCamFramePayload = {
      ...raw,
      attemptId,
      studentId: raw.studentId || raw.student_id || "",
    };
    const prev = lastTsByAttempt.get(attemptId) ?? 0;
    if (p.ts && p.ts < prev - 500) return;
    if (p.ts) lastTsByAttempt.set(attemptId, p.ts);
    opts.onFrame(p);
  });

  void channel.subscribe();

  return {
    stop: () => {
      lastTsByAttempt.clear();
      void supabase.removeChannel(channel);
    },
  };
}

export function isLiveCamFrameFresh(ts: number | null | undefined, now = Date.now()): boolean {
  if (ts == null) return false;
  return now - ts <= LIVE_CAM_STALE_MS;
}

export function isLiveCamFrameUsable(ts: number | null | undefined, now = Date.now()): boolean {
  if (ts == null) return false;
  return now - ts <= LIVE_CAM_DISPLAY_MS;
}

export const LIVE_SCREEN_EVENT = "screen-frame";

/** Ensure monitor <img> can render the frame. */
function normalizeScreenFrame(frame: string): string {
  const f = String(frame || "").trim();
  if (!f) return "";
  if (f.startsWith("data:")) return f;
  // raw base64 from native
  return `data:image/jpeg;base64,${f}`;
}

export const LIVE_SCREEN_FRAME_INTERVAL_MS = 400;
export type LiveScreenFramePayload = {
  attemptId: string;
  studentId: string;
  examId: string;
  frame: string;
  ts: number;
  screenActive?: boolean;
};
export function liveScreenChannelName(schoolId: string): string {
  return `live-screen:${schoolId}`;
}
export type LiveScreenPublisher = { stop: () => void };

export function startLiveScreenPublisher(opts: {
  schoolId: string;
  attemptId: string;
  studentId: string;
  examId: string;
  getStream: () => MediaStream | null;
  intervalMs?: number;
}): LiveScreenPublisher {
  const intervalMs = opts.intervalMs ?? LIVE_SCREEN_FRAME_INTERVAL_MS;
  let stopped = false;
  let channel: RealtimeChannel | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let publishing = false;

  channel = supabase.channel(liveScreenChannelName(opts.schoolId), {
    config: { broadcast: { ack: false, self: false } },
  });

  const sendFrame = async () => {
    if (stopped || publishing) return;
    publishing = true;
    try {
      let frame = getLatestNativeScreenJpeg();
      if (!frame) {
        frame = await awaitLatestNativeScreenJpeg();
      }
      if (!frame) {
        const stream = opts.getStream();
        if (stream && stream.getVideoTracks().some((t) => t.readyState === "live")) {
          frame = await captureJpegFromStream(stream, {
            maxWidth: 480,
            quality: 0.42,
            mirror: false,
          });
        }
      }
      if (stopped || !channel) return;
      if (!frame) {
        return;
      }
      // Compress oversized native/web frames so Realtime does not silently drop them.
      try {
        if (typeof document !== "undefined" && frame.length > 90_000) {
          const img = new Image();
          const loaded = new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("jpeg load"));
          });
          img.src = frame.startsWith("data:") ? frame : `data:image/jpeg;base64,${frame}`;
          await loaded;
          const maxW = 480;
          const scale = Math.min(1, maxW / (img.naturalWidth || img.width || maxW));
          const w = Math.max(8, Math.round((img.naturalWidth || img.width) * scale));
          const h = Math.max(8, Math.round((img.naturalHeight || img.height) * scale));
          const canvas = getSharedCanvas();
          if (canvas) {
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d", { alpha: false });
            if (ctx) {
              ctx.drawImage(img, 0, 0, w, h);
              let q = 0.42;
              let out = canvas.toDataURL("image/jpeg", q);
              if (out.length > 180_000) {
                q = 0.28;
                canvas.width = Math.max(8, Math.round(w * 0.75));
                canvas.height = Math.max(8, Math.round(h * 0.75));
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                out = canvas.toDataURL("image/jpeg", q);
              }
              if (out.length < frame.length) frame = out;
            }
          }
        }
      } catch (ce) {
        console.warn("[live-screen] compress", ce);
      }
      if (frame.length > 280_000) {
        console.warn("[live-screen] frame too large, skip", frame.length);
        return;
      }
      const frameOut = normalizeScreenFrame(frame);
      if (!frameOut) return;
      const basePayload = {
        studentId: opts.studentId,
        examId: opts.examId,
        frame: frameOut,
        ts: Date.now(),
        screenActive: true as const,
      };
      const attemptKey = String(opts.attemptId || "").trim();
      const keys = new Set<string>();
      if (attemptKey) keys.add(attemptKey);
      // Always also publish under pending key so monitor can match before/after attempt id stabilizes
      if (opts.studentId && opts.examId) {
        keys.add(`pending:${opts.studentId}:${opts.examId}`);
      }
      for (const key of keys) {
        const status = await channel.send({
          type: "broadcast",
          event: LIVE_SCREEN_EVENT,
          payload: { ...basePayload, attemptId: key },
        });
        if (status !== "ok") {
          console.warn("[live-screen] broadcast status=", status, "key=", key, "size=", frameOut.length);
        }
      }
    } catch (e) {
      console.warn("[live-screen]", e);
    } finally {
      publishing = false;
    }
  };

  void channel.subscribe((status) => {
    if (status === "SUBSCRIBED" && !stopped) {
      void sendFrame();
      timer = setInterval(() => void sendFrame(), intervalMs);
    }
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    },
  };
}

export const LIVE_SCREEN_STALE_MS = 12_000;
export const LIVE_SCREEN_DISPLAY_MS = 90_000;

export function isLiveScreenFrameFresh(ts: number | null | undefined, now = Date.now()): boolean {
  if (ts == null) return false;
  return now - ts <= LIVE_SCREEN_STALE_MS;
}

export function isLiveScreenFrameUsable(ts: number | null | undefined, now = Date.now()): boolean {
  if (ts == null) return false;
  return now - ts <= LIVE_SCREEN_DISPLAY_MS;
}

export type LiveScreenSubscriber = { stop: () => void };

export function startLiveScreenSubscriber(opts: {
  schoolId: string;
  onFrame: (p: LiveScreenFramePayload) => void;
}): LiveScreenSubscriber {
  const lastTsByAttempt = new Map<string, number>();
  const channel = supabase.channel(liveScreenChannelName(opts.schoolId), {
    config: { broadcast: { ack: false, self: false } },
  });

  channel.on("broadcast", { event: LIVE_SCREEN_EVENT }, ({ payload }) => {
    const raw = payload as LiveScreenFramePayload & {
      attempt_id?: string;
      student_id?: string;
    };
    if (!raw?.frame) return;
    const attemptId = raw.attemptId || raw.attempt_id || "";
    if (!attemptId) return;
    const p: LiveScreenFramePayload = {
      attemptId,
      studentId: raw.studentId || raw.student_id || "",
      examId: raw.examId || (raw as { exam_id?: string }).exam_id || "",
      frame: normalizeScreenFrame(String(raw.frame)),
      ts: raw.ts || Date.now(),
      screenActive: raw.screenActive !== false,
    };
    if (!p.frame) return;
    const prev = lastTsByAttempt.get(attemptId) ?? 0;
    if (p.ts && p.ts < prev - 500) return;
    if (p.ts) lastTsByAttempt.set(attemptId, p.ts);
    opts.onFrame(p);
  });

  void channel.subscribe();

  return {
    stop: () => {
      lastTsByAttempt.clear();
      void supabase.removeChannel(channel);
    },
  };
}

/** Officer: match a frame by attemptId OR studentId+examId (pending key). */
export function matchLiveScreenFrame(
  frames: Map<string, LiveScreenFramePayload> | Record<string, LiveScreenFramePayload>,
  opts: { attemptId?: string | null; studentId?: string | null; examId?: string | null },
): LiveScreenFramePayload | null {
  const map =
    frames instanceof Map
      ? frames
      : new Map(Object.entries(frames || {}));
  const attemptId = String(opts.attemptId || "");
  if (attemptId && map.has(attemptId)) return map.get(attemptId) || null;
  const studentId = String(opts.studentId || "");
  const examId = String(opts.examId || "");
  if (studentId && examId) {
    const pending = `pending:${studentId}:${examId}`;
    if (map.has(pending)) return map.get(pending) || null;
    for (const f of map.values()) {
      if (f.studentId === studentId && f.examId === examId) return f;
    }
  }
  return null;
}
