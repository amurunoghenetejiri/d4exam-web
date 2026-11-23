/**
 * Publishes student screen-share JPEG frames to officer live-monitor.
 * On Android, frames come from MediaProjection via awaitLatestNativeScreenJpeg —
 * no MediaStream tracks required.
 *
 * Uses a stable publisher that restarts only when identity keys change.
 * Falls back to studentId:examId when attemptId is not yet available so
 * frames can start flowing as soon as capture is active.
 *
 * CRITICAL: once enabled for an exam session, keep publishing until the
 * session ends — do not tear down on brief isNativeScreenShareActive gaps.
 */
import { useEffect, useRef } from "react";
import { startLiveScreenPublisher, type LiveScreenPublisher } from "@/lib/live-video";
import {
  holdExamScreenShare,
  isExamScreenShareHold,
  isNativeScreenShareActive,
  refreshNativeScreenShareState,
} from "@/lib/screen-share";
import { pulseExamAttempt } from "@/lib/cbt-attempt-heartbeat";

export function useLiveScreenPublish(opts: {
  enabled: boolean;
  schoolId: string | null | undefined;
  studentId: string | null | undefined;
  examId: string | null | undefined;
  attemptId: string | null | undefined;
  stream: MediaStream | null;
  getStream?: () => MediaStream | null;
}) {
  const pubRef = useRef<LiveScreenPublisher | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const wasActiveRef = useRef(false);

  const schoolId = String(opts.schoolId || "");
  const studentId = String(opts.studentId || "");
  const examId = String(opts.examId || "");
  const attemptId =
    String(opts.attemptId || "") ||
    (studentId && examId ? `pending:${studentId}:${examId}` : "");
  const identityOk = Boolean(schoolId && studentId && examId && attemptId);
  const streamLive = Boolean(
    opts.stream &&
      opts.stream.getVideoTracks().some((tr) => tr.readyState === "live"),
  );
  const enabled =
    opts.enabled &&
    identityOk &&
    (streamLive ||
      Boolean(opts.stream) ||
      isNativeScreenShareActive() ||
      isExamScreenShareHold() ||
      wasActiveRef.current);

  useEffect(() => {
    if (!enabled) {
      try {
        pubRef.current?.stop();
      } catch {
        /* ignore */
      }
      pubRef.current = null;
      wasActiveRef.current = false;
      return;
    }

    wasActiveRef.current = true;
    holdExamScreenShare(true);

    try {
      pubRef.current?.stop();
    } catch {
      /* ignore */
    }

    void refreshNativeScreenShareState();

    pubRef.current = startLiveScreenPublisher({
      schoolId,
      attemptId,
      studentId,
      examId,
      getStream: () => optsRef.current.getStream?.() || optsRef.current.stream,
      intervalMs: 400,
    });

    const realAttemptId = String(optsRef.current.attemptId || "");
    if (realAttemptId && !realAttemptId.startsWith("pending:")) {
      void pulseExamAttempt(realAttemptId);
    }

    const sync = window.setInterval(() => {
      void refreshNativeScreenShareState();
      const aid = String(optsRef.current.attemptId || "");
      if (aid && !aid.startsWith("pending:")) void pulseExamAttempt(aid);
    }, 2000);

    return () => {
      window.clearInterval(sync);
      try {
        pubRef.current?.stop();
      } catch {
        /* ignore */
      }
      pubRef.current = null;
    };
  }, [enabled, schoolId, studentId, examId, attemptId]);
}
