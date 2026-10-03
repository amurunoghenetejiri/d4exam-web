import { Link, useParams, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, ChevronLeft, ChevronRight, Loader2, Maximize } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SchoolLogo } from "@/components/brand/SchoolLogo";
import { useSchoolIdentity } from "@/lib/school-identity";
import { ExamSecurityGate } from "@/components/cbt/ExamSecurityGate";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useStudentContext, formatExamWindow } from "@/lib/student";
import { useSessionUser, readCachedSchoolBrand } from "@/lib/session";
import { friendlyError } from "@/lib/friendly-error";
import { fromExamSettingsRow, type ExamSettingsRow } from "@/lib/exam-security";
import { parseExamMeta } from "@/lib/exam-meta";
import { loadExamQuestionBank, prepareStudentPaper, reshuffleUnansweredPaper, type CbtQuestionRow } from "@/lib/cbt-load-questions";
import { type DeviceCapabilities } from "@/lib/device-capabilities";
import { toast } from "sonner";
import { ExamCameraPip, type FaceSecurityEvent } from "@/components/cbt/ExamCameraPip";
import { ExamCalculator, ExamCalculatorFab } from "@/components/cbt/ExamCalculator";
import { saveCbtResult } from "@/lib/cbt-save-result";
import { logSecurityEvent } from "@/lib/cbt-security";
import { mapFaceSecurityEvent } from "@/lib/live-monitor";
import { openCameraStream, ensureMicrophonePermission } from "@/native/cameraService";
import { enterExamImmersive, exitExamImmersive } from "@/native/statusBar";
import { haptic, primeHaptics } from "@/lib/haptic";
import { startScreenShareStream, onScreenShareEnded, stopScreenShareStream, holdExamScreenShare } from "@/lib/screen-share";
import { useLiveScreenPublish } from "@/lib/use-live-screen-publish";
import { useLiveCamPublish } from "@/lib/use-live-cam-publish";
import { useLiveMicPublish } from "@/lib/use-live-mic-publish";
import { useExamAttemptHeartbeat } from "@/lib/use-exam-attempt-heartbeat";
import { isExamAttemptFinished } from "@/lib/student";
import { setExamActiveFlag } from "@/lib/fingerprint-lock";

function isPreviewPath() {
  if (typeof window === "undefined") return false;
  return window.location.pathname.includes("/officer/exam-preview");
}

function stopMediaStream(stream: MediaStream | null | undefined) {
  if (!stream) return;
  try {
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function requestExamFullscreen(): Promise<boolean> {
  if (typeof document === "undefined") return false;
  await enterExamImmersive();
  if (document.fullscreenElement) return true;
  try {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch { /* blocked by browser / Android policy */ }
  // On native Capacitor WebView, StatusBar.hide is the real immersive control.
  // document.fullscreen may remain false — treat native immersive as success.
  try {
    const { isNativeShell } = await import("@/native/platform");
    if (isNativeShell()) return true;
  } catch { /* ignore */ }
  return Boolean(document.fullscreenElement);
}

async function leaveExamFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen?.();
  } catch { /* ignore */ }
  await exitExamImmersive();
}

export function CbtExamPage() {
  const params = useParams({ strict: false }) as { id?: string };
  const id = params.id ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const previewMode = isPreviewPath();
  const { data: student } = useStudentContext();
  const { data: session } = useSessionUser();
  const schoolIdForBrand = student?.schoolId ?? session?.schoolId ?? null;
  const { data: schoolBrand } = useSchoolIdentity(schoolIdForBrand);
  const cachedBrand = typeof window !== "undefined" ? readCachedSchoolBrand(schoolIdForBrand) : null;
  const resolvedLogoUrl =
    schoolBrand?.logoUrl ||
    session?.schoolLogoUrl ||
    cachedBrand?.logoUrl ||
    null;
  const resolvedSchoolName =
    schoolBrand?.name ||
    student?.schoolName ||
    session?.schoolName ||
    cachedBrand?.name ||
    null;
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [doneTerminated, setDoneTerminated] = useState(false);
  const doneTerminatedRef = useRef(false);
  doneTerminatedRef.current = doneTerminated;
  const [doneForceSubmit, setDoneForceSubmit] = useState(false);
  const [index, setIndex] = useState(0);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const answersRef = useRef<Record<string, number | string>>({});
  answersRef.current = answers;
  /** Live paper after tab-leave reshuffle (answered locked; unanswered replaced). */
  const [livePaper, setLivePaper] = useState<CbtQuestionRow[] | null>(null);
  const livePaperRef = useRef<CbtQuestionRow[] | null>(null);
  livePaperRef.current = livePaper;
  const reshuffleOnTabLeaveRef = useRef<() => void>(() => {});
  const flushAttemptProgress = useCallback(async () => {
    const aid = attemptIdRef.current;
    if (!aid) return;
    try {
      await supabase.from("exam_attempts").update({
        answers: answersRef.current,
        ends_at: endsAtRef.current ? new Date(endsAtRef.current).toISOString() : undefined,
        tab_switch_count: tabSwitchCountRef.current,
        status: "in_progress",
        updated_at: new Date().toISOString(),
      } as never).eq("id", aid);
    } catch (e) {
      console.warn("[cbt] flushAttemptProgress", e);
    }
  }, []);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [seconds, setSeconds] = useState<number | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [fsGate, setFsGate] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState<string>("");
  const [warnBanner, setWarnBanner] = useState<string | null>(null);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [pauseRemainingSec, setPauseRemainingSec] = useState<number | null>(null);
  const [isOfficerPause, setIsOfficerPause] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);
  const calcOpenRef = useRef(false);
  const attemptIdRef = useRef<string | null>(null);
  const tabSwitchCountRef = useRef(0);
  const fullscreenExitCountRef = useRef(0);
  const lastViolationAtRef = useRef(0);
  const lastTabHiddenAtRef = useRef(0);
  const orderedIdsRef = useRef<string[] | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const cameraReconnectLockRef = useRef(false);
  const pauseUntilRef = useRef<number | null>(null);
  /** Absolute exam end (ms). Remaining time always derived from this. */
  const endsAtRef = useRef<number | null>(null);
  /** True when pause is officer-driven (indefinite). */
  const officerPauseRef = useRef(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const [liveAttemptId, setLiveAttemptId] = useState<string | null>(null);
  const finishingRef = useRef(false);
  const resumeIndexRef = useRef<number | null>(null);
  /** Lock answers only after leave+continue (not while continuously writing). */
  const [lockedAnswerIds, setLockedAnswerIds] = useState<Set<string>>(() => new Set());
  /** True after student left exam (tab/app) — on return, lock already-answered questions. */
  const leftExamSessionRef = useRef(false);
  const startedRef = useRef(false);
  const doneRef = useRef(false);
  const pausedRef = useRef(false);
  const faceStatusForLiveRef = useRef<string>("ok");
  const resultIdRef = useRef<string | null>(null);
  startedRef.current = started;
  doneRef.current = done;
  pausedRef.current = paused;
  resultIdRef.current = resultId;
  /** Only integrity / officer messages during live exam — no generic toasts. */
  const examSafeToast = {
    message: (msg: string) => {
      if (startedRef.current && !doneRef.current) return;
      /* no toast during exam */ void msg;
    },
    success: (msg: string) => {
      if (startedRef.current && !doneRef.current) return;
      /* no toast during exam */ void msg;
    },
    error: (msg: string) => {
      if (startedRef.current && !doneRef.current) {
        setWarnBanner(msg);
        window.setTimeout(() => setWarnBanner(null), 6000);
        return;
      }
      /* no toast during exam */ void msg;
    },
  };

  const examQ = useQuery({
    queryKey: ["cbt-exam", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("examinations")
        .select("id, title, status, duration_minutes, scheduled_start, scheduled_end, course_id, school_id, description, questions_to_answer, courses(code, name)")
        .eq("id", id).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const settingsQ = useQuery({
    queryKey: ["cbt-settings", id],
    enabled: Boolean(id),
    queryFn: async () => {
      // Prefer full select (includes calculator columns). If schema is older, fall back.
      const full =
        "exam_id, fullscreen, tab_monitoring, max_tab_switches, block_copy_paste, randomize_questions, randomize_options, require_camera, require_microphone, face_detection, max_face_warnings, require_screen_share, screen_share_mode, threshold_action, face_violation_action, pause_duration_seconds, total_marks, instructions, result_visibility, questions_to_answer, allow_calculator, calculator_type";
      const basic =
        "exam_id, fullscreen, tab_monitoring, max_tab_switches, block_copy_paste, randomize_questions, randomize_options, require_camera, require_microphone, face_detection, max_face_warnings, require_screen_share, screen_share_mode, threshold_action, face_violation_action, pause_duration_seconds, total_marks, instructions, result_visibility, questions_to_answer";
      const first = await supabase.from("exam_settings").select(full).eq("exam_id", id).maybeSingle();
      if (!first.error) return first.data as ExamSettingsRow | null;
      const msg = String(first.error.message || "").toLowerCase();
      if (msg.includes("allow_calculator") || msg.includes("calculator_type") || msg.includes("column") || msg.includes("schema")) {
        const second = await supabase.from("exam_settings").select(basic).eq("exam_id", id).maybeSingle();
        if (!second.error) return second.data as ExamSettingsRow | null;
      }
      console.warn("[cbt-settings]", first.error.message);
      return null;
    },
  });

  const questionsQ = useQuery({
    queryKey: ["cbt-questions", id, examQ.data?.course_id, examQ.data?.school_id],
    enabled: Boolean(examQ.data?.course_id),
    queryFn: async () => {
      const exam = examQ.data!;
      return loadExamQuestionBank({
        courseId: String(exam.course_id),
        schoolId: exam.school_id ? String(exam.school_id) : null,
        examId: id || null,
      });
    },
  });

  const priorAttemptQ = useQuery({
    queryKey: ["cbt-prior-attempt", id, student?.studentId],
    enabled: Boolean(id && student?.studentId && !previewMode),
    queryFn: async () => {
      const { data: attempt } = await supabase
        .from("exam_attempts")
        .select("id, status")
        .eq("exam_id", id)
        .eq("student_id", student!.studentId)
        .maybeSingle();
      const { data: result } = await supabase
        .from("results")
        .select("id")
        .eq("exam_id", id)
        .eq("student_id", student!.studentId)
        .maybeSingle();
      return {
        attemptStatus: (attempt?.status as string | undefined) ?? null,
        hasResult: Boolean(result?.id),
        attemptId: (attempt?.id as string | undefined) ?? null,
      };
    },
  });

  const alreadyFinished = !previewMode && isExamAttemptFinished(
    priorAttemptQ.data?.attemptStatus,
    priorAttemptQ.data?.hasResult,
  );

  const security = useMemo(() => fromExamSettingsRow(settingsQ.data, examQ.data?.description), [settingsQ.data, examQ.data?.description]);
  // Extra calculator enable detection: description JSON may use either key style
  const calculatorEnabled = useMemo(() => {
    if (security.allowCalculator) return true;
    if (settingsQ.data && (settingsQ.data as { allow_calculator?: boolean }).allow_calculator === true) return true;
    const desc = String(examQ.data?.description || "");
    if (/"allowCalculator"\s*:\s*true/.test(desc) || /"allow_calculator"\s*:\s*true/.test(desc)) return true;
    return false;
  }, [security.allowCalculator, settingsQ.data, examQ.data?.description]);
  const calculatorMode = useMemo((): "basic" | "scientific" => {
    if (security.calculatorType === "scientific") return "scientific";
    if ((settingsQ.data as { calculator_type?: string } | null)?.calculator_type === "scientific") return "scientific";
    const desc = String(examQ.data?.description || "");
    if (/"calculatorType"\s*:\s*"scientific"/.test(desc) || /"calculator_type"\s*:\s*"scientific"/.test(desc)) return "scientific";
    return "basic";
  }, [security.calculatorType, settingsQ.data, examQ.data?.description]);

  const shutdownMedia = useCallback(() => {
    holdExamScreenShare(false);
    stopMediaStream(mediaStreamRef.current);
    mediaStreamRef.current = null;
    setLiveStream(null);
    try { stopScreenShareStream(screenStreamRef.current); } catch { /* ignore */ }
    screenStreamRef.current = null;
    setScreenStream(null);
  }, []);

  const reconnectCamera = useCallback(async () => {
    if (!security.requireCamera || cameraReconnectLockRef.current || doneRef.current || finishingRef.current) return;
    const cur = mediaStreamRef.current;
    const live = cur?.getVideoTracks().some((tr) => tr.readyState === "live" && tr.enabled !== false);
    if (live) return;
    cameraReconnectLockRef.current = true;
    try {
      const stream = await openCameraStream({ facingMode: "user", audio: Boolean(security.requireMicrophone || security.requireCamera) });
      stopMediaStream(mediaStreamRef.current);
      mediaStreamRef.current = stream;
      setLiveStream(stream);
    } catch (e) {
      console.warn("[cbt] camera reconnect failed", e);
    } finally {
      cameraReconnectLockRef.current = false;
    }
  }, [security.requireCamera, security.requireMicrophone]);

  const clearTimedPause = useCallback(() => {
    pauseUntilRef.current = null;
    officerPauseRef.current = false;
    setIsOfficerPause(false);
    setPauseRemainingSec(null);
    setPaused(false);
    setPauseReason("");
    const aid = attemptIdRef.current;
    if (aid) {
      void (async () => {
        try {
          const { data: prevRow } = await supabase.from("exam_attempts").select("metadata").eq("id", aid).maybeSingle();
          const prevMeta =
            prevRow?.metadata && typeof prevRow.metadata === "object" && !Array.isArray(prevRow.metadata)
              ? (prevRow.metadata as Record<string, unknown>)
              : {};
          const { pauseUntil: _a, pauseReason: _b, ...rest } = prevMeta as Record<string, unknown>;
          await supabase.from("exam_attempts").update({
            metadata: { ...rest, lastSeenAt: new Date().toISOString() },
            updated_at: new Date().toISOString(),
          } as never).eq("id", aid);
        } catch { /* ignore */ }
      })();
    }
    void reconnectCamera();
  }, [reconnectCamera]);

  const beginTimedPause = useCallback((reason: string) => {
    const secs = Math.max(5, Number(security.pauseDurationSeconds) || 300);
    officerPauseRef.current = false;
    setIsOfficerPause(false);
    const until = Date.now() + secs * 1000;
    pauseUntilRef.current = until;
    setPauseRemainingSec(secs);
    setPauseReason(reason);
    setPaused(true);
    // Persist so leave/re-enter keeps the same pause clock
    const aid = attemptIdRef.current;
    if (aid) {
      void (async () => {
        try {
          const { data: prevRow } = await supabase.from("exam_attempts").select("metadata").eq("id", aid).maybeSingle();
          const prevMeta =
            prevRow?.metadata && typeof prevRow.metadata === "object" && !Array.isArray(prevRow.metadata)
              ? (prevRow.metadata as Record<string, unknown>)
              : {};
          await supabase.from("exam_attempts").update({
            metadata: {
              ...prevMeta,
              pauseUntil: until,
              pauseReason: reason,
              tabSwitchCount: tabSwitchCountRef.current,
              lastSeenAt: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
          } as never).eq("id", aid);
        } catch (e) {
          console.warn("[cbt] pause persist", e);
        }
      })();
    }
  }, [security.pauseDurationSeconds]);

  useEffect(() => {
    // Integrity timed pause only — do NOT auto-resume at zero
    if (!paused || pauseUntilRef.current == null) return;
    const tick = () => {
      const until = pauseUntilRef.current;
      if (until == null) return;
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setPauseRemainingSec(left);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [paused, clearTimedPause]);

  useEffect(() => {
    // Absolute end clock — continues during officer/integrity pause and backgrounding
    if (!started || done) return;
    const tick = () => {
      const ends = endsAtRef.current;
      if (ends == null) return;
      const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
      setSeconds(left);
      if (left <= 0 && !finishingRef.current && !doneRef.current) {
        doneTerminatedRef.current = false;
        setDoneTerminated(false);
        // Time-up: auto-submit this attempt immediately (must not leave in_progress)
        void finishAttempt(true, "auto_submit");
      }
    };
    tick();
    const t = window.setInterval(tick, 1000);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, done]);

  useEffect(() => {
    if (done) {
      shutdownMedia();
      setFsGate(false);
      setPaused(false);
      void leaveExamFullscreen();
    }
  }, [done, shutdownMedia]);


  /** Never leave CBT unusable behind a stuck fullscreen gate */
  useEffect(() => {
    if (!started || done || paused) return;
    if (!fsGate) return;
    const t = window.setTimeout(() => {
      setFsGate(false);
    }, 8_000);
    return () => window.clearTimeout(t);
  }, [started, done, paused, fsGate]);

  /** Keep fingerprint app-lock from interrupting an active CBT session */
  useEffect(() => {
    const active = Boolean(started && !done && !previewMode);
    setExamActiveFlag(active);
    return () => setExamActiveFlag(false);
  }, [started, done, previewMode]);

  useEffect(() => () => {
    stopMediaStream(mediaStreamRef.current);
    mediaStreamRef.current = null;
    void exitExamImmersive();
  }, []);

  useLiveCamPublish({
    // Publish whenever exam is live and camera is required OR a stream is available
    enabled: started && !done && !previewMode && (Boolean(security.requireCamera) || Boolean(security.faceDetection)),
    schoolId: examQ.data?.school_id ?? student?.schoolId ?? session?.schoolId,
    studentId: student?.studentId,
    examId: id,
    attemptId: liveAttemptId || attemptIdRef.current,
    stream: liveStream,
    getStream: () => mediaStreamRef.current || liveStream,
    getFaceStatus: () => faceStatusForLiveRef.current,
    getAnsweredCount: () => Object.keys(answers).length,
    getTotalQuestions: () => questions.length,
    getTimeRemainingSec: () => seconds,
    getStudentName: () => String((student as { fullName?: string } | null)?.fullName || session?.fullName || session?.identifier || "").trim() || null,
    getMatricNumber: () => String((student as { matric?: string | null; matricNumber?: string | null } | null)?.matric || (student as { matricNumber?: string | null } | null)?.matricNumber || session?.identifier || "").trim() || null,
    getCourseCode: () => {
      const c = (examQ.data as { courses?: { code?: string } | { code?: string }[] } | null)?.courses;
      if (Array.isArray(c)) return String(c[0]?.code || "").trim() || null;
      return String((c as { code?: string } | undefined)?.code || "").trim() || null;
    },
    getExamTitle: () => String(examQ.data?.title || "").trim() || null,
    getTabSwitchCount: () => tabSwitchCountRef.current,
  });
  useLiveScreenPublish({
    // Keep enabled for whole exam (hook gates on native share / stream / hold).
    // Do not require MediaStream — Android MediaProjection uses native JPEG path.
    enabled: started && !done && !previewMode,
    schoolId: examQ.data?.school_id ?? student?.schoolId ?? session?.schoolId,
    studentId: student?.studentId,
    examId: id,
    attemptId: liveAttemptId || attemptIdRef.current,
    stream: screenStream,
    getStream: () => screenStreamRef.current || screenStream,
  });
  useLiveMicPublish({
    enabled: started && !done && !previewMode,
    schoolId: examQ.data?.school_id ?? student?.schoolId ?? session?.schoolId,
    studentId: student?.studentId,
    examId: id,
    attemptId: liveAttemptId || attemptIdRef.current,
    getStream: () => mediaStreamRef.current || liveStream,
  });


  

  useExamAttemptHeartbeat({
    enabled: started && !done && !previewMode,
    attemptId: liveAttemptId || attemptIdRef.current,
    getStats: () => ({
      answeredCount: Object.keys(answersRef.current || answers || {}).length,
      totalQuestions: questions.length || undefined,
      timeRemainingSec: endsAtRef.current
        ? Math.max(0, Math.floor((endsAtRef.current - Date.now()) / 1000))
        : (typeof seconds === "number" ? seconds : null),
      tabSwitchCount: tabSwitchCountRef.current,
      faceStatus: faceStatusForLiveRef.current,
      cameraActive: Boolean(mediaStreamRef.current || liveStream),
        screenActive: Boolean(screenStreamRef.current || screenStream),
    }),
  });

  useEffect(() => {
    if (!started || done || previewMode) return;
    const studentId = student?.studentId;
    if (!studentId) return;
    const ch = supabase.channel(`student-exam-warn:${studentId}`);
    ch.on("broadcast", { event: "officer_warning" }, ({ payload }) => {
      const p = payload as { message?: string; examId?: string };
      if (p?.examId && id && String(p.examId) !== String(id)) return;
      if (doneRef.current) return;
      const msg = p?.message || "Warning from examination officer";
      setWarnBanner(msg);
      try { haptic("officer_warning"); } catch { /* ignore */ }
      window.setTimeout(() => setWarnBanner(null), 10000);
    });
    void ch.subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [started, done, previewMode, student?.studentId, id]);

  useEffect(() => {
    if (!started || done || previewMode) return;
    const studentId = student?.studentId;
    if (!studentId) return;
    const ch = supabase.channel(`student-exam-cmd:${studentId}`);
    ch.on("broadcast", { event: "officer_command" }, ({ payload }) => {
      const p = payload as { command?: string; examId?: string; attemptId?: string };
      if (!p?.command) return;
      if (p.examId && id && String(p.examId) !== String(id)) return;
      if (doneRef.current || finishingRef.current) return;
      const cmd = String(p.command).toLowerCase();
      if (cmd === "hold" || cmd === "pause") {
        // Officer pause: indefinite — no auto-resume, no integrity countdown
        officerPauseRef.current = true;
        setIsOfficerPause(true);
        pauseUntilRef.current = null;
        setPauseRemainingSec(null);
        setPauseReason("Paused by the examination officer");
        setPaused(true);
        try { haptic("officer_pause"); } catch { /* ignore */ }
        setWarnBanner("Your examination has been paused by the officer");
        window.setTimeout(() => setWarnBanner(null), 10000);
      } else if (cmd === "release" || cmd === "resume") {
        officerPauseRef.current = false;
        setIsOfficerPause(false);
        pauseUntilRef.current = null;
        setPauseRemainingSec(null);
        setPaused(false);
        setPauseReason("");
        setWarnBanner("Your examination has been resumed by the officer");
        window.setTimeout(() => setWarnBanner(null), 6000);
        // Immediate resume — reconnect media without delay
        void reconnectCamera();
        try { void requestExamFullscreen(); } catch { /* ignore */ }
      } else if (cmd === "terminate") {
        doneTerminatedRef.current = true;
        setDoneTerminated(true);
        setDoneForceSubmit(false);
        setPaused(false);
        try { haptic("officer_submit"); } catch { /* ignore */ }
        void finishAttempt(true, "terminate");
      } else if (cmd === "submit") {
        doneTerminatedRef.current = false;
        setDoneTerminated(false);
        setDoneForceSubmit(true);
        setPaused(false);
        try { haptic("officer_submit"); } catch { /* ignore */ }
        void finishAttempt(false, "auto_submit");
      }
    });
    void ch.subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, done, previewMode, student?.studentId, id, liveAttemptId]);

  // Backup: poll attempt status so officer actions apply if broadcast is missed
  useEffect(() => {
    if (!started || done || previewMode || !student?.studentId || !id) return;
    const attemptId = liveAttemptId || attemptIdRef.current;
    if (!attemptId) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || finishingRef.current || doneRef.current) return;
      try {
        const { data } = await supabase
          .from("exam_attempts")
          .select("status, metadata")
          .eq("id", attemptId)
          .maybeSingle();
        if (!data || cancelled) return;
        const st = String((data as { status?: string }).status || "").toLowerCase();
        const meta = ((data as { metadata?: Record<string, unknown> | null }).metadata || {}) as Record<
          string,
          unknown
        >;
        if (st === "submitted" || st === "flagged") {
          setDoneTerminated(false);
          if (meta.officer_force_submit) setDoneForceSubmit(true);
          void finishAttempt(false);
          return;
        }
        if (st === "terminated") {
          doneTerminatedRef.current = true;
          setDoneTerminated(true);
          void finishAttempt(true, "terminate");
          return;
        }
        const officerHold = meta.officer_hold === true || meta.officer_pause === true || String(meta.officer_hold || "").toLowerCase() === "true" || String(meta.officer_pause || "").toLowerCase() === "true";
        if (st === "paused" || officerHold) {
          if (!pausedRef.current) {
            officerPauseRef.current = true;
            setIsOfficerPause(true);
            pauseUntilRef.current = null;
            setPauseRemainingSec(null);
            setPauseReason("Paused by the examination officer");
            setPaused(true);
          }
        } else if (st === "in_progress" || st === "active" || st === "started") {
          if (pausedRef.current) {
            officerPauseRef.current = false;
            setIsOfficerPause(false);
            pauseUntilRef.current = null;
            setPauseRemainingSec(null);
            setPaused(false);
            setPauseReason("");
            void reconnectCamera();
          }
        }
      } catch {
        /* ignore */
      }
    };
    const t = window.setInterval(() => void poll(), 600);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, done, previewMode, student?.studentId, id, liveAttemptId]);

  // Integrity: fullscreen exit + app background / tab switch

  useEffect(() => {
    calcOpenRef.current = calcOpen;
    try {
      const w = window as unknown as { __d4CalcOpen?: boolean; __d4CloseCalc?: () => void };
      w.__d4CalcOpen = calcOpen;
      w.__d4CloseCalc = () => setCalcOpen(false);
    } catch { /* ignore */ }
    const onCloseEvt = () => setCalcOpen(false);
    window.addEventListener("d4-close-calculator", onCloseEvt);
    return () => {
      window.removeEventListener("d4-close-calculator", onCloseEvt);
      try {
        const w = window as unknown as { __d4CalcOpen?: boolean; __d4CloseCalc?: () => void };
        w.__d4CalcOpen = false;
        w.__d4CloseCalc = undefined;
      } catch { /* ignore */ }
    };
  }, [calcOpen]);

  useEffect(() => {
    if (!started || done || previewMode) return;
    const schoolId = String(examQ.data?.school_id ?? student?.schoolId ?? session?.schoolId ?? "");
    const studentId = student?.studentId;
    if (!schoolId || !studentId || !id) return;

    const DEBOUNCE_MS = 1200;

    const applyConsequence = async (eventType: string, description: string) => {
      const now = Date.now();
      if (now - lastViolationAtRef.current < DEBOUNCE_MS) return;
      lastViolationAtRef.current = now;

      const action = String(security.thresholdAction || "flag").toLowerCase();
      void logSecurityEvent({
        schoolId, examId: id, attemptId: attemptIdRef.current, studentId,
        eventType, severity: action === "terminate" ? "high" : "medium",
        description, questionIndex: index,
        extra: {
          tab_switch_count: tabSwitchCountRef.current,
          fullscreen_exit_count: fullscreenExitCountRef.current,
          threshold_action: action,
        },
      });

      try { haptic("tab_switch"); } catch { /* ignore */ }

      if (action === "warn" || action === "flag") {
        setWarnBanner(description);
        window.setTimeout(() => setWarnBanner(null), 6000);
      } else if (action === "pause") {
        beginTimedPause(description);
      } else if (action === "terminate") {
        doneTerminatedRef.current = true;
        setDoneTerminated(true);
        await finishAttempt(true, "terminate");
      } else if (action === "auto_submit" || action === "submit") {
        doneTerminatedRef.current = false;
        setDoneTerminated(false);
        await finishAttempt(true, "auto_submit");
      }
    };

    const recordTabLeave = () => {
      if (finishingRef.current || doneRef.current) return;
      if (calcOpenRef.current || (window as unknown as { __d4CalcOpen?: boolean }).__d4CalcOpen) return;
      if (!security.tabMonitoring) {
        leftExamSessionRef.current = true;
        void flushAttemptProgress();
        return;
      }
      if (pausedRef.current) {
        leftExamSessionRef.current = true;
        void flushAttemptProgress();
        return;
      }
      const now = Date.now();
      if (now - lastTabHiddenAtRef.current < 600) return;
      lastTabHiddenAtRef.current = now;
      leftExamSessionRef.current = true;
      tabSwitchCountRef.current += 1;
      setTabSwitchCount(tabSwitchCountRef.current);
      try {
        reshuffleOnTabLeaveRef.current();
      } catch { /* ignore */ }
      void flushAttemptProgress();
      if (attemptIdRef.current) {
        void (async () => {
          try {
            const aid = attemptIdRef.current!;
            const { data: prevRow } = await supabase.from("exam_attempts").select("metadata").eq("id", aid).maybeSingle();
            const prevMeta = prevRow?.metadata && typeof prevRow.metadata === "object" && !Array.isArray(prevRow.metadata)
              ? (prevRow.metadata as Record<string, unknown>)
              : {};
            await supabase.from("exam_attempts").update({
              tab_switch_count: tabSwitchCountRef.current,
              answers: answersRef.current,
              ends_at: endsAtRef.current ? new Date(endsAtRef.current).toISOString() : undefined,
              metadata: {
                ...prevMeta,
                tabSwitchCount: tabSwitchCountRef.current,
                lastSeenAt: new Date().toISOString(),
                lastTabLeaveAt: new Date().toISOString(),
              },
              updated_at: new Date().toISOString(),
            } as never).eq("id", aid);
          } catch (e) {
            console.warn("[cbt] tab_switch persist", e);
          }
        })();
      }
      const max = Math.max(1, Number(security.maxTabSwitches) || 5);
      if (tabSwitchCountRef.current >= max) {
        void applyConsequence(
          "TAB_SWITCH",
          `Left the exam window (switch ${tabSwitchCountRef.current}/${max}). Threshold reached.`,
        );
      } else {
        void logSecurityEvent({
          schoolId, examId: id, attemptId: attemptIdRef.current, studentId,
          eventType: "TAB_SWITCH", severity: "low",
          description: `Left the exam window (switch ${tabSwitchCountRef.current}/${max}).`,
          questionIndex: index,
        });
        setWarnBanner(`Stay on the exam screen. Switches: ${tabSwitchCountRef.current}/${max}`);
        try { haptic("tab_switch"); } catch { /* ignore */ }
        window.setTimeout(() => setWarnBanner(null), 4000);
      }
    };

    const onReturnToExam = () => {
      if (leftExamSessionRef.current) {
        const ids = new Set(
          Object.keys(answersRef.current).filter(
            (k) => answersRef.current[k] !== undefined && answersRef.current[k] !== null,
          ),
        );
        if (ids.size) {
          setLockedAnswerIds((prev) => {
            const next = new Set(prev);
            ids.forEach((id) => next.add(id));
            return next;
          });
        }
        leftExamSessionRef.current = false;
      }
      // Resume live clock immediately (do not leave UI frozen)
      try {
        const ends = endsAtRef.current;
        if (ends != null) {
          setSeconds(Math.max(0, Math.ceil((ends - Date.now()) / 1000)));
        }
      } catch { /* ignore */ }
      // Never leave the exam UI blocked after background/return
      try {
        setFsGate(false);
      } catch { /* ignore */ }
      void flushAttemptProgress();
      // Restart camera / face monitoring promptly (retry if needed)
      void (async () => {
        try {
          await reconnectCamera();
        } catch {
          try {
            await new Promise((r) => setTimeout(r, 500));
            await reconnectCamera();
          } catch { /* ignore */ }
        }
        try {
          window.dispatchEvent(new CustomEvent("d4-cbt-resume"));
        } catch { /* ignore */ }
      })();
    };

    const onFsChange = () => {
      if (finishingRef.current || doneRef.current) return;
      if (!security.fullscreen) return;
      // Native app: Fullscreen API is unreliable — never hard-block the exam UI
      try {
        if (typeof window !== "undefined" && (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) {
          setFsGate(false);
          return;
        }
      } catch { /* ignore */ }
      if (document.fullscreenElement) {
        setFsGate(false);
        return;
      }
      fullscreenExitCountRef.current += 1;
      setFsGate(true);
      if (attemptIdRef.current) {
        void supabase.from("exam_attempts").update({
          fullscreen_exit_count: fullscreenExitCountRef.current,
        } as never).eq("id", attemptIdRef.current);
      }
      const max = Math.max(1, Number(security.maxTabSwitches) || 5);
      if (fullscreenExitCountRef.current >= max) {
        void applyConsequence(
          "FULLSCREEN_EXIT",
          `Fullscreen exited (exit ${fullscreenExitCountRef.current}/${max}). Threshold reached.`,
        );
      } else {
        void logSecurityEvent({
          schoolId, examId: id, attemptId: attemptIdRef.current, studentId,
          eventType: "FULLSCREEN_EXIT", severity: "low",
          description: `Fullscreen exited (exit ${fullscreenExitCountRef.current}/${max}).`,
          questionIndex: index,
        });
        setWarnBanner(`Return to fullscreen. Exits: ${fullscreenExitCountRef.current}/${max}`);
        window.setTimeout(() => setWarnBanner(null), 4000);
      }
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") {
        recordTabLeave();
      } else if (document.visibilityState === "visible") {
        onReturnToExam();
      }
    };

    const onPageHide = () => {
      recordTabLeave();
    };

    const onWindowBlur = () => {
      // Only treat as leave when the document is actually hidden (true tab switch / app background).
      // Blur alone (keyboard, permission dialog, OS sheet) must NOT freeze the exam.
      if (document.visibilityState !== "hidden") return;
      recordTabLeave();
    };

    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("blur", onWindowBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, done, previewMode, student?.studentId, id, liveAttemptId, security.tabMonitoring, security.maxTabSwitches, security.thresholdAction, security.fullscreen, flushAttemptProgress]);




  const questionsToAnswer = useMemo(() => {
    const fromExam = (examQ.data as { questions_to_answer?: number | null } | null)?.questions_to_answer;
    if (typeof fromExam === "number" && fromExam > 0) return Math.floor(fromExam);
    const row = (settingsQ.data as { questions_to_answer?: number } | null)?.questions_to_answer;
    if (typeof row === "number" && row > 0) return Math.floor(row);
    const meta = parseExamMeta(examQ.data?.description);
    return meta.questionsToAnswer && meta.questionsToAnswer > 0 ? meta.questionsToAnswer : null;
  }, [examQ.data, settingsQ.data, examQ.data?.description]);

  const basePaper = useMemo(() => {
    const key = student?.studentId ?? (previewMode ? "officer-preview" : session?.userId ?? "anon");
    const paper = prepareStudentPaper((questionsQ.data ?? []) as never, {
      questionsToAnswer,
      randomizeQuestions: Boolean(security.randomizeQuestions),
      randomizeOptions: Boolean(security.randomizeOptions),
      studentKey: key,
      examId: id,
    });
    const locked = orderedIdsRef.current;
    if (locked && locked.length) {
      const byId = new Map(paper.map((q) => [q.id, q]));
      const ordered = locked.map((qid) => byId.get(qid)).filter(Boolean) as typeof paper;
      if (ordered.length) return ordered;
    }
    return paper;
  }, [questionsQ.data, questionsToAnswer, security.randomizeQuestions, security.randomizeOptions, student?.studentId, session?.userId, previewMode, id]);

  const questions = livePaper ?? basePaper;

  // Keep tab-leave reshuffle function fresh without rebinding visibility listeners every render
  reshuffleOnTabLeaveRef.current = () => {
    try {
      if (previewMode || doneRef.current || finishingRef.current) return;
      const key = student?.studentId ?? session?.userId ?? "anon";
      const fullBank = prepareStudentPaper((questionsQ.data ?? []) as never, {
        questionsToAnswer: null,
        randomizeQuestions: false,
        randomizeOptions: Boolean(security.randomizeOptions),
        studentKey: key,
        examId: id,
      });
      const current = livePaperRef.current ?? basePaper;
      if (!current.length) return;
      const next = reshuffleUnansweredPaper(fullBank, current, answersRef.current, {
        examId: id,
        studentKey: key,
        salt: `${tabSwitchCountRef.current}:${Date.now()}`,
        randomizeOptions: Boolean(security.randomizeOptions) || true,
      });
      // Only update if something actually changed among unanswered
      const changed = next.some((q, i) => q.id !== current[i]?.id);
      if (!changed) return;
      setLivePaper(next);
      livePaperRef.current = next;
      orderedIdsRef.current = next.map((q) => q.id);
      setWarnBanner("Unanswered questions were changed after you left the exam tab.");
      window.setTimeout(() => setWarnBanner(null), 7000);
      // Persist new order on attempt when possible
      const aid = attemptIdRef.current;
      if (aid) {
        void supabase
          .from("exam_attempts")
          .update({
            question_order: next.map((q) => q.id),
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id", aid);
      }
    } catch (e) {
      console.warn("[cbt] tab-leave reshuffle", e);
    }
  };

  const TOTAL = questions.length;
  const q = questions[index];
  const answeredCount = Object.keys(answers).filter((k) => {
    const v = answers[k];
    if (v == null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  }).length;


  // Push live answered count to officer quickly when answers change
  useEffect(() => {
    if (!started || done || previewMode || !attemptIdRef.current) return;
    const aid = attemptIdRef.current;
    const tId = window.setTimeout(() => {
      void import("@/lib/cbt-attempt-heartbeat").then(({ pulseExamAttempt }) => {
        void pulseExamAttempt(aid, {
          answeredCount: Object.keys(answersRef.current).length,
          totalQuestions: questions.length || undefined,
          timeRemainingSec: endsAtRef.current
            ? Math.max(0, Math.floor((endsAtRef.current - Date.now()) / 1000))
            : null,
          tabSwitchCount: tabSwitchCountRef.current,
        });
      });
    }, 350);
    return () => window.clearTimeout(tId);
  }, [answers, started, done, previewMode, questions.length]);

  // Persist answers + ends_at while in progress (resume safety)
  useEffect(() => {
    if (!started || done || previewMode || !attemptIdRef.current) return;
    if (!Object.keys(answers).length) return;
    const aid = attemptIdRef.current;
    const tId = window.setTimeout(() => {
      void supabase.from("exam_attempts").update({
        answers: answersRef.current,
        ends_at: endsAtRef.current ? new Date(endsAtRef.current).toISOString() : undefined,
        status: "in_progress",
        updated_at: new Date().toISOString(),
      } as never).eq("id", aid);
    }, 300);
    return () => window.clearTimeout(tId);
  }, [answers, started, done, previewMode]);

  const faceWarnCountRef = useRef(0);
  const onFaceSecurityEvent = useCallback((ev: FaceSecurityEvent) => {
    faceStatusForLiveRef.current = ev.kind === "ok" ? "ok" : ev.kind;
    if (previewMode || doneRef.current) return;
    const mapped = mapFaceSecurityEvent(ev.kind, ev.faceCount);
    const schoolId = String(examQ.data?.school_id ?? student?.schoolId ?? session?.schoolId ?? "");
    const studentId = student?.studentId;
    if (!schoolId || !studentId || !id) return;
    const isViolation = ev.kind === "none" || ev.kind === "multi" || ev.kind === "camera_blocked";
    if (isViolation) faceWarnCountRef.current += 1;
    // Haptic already fired by ExamCameraPip — avoid double-buzz disturbance
    void logSecurityEvent({
      schoolId, examId: id, attemptId: attemptIdRef.current, studentId,
      eventType: mapped.eventType, severity: mapped.severity, description: mapped.description,
      extra: { faceCount: ev.faceCount, source: "ExamCameraPip", warnCount: faceWarnCountRef.current },
    });
    // Face monitoring: detect + log + brief banner only.
    // Tab violations alone use limits and pause/terminate consequences.
    if (!isViolation) return;
    setWarnBanner(mapped.description || "Face integrity notice");
    window.setTimeout(() => setWarnBanner(null), 4500);
  }, [previewMode, examQ.data?.school_id, student?.studentId, student?.schoolId, session?.schoolId, id, security.maxFaceWarnings, security.faceViolationAction, security.thresholdAction]);

  function requestSubmit() {
    if (done || finishingRef.current || previewMode) return;
    setShowSubmitConfirm(true);
  }

  async function confirmSubmit() {
    setShowSubmitConfirm(false);
    await finishAttempt(false);
  }

  async function finishAttempt(auto = false, mode: "submit" | "terminate" | "auto_submit" = auto ? "auto_submit" : "submit") {
    if (done || finishingRef.current) return;
    finishingRef.current = true;
    const isTerminated = mode === "terminate" || doneTerminatedRef.current === true;
    if (isTerminated) {
      doneTerminatedRef.current = true;
      setDoneTerminated(true);
    }
    try { haptic("officer_submit"); } catch { /* ignore */ }
    doneRef.current = true;
    setFsGate(false);
    setPaused(false);
    setDone(true); // immediate UI exit — no camera reconnect flash
    shutdownMedia();
    void leaveExamFullscreen();
    if (previewMode) {
      toast.message("Preview ended — nothing was saved");
      finishingRef.current = false;
      return;
    }
    try {
      if (student?.studentId && examQ.data) {
        let attemptId = attemptIdRef.current;
        if (!attemptId) {
          const { data } = await supabase.from("exam_attempts").upsert({
            exam_id: id, student_id: student.studentId, school_id: examQ.data?.school_id,
            status: "in_progress", started_at: new Date().toISOString(), answers,
          } as never, { onConflict: "exam_id,student_id" }).select("id").maybeSingle();
          attemptId = (data?.id as string) ?? null;
          attemptIdRef.current = attemptId;
        }
        const schoolId = String(examQ.data.school_id ?? student.schoolId ?? "");
        const saved = await saveCbtResult({
          examId: id, studentId: student.studentId, schoolId, attemptId,
          questions: questions.map((qq) => ({
            id: qq.id, marks: qq.marks ?? 1, correct_answer: qq.correct_answer,
            options: qq.options ?? [],
            originalOptions: (qq as { originalOptions?: string[] }).originalOptions ?? [],
            correctOptionText: (qq as { correctOptionText?: string | null }).correctOptionText ?? null,
          })),
          answers: answersRef.current, terminated: isTerminated, resultVisibility: security.resultVisibility,
        });
        // Guarantee attempt leaves in_progress (time-up / submit) so monitoring maps the live paper
        if (attemptId) {
          try {
            await supabase.from("exam_attempts").update({
              status: isTerminated ? "terminated" : "submitted",
              submitted_at: new Date().toISOString(),
              answers: answersRef.current,
              updated_at: new Date().toISOString(),
            } as never).eq("id", attemptId);
          } catch { /* ignore */ }
        }
        if (isTerminated) {
          setResultId(null);
          resultIdRef.current = null;
        } else if (saved.error) {
          toast.error(saved.error.message);
        } else {
          let rid = saved.resultId ?? null;
          if (!rid) {
            const { data: res } = await supabase.from("results").select("id").eq("exam_id", id).eq("student_id", student.studentId).maybeSingle();
            rid = (res?.id as string) ?? null;
          }
          if (rid) { setResultId(rid); resultIdRef.current = rid; }
          toast.success(saved.published ? "Examination submitted — result is available now" : "Examination submitted successfully");
        }
        await qc.invalidateQueries({ queryKey: ["student-exams"] });
      } else toast.success(auto ? "Examination closed" : "Examination submitted successfully");
    } catch (e) { toast.error(friendlyError(e, "Could not save result")); }
    // terminate flag set only for real terminate
    setDone(true);
    shutdownMedia();
    finishingRef.current = false;
  }

  async function beginWithMedia(_opts: { skipScreenShare: boolean; caps: DeviceCapabilities }) {
    setMediaBusy(true);
    try {
      if (!previewMode && student?.studentId) {
        const { data: existing } = await supabase.from("exam_attempts").select("id, status").eq("exam_id", id).eq("student_id", student.studentId).maybeSingle();
        if (existing && ["submitted", "terminated", "flagged"].includes(String(existing.status))) {
          toast.error("You have already completed this examination.");
          shutdownMedia(); setDone(true); return;
        }
        if (existing?.id) {
          attemptIdRef.current = existing.id as string;
          setLiveAttemptId(existing.id as string);
        }
      }
      const needCam = Boolean(security.requireCamera);
      const needMic = Boolean(security.requireMicrophone || security.requireCamera);
      if (needCam || needMic) {
        try {
          let stream: MediaStream;
          if (needCam) {
            stream = await openCameraStream({ facingMode: "user", audio: needMic });
          } else {
            const mic = await ensureMicrophonePermission();
            if (!mic.granted) throw new Error(mic.error || "Microphone required");
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          }
          stopMediaStream(mediaStreamRef.current);
          mediaStreamRef.current = stream;
          setLiveStream(stream);
          examSafeToast.success(needCam ? "Camera ready" : "Microphone ready");
        } catch {
          examSafeToast.error(needCam ? "Camera is required for this examination." : "Microphone is required for this examination.");
          return;
        }
      }
      // Enter exam UI immediately — no navy/blank hold while remaining setup finishes
      setStarted(true);
      startedRef.current = true;
      const needScreen = Boolean(security.requireScreenShare) && !_opts.skipScreenShare;
      if (needScreen) {
        holdExamScreenShare(true);
        try {
          examSafeToast.message("Preparing screen sharing…");
        } catch { /* ignore */ }
        let share = await startScreenShareStream();
        // Recoverable native races (FGS/MediaProjection timing): one automatic retry
        if (!share.ok && share.reason !== "denied") {
          await new Promise((r) => window.setTimeout(r, 900));
          share = await startScreenShareStream();
        }
        if (!share.ok) {
          holdExamScreenShare(false);
          examSafeToast.error(
            share.message ||
              "Screen sharing could not start. Allow notifications and screen capture, then try Start again.",
          );
          setStarted(false);
          startedRef.current = false;
          setFsGate(false);
          return;
        }
        // reuse keeps MediaProjection alive across Gate → CBT navigation
        screenStreamRef.current = share.stream;
        setScreenStream(share.stream);
        onScreenShareEnded(share.stream, () => {
          setWarnBanner("Screen sharing stopped. Re-enable to continue the exam."); window.setTimeout(() => setWarnBanner(null), 6000);;
          officerPauseRef.current = false;
          setIsOfficerPause(false);
          setPaused(true);
          setPauseReason("Screen sharing stopped — re-enable to continue");
          setScreenStream(null);
          screenStreamRef.current = null;
        });
        examSafeToast.success("Screen sharing active");
      }
      try { primeHaptics(); haptic("start"); } catch { /* ignore */ }
      if (security.fullscreen) {
        try {
          const ok = await requestExamFullscreen();
          if (!ok) {
            // Never freeze CBT: show tip but keep exam usable (critical on Capacitor WebView)
            examSafeToast.message("Stay on this screen for the duration of the exam.");
            setFsGate(false);
          } else {
            setFsGate(false);
          }
        } catch {
          setFsGate(false);
        }
      }
      if (!previewMode && student?.studentId && examQ.data?.school_id) {
        // Load existing attempt for stable question set
        const { data: existingFull } = await supabase
          .from("exam_attempts")
          .select("id, status, question_order, tab_switch_count, fullscreen_exit_count, answers, ends_at, started_at, metadata")
          .eq("exam_id", id)
          .eq("student_id", student.studentId)
          .maybeSingle();
        if (existingFull?.id) {
          attemptIdRef.current = existingFull.id as string;
          setLiveAttemptId(existingFull.id as string);
          tabSwitchCountRef.current = Number(existingFull.tab_switch_count ?? 0);
          setTabSwitchCount(tabSwitchCountRef.current);
          fullscreenExitCountRef.current = Number(existingFull.fullscreen_exit_count ?? 0);
          // Restore timed pause if still active
          try {
            const meta = (existingFull as { metadata?: Record<string, unknown> }).metadata;
            const pu = meta && typeof meta === "object" ? Number((meta as { pauseUntil?: unknown }).pauseUntil) : NaN;
            if (Number.isFinite(pu) && pu > Date.now()) {
              pauseUntilRef.current = pu;
              setPauseRemainingSec(Math.max(0, Math.ceil((pu - Date.now()) / 1000)));
              setPauseReason(String((meta as { pauseReason?: string }).pauseReason || "Exam paused"));
              setPaused(true);
            }
          } catch { /* ignore */ }
          const qo = existingFull.question_order;
          if (Array.isArray(qo) && qo.length) {
            orderedIdsRef.current = qo.map(String);
          }
          if (existingFull.answers && typeof existingFull.answers === "object") {
            const prev = existingFull.answers as Record<string, number>;
            setAnswers(prev);
            const lockedIds = new Set(Object.keys(prev).filter((k) => prev[k] !== undefined && prev[k] !== null));
            setLockedAnswerIds(lockedIds);
            try {
              const ordered = orderedIdsRef.current || [];
              let idx = 0;
              for (let i = 0; i < ordered.length; i++) {
                const qid = ordered[i];
                if (prev[qid] === undefined || prev[qid] === null) { idx = i; break; }
                if (i === ordered.length - 1) idx = i;
              }
              resumeIndexRef.current = idx;
              setIndex(idx);
            } catch {}
          }
        }
        
        // Restore absolute end clock from attempt (do not reset timer on Continue)
        try {
          const ea = (existingFull as { ends_at?: string | null } | null)?.ends_at;
          const sa = (existingFull as { started_at?: string | null } | null)?.started_at;
          const mins = Math.max(1, Number(examQ.data?.duration_minutes ?? 60));
          const nowMs = Date.now();
          let endsMs: number | null = null;
          if (ea) {
            const ends = new Date(String(ea)).getTime();
            if (!Number.isNaN(ends)) endsMs = ends;
          }
          if (endsMs == null && sa) {
            const startMs = new Date(String(sa)).getTime();
            if (!Number.isNaN(startMs)) endsMs = startMs + mins * 60_000;
          }
          if (endsMs != null && endsMs > nowMs + 2_000) {
            // Valid remaining time — continue from saved clock
            endsAtRef.current = endsMs;
            setSeconds(Math.max(1, Math.ceil((endsMs - nowMs) / 1000)));
            if (!ea && attemptIdRef.current) {
              void supabase.from("exam_attempts").update({
                ends_at: new Date(endsMs).toISOString(),
              } as never).eq("id", attemptIdRef.current);
            }
          } else if (endsMs != null && endsMs <= nowMs + 2_000) {
            // Stale/expired ends_at while still opening exam: start a FRESH full duration
            // (true time-up while writing is handled by the live timer + auto_submit)
            endsAtRef.current = null;
            setSeconds(null);
          }
        } catch { /* ignore */ }
// Build paper now so we can lock order
        const key = student.studentId;
        const paper = prepareStudentPaper((questionsQ.data ?? []) as never, {
          questionsToAnswer,
          randomizeQuestions: Boolean(security.randomizeQuestions),
          randomizeOptions: Boolean(security.randomizeOptions),
          studentKey: key,
          examId: id,
        });
        const orderIds = orderedIdsRef.current?.length
          ? orderedIdsRef.current
          : paper.map((q) => q.id);
        orderedIdsRef.current = orderIds;

        if (!attemptIdRef.current) {
          const studentName = String((student as { fullName?: string } | null)?.fullName || session?.fullName || "").trim() || undefined;
          const { data } = await supabase.from("exam_attempts").upsert({
            exam_id: id, student_id: student.studentId, school_id: examQ.data?.school_id,
            status: "in_progress", started_at: new Date().toISOString(), answers: {},
            question_order: orderIds,
            metadata: { studentName: studentName || session?.fullName || undefined, matricNumber: String((student as { matricNumber?: string } | null)?.matricNumber || (student as { matric?: string } | null)?.matric || session?.identifier || "").trim() || undefined, courseCode: (Array.isArray((examQ.data as { courses?: { code?: string }[] } | null)?.courses) ? String((examQ.data as { courses: { code?: string }[] }).courses[0]?.code || "").trim() : String((examQ.data as { courses?: { code?: string } } | null)?.courses?.code || "").trim()) || undefined, examTitle: String(examQ.data?.title || "").trim() || undefined, lastSeenAt: new Date().toISOString() },
          } as never, { onConflict: "exam_id,student_id" }).select("id").maybeSingle();
          if (data?.id) { attemptIdRef.current = data.id as string; setLiveAttemptId(data.id as string); }
        } else {
          // Persist order if missing
          const studentNameUpd = String((student as { fullName?: string } | null)?.fullName || session?.fullName || "").trim() || undefined;
          const matricUpd = String((student as { matric?: string | null } | null)?.matric || "").trim() || undefined;
          void (async () => {
            try {
              const { data: prevRow } = await supabase.from("exam_attempts").select("metadata").eq("id", attemptIdRef.current!).maybeSingle();
              const prevMeta = prevRow?.metadata && typeof prevRow.metadata === "object" && !Array.isArray(prevRow.metadata) ? (prevRow.metadata as Record<string, unknown>) : {};
              await supabase.from("exam_attempts").update({
                question_order: orderIds,
                status: "in_progress",
                metadata: { ...prevMeta, studentName: studentNameUpd || prevMeta.studentName, matricNumber: matricUpd || prevMeta.matricNumber, courseCode: (Array.isArray((examQ.data as { courses?: { code?: string }[] } | null)?.courses) ? String((examQ.data as { courses: { code?: string }[] }).courses[0]?.code || prevMeta.courseCode || "").trim() : String((examQ.data as { courses?: { code?: string } } | null)?.courses?.code || prevMeta.courseCode || "").trim()) || prevMeta.courseCode, examTitle: String(examQ.data?.title || prevMeta.examTitle || "").trim() || prevMeta.examTitle, lastSeenAt: new Date().toISOString() },
              } as never).eq("id", attemptIdRef.current!);
            } catch (e) { console.warn("[cbt] metadata merge", e); }
          })();
        }
      }
      {
        const durationSec = Math.max(60, Number(examQ.data?.duration_minutes ?? 60) * 60);
        const now = Date.now();
        // If saved ends_at already expired, discard and allocate a full fresh window
        if (endsAtRef.current != null && endsAtRef.current <= now + 2_000) {
          endsAtRef.current = null;
        }
        if (endsAtRef.current != null && endsAtRef.current > now + 2_000) {
          setSeconds(Math.max(1, Math.ceil((endsAtRef.current - now) / 1000)));
        } else {
          let ends = now + durationSec * 1000;
          const schedEnd = examQ.data?.scheduled_end ? new Date(String(examQ.data.scheduled_end)).getTime() : NaN;
          // Only clamp to scheduled_end when it still leaves meaningful time
          if (!Number.isNaN(schedEnd) && schedEnd > now + 60_000) {
            ends = Math.min(ends, schedEnd);
          }
          endsAtRef.current = ends;
          setSeconds(Math.max(1, Math.ceil((ends - now) / 1000)));
          if (attemptIdRef.current) {
            void supabase.from("exam_attempts").update({
              ends_at: new Date(ends).toISOString(),
              status: "in_progress",
              updated_at: new Date().toISOString(),
            } as never).eq("id", attemptIdRef.current);
          }
        }
      }
      if (!(orderedIdsRef.current && orderedIdsRef.current.length)) {
        setIndex(0);
      }
    } finally { setMediaBusy(false); }
  }

  async function restoreFullscreenFromUser() {
    try {
      const ok = await requestExamFullscreen();
      if (ok) {
        setFsGate(false);
        examSafeToast.success("Fullscreen restored");
        return;
      }
    } catch { /* ignore */ }
    // Never freeze the exam — allow continue even if browser blocks fullscreen
    setFsGate(false);
    examSafeToast.message("Could not re-enter fullscreen. Continue your exam — stay on this tab.");
  }

  async function goToResult() {
    shutdownMedia();
    let targetId = resultIdRef.current || resultId;
    if (student?.studentId && !targetId) {
      const { data: res } = await supabase.from("results").select("id").eq("exam_id", id).eq("student_id", student.studentId).maybeSingle();
      targetId = (res?.id as string) ?? null;
    }
    void navigate({ to: "/student/results/$id", params: { id: targetId || id } });
  }

  if (examQ.isLoading || questionsQ.isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading examination…</p>
      </div>
    );
  }
  const exam = examQ.data;
  if (!exam) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <p className="font-bold">Examination not found</p>
        <Button className="mt-4" asChild><Link to={previewMode ? "/officer/approvals" : "/student/examinations"}>Back</Link></Button>
      </div>
    );
  }
  if (done) {
    if (doneTerminated || doneTerminatedRef.current) {
      return (
        <div className="grid min-h-dvh place-items-center bg-red-50 p-4">
          <div className="w-full max-w-lg rounded-2xl border-2 border-red-300 bg-white p-6 text-center shadow-sm">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-600">
              <span className="text-3xl font-black" aria-hidden>!</span>
            </div>
            <SchoolLogo logoUrl={resolvedLogoUrl} schoolName={resolvedSchoolName} size="md" className="mx-auto mt-3" />
            <h1 className="mt-4 text-2xl font-black uppercase tracking-tight text-red-700">
              Examination terminated
            </h1>
            <p className="mt-3 text-sm font-medium text-red-900/90">
              Your examination has been terminated for an examination violation.
              No result was recorded for this attempt.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Contact your examination officer if you believe this was a mistake.
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button variant="outline" className="font-semibold border-red-200 text-red-800" asChild>
                <Link to={previewMode ? "/officer/approvals" : "/student/examinations"}>
                  {previewMode ? "Back" : "Back to examinations"}
                </Link>
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-50 p-4">
        <div className="w-full max-w-lg rounded-2xl border bg-white p-6 text-center shadow-sm">
          <SchoolLogo logoUrl={resolvedLogoUrl} schoolName={resolvedSchoolName} size="lg" className="mx-auto" />
          <h1 className="mt-4 text-2xl font-extrabold">
            {previewMode ? "Preview ended" : "EXAM SUBMITTED"}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {previewMode
              ? "Officer preview finished."
              : "Your examination has been submitted. Your examination is no longer active."}
          </p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            {!previewMode && (<Button className="font-semibold" onClick={() => void goToResult()}>View Results</Button>)}
            <Button variant="outline" className="font-semibold" asChild>
              <Link to={previewMode ? "/officer/approvals" : "/student/examinations"}>{previewMode ? "Back" : "Back to examinations"}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (alreadyFinished) {
    const priorTerminated = String(priorAttemptQ.data?.attemptStatus || "").toLowerCase() === "terminated";
    if (priorTerminated) {
      return (
        <div className="grid min-h-dvh place-items-center bg-red-50 p-4">
          <div className="w-full max-w-lg rounded-2xl border-2 border-red-300 bg-white p-6 text-center shadow-sm">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-600">
              <span className="text-3xl font-black" aria-hidden>!</span>
            </div>
            <h1 className="mt-4 text-2xl font-black uppercase tracking-tight text-red-700">
              Examination terminated
            </h1>
            <p className="mt-3 text-sm font-medium text-red-900/90">
              This examination was terminated for a violation. No result is available.
            </p>
            <div className="mt-6">
              <Button variant="outline" className="font-semibold border-red-200 text-red-800" asChild>
                <Link to="/student/examinations">Back to examinations</Link>
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-50 p-4">
        <div className="w-full max-w-lg rounded-2xl border bg-white p-6 text-center shadow-sm">
          <SchoolLogo logoUrl={resolvedLogoUrl} schoolName={resolvedSchoolName} size="lg" className="mx-auto" />
          <h1 className="mt-4 text-2xl font-extrabold">Examination already completed</h1>
          <p className="mt-2 text-sm text-slate-600">
            You have already submitted or finished this examination. Retakes are not allowed.
          </p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button className="font-semibold" onClick={() => void goToResult()}>View Results</Button>
            <Button variant="outline" className="font-semibold" asChild>
              <Link to="/student/examinations">Back to examinations</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (!started) {
    return (
      <ExamSecurityGate
        examTitle={previewMode ? `${exam.title} (Officer preview)` : exam.title}
        courseLine={`${(exam as { courses?: { code?: string; name?: string } }).courses?.code ?? ""} · ${(exam as { courses?: { code?: string; name?: string } }).courses?.name ?? ""}`}
        durationMinutes={exam.duration_minutes ?? 60}
        totalQuestions={TOTAL}
        security={security}
        busy={mediaBusy}
        schoolLogoUrl={resolvedLogoUrl}
        schoolName={resolvedSchoolName}
        windowLabel={previewMode ? "Officer interactive preview" : formatExamWindow(exam.scheduled_start, exam.scheduled_end)}
        cancelTo={previewMode ? "/officer/approvals" : "/student/examinations"}
        onStart={(opts) => void beginWithMedia(opts)}
      />
    );
  }
  if (TOTAL === 0) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <p className="font-bold">No active questions for this course</p>
        <Button className="mt-4" asChild><Link to={previewMode ? "/officer/approvals" : "/student/examinations"}>Back</Link></Button>
      </div>
    );
  }
  const mm = String(Math.floor((seconds ?? 0) / 60)).padStart(2, "0");
  const ss = String((seconds ?? 0) % 60).padStart(2, "0");
  return (
    <div className="d4-cbt-exam relative flex h-dvh flex-col overflow-hidden bg-slate-50 select-none">
      {previewMode && (
        <div className="shrink-0 bg-amber-500 px-3 py-1.5 text-center text-xs font-bold text-white">
          OFFICER PREVIEW — answers are not saved
        </div>
      )}
      <header
        className="d4-cbt-header sticky top-0 z-40 shrink-0 border-b border-slate-200 bg-[#0b1b3a] text-white"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="mx-auto flex min-h-14 max-w-[1200px] items-center justify-between gap-2 px-3 py-2 sm:min-h-16 sm:gap-3 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
            <SchoolLogo logoUrl={resolvedLogoUrl} schoolName={resolvedSchoolName} size="md" className="shrink-0 bg-transparent" />
            <p className="min-w-0 truncate text-xs font-bold leading-tight sm:text-sm">
              {(exam as { courses?: { code?: string } }).courses?.code ?? "EXAM"}
              <span className="font-semibold text-white/80"> — {exam.title}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={
                (seconds != null && seconds <= 300
                  ? "rounded-lg bg-red-600 px-3 py-1.5 font-mono text-sm font-bold tabular-nums text-white shadow-lg shadow-red-900/40 animate-pulse ring-2 ring-red-300/80"
                  : "rounded-lg bg-white/10 px-3 py-1.5 font-mono text-sm font-bold tabular-nums")
              }
              title={seconds != null && seconds <= 300 ? "Less than 5 minutes remaining" : "Time remaining"}
            >
              {mm}:{ss}
              {seconds != null && seconds <= 300 && seconds > 0 ? (
                <span className="ml-1.5 hidden text-[10px] font-semibold uppercase tracking-wide sm:inline">left</span>
              ) : null}
            </div>
            <Button size="sm" variant="secondary" className="font-semibold" onClick={() => void requestSubmit()}>Submit</Button>
          </div>
        </div>
      </header>
            <main className="d4-cbt-scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]">
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 gap-4 p-3 pb-8 sm:p-6 lg:grid-cols-[220px_1fr]">
        <aside className="order-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:order-1">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Questions</p>
          <div className="mt-3 grid grid-cols-5 gap-2">
            {questions.map((qq, i) => {
              const answered = (() => {
                const v = answers[qq.id];
                if (v == null) return false;
                if (typeof v === "string") return v.trim().length > 0;
                return true;
              })();
              const isFlag = flagged.has(qq.id);
              const isCurrent = i === index;
              return (
                <button key={qq.id} type="button" onClick={() => setIndex(i)}
                  className={cn("grid h-9 place-items-center rounded-md text-xs font-bold transition",
                    isCurrent && "bg-primary text-white ring-2 ring-primary/30",
                    !isCurrent && answered && "bg-emerald-500 text-white",
                    !isCurrent && isFlag && !answered && "bg-amber-400 text-slate-900",
                    !isCurrent && !answered && !isFlag && "border border-slate-200 bg-white text-slate-700 hover:border-primary")}>
                  {i + 1}
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-slate-500">Answered <span className="font-bold text-slate-800">{answeredCount}</span> / {TOTAL}</p>
        </aside>
        <section className="order-1 flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6 lg:order-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-primary">Question <span className="text-primary">{index + 1}</span> of {TOTAL}</p>
            <button type="button" onClick={() => {
              if (!q) return;
              setFlagged((prev) => { const next = new Set(prev); if (next.has(q.id)) next.delete(q.id); else next.add(q.id); return next; });
            }} className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold",
              q && flagged.has(q.id) ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 text-slate-600")}>
              <Flag className="h-3.5 w-3.5" />{q && flagged.has(q.id) ? "Marked" : "Mark for Review"}
            </button>
          </div>
          <h1 className="mt-4 text-lg font-bold leading-snug text-slate-900 sm:text-xl">{q?.question_text}</h1>
          {(() => {
            const qType = String((q as { question_type?: string } | null)?.question_type || "").toLowerCase();
            const isEssay =
              qType === "essay" ||
              qType === "short_answer" ||
              qType === "short-answer" ||
              qType === "numerical" ||
              qType === "theory" ||
              qType === "descriptive";
            const locked = q ? lockedAnswerIds.has(q.id) : false;
            if (isEssay && q) {
              const textVal = typeof answers[q.id] === "string" ? String(answers[q.id]) : "";
              return (
                <div className="mt-6">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {qType === "numerical" ? "Enter your numerical answer" : "Write your answer"}
                  </p>
                  <textarea
                    value={textVal}
                    disabled={locked}
                    rows={qType === "numerical" ? 3 : 10}
                    inputMode={qType === "numerical" ? "decimal" : "text"}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-gramm="false"
                    data-gramm_editor="false"
                    data-enable-grammarly="false"
                    enterKeyHint="done"
                    placeholder={
                      qType === "numerical"
                        ? "Type numbers only…"
                        : "Type your answer here…"
                    }
                    onPaste={(e) => {
                      e.preventDefault();
                    }}
                    onCopy={(e) => e.preventDefault()}
                    onCut={(e) => e.preventDefault()}
                    onDrop={(e) => e.preventDefault()}
                    onChange={(e) => {
                      if (locked) return;
                      const raw = e.target.value;
                      const next = qType === "numerical" ? raw.replace(/[^0-9.\-]/g, "") : raw;
                      setAnswers((a) => ({ ...a, [q.id]: next }));
                    }}
                    className={cn(
                      "w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed text-slate-900 shadow-sm outline-none ring-primary focus:ring-2",
                      locked && "cursor-not-allowed bg-slate-50 opacity-60",
                    )}
                  />
                  <p className="mt-1.5 text-[11px] text-slate-400">
                    {textVal.trim().length} characters
                  </p>
                </div>
              );
            }
            return (
              <ul className="mt-6 space-y-3">
                {(q?.options ?? []).map((opt, oi) => {
                  const selected = q ? answers[q.id] === oi : false;
                  return (
                    <li key={oi}>
                      <button type="button" disabled={locked}
                        onClick={() => {
                          if (!q || lockedAnswerIds.has(q.id)) return;
                          setAnswers((a) => ({ ...a, [q.id]: oi }));
                        }}
                        className={cn("flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm transition",
                          locked ? "border-slate-200 bg-slate-50 opacity-50 cursor-not-allowed line-through" : selected ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "border-slate-200 hover:border-primary/40")}>
                        <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-bold",
                          selected ? "border-primary bg-primary text-white" : "border-slate-300 text-slate-500")}>{String.fromCharCode(65 + oi)}</span>
                        <span>{opt}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            );
          })()}
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
            <Button variant="outline" className="rounded-lg font-semibold" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
            {index >= TOTAL - 1 ? (
              <Button className="rounded-lg font-semibold" onClick={() => requestSubmit()}>
                Submit exam
              </Button>
            ) : (
              <Button className="rounded-lg font-semibold" onClick={() => setIndex((i) => Math.min(TOTAL - 1, i + 1))}>
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </div>
          {index >= TOTAL - 1 && !done ? (
            <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-center sm:px-4">
              <p className="text-sm font-bold text-sky-900">You are on the last question</p>
              <p className="mt-0.5 text-xs leading-relaxed text-sky-800/90">
                Review your answers using the question numbers on the left, then submit when you are ready.
              </p>
            </div>
          ) : null}
        </section>
      </div>
      </main>
      {started && !done && security.tabMonitoring && (
        <div className="pointer-events-none fixed bottom-3 right-3 z-[120] sm:bottom-4 sm:right-4">
          <div className="rounded-full border border-slate-200 bg-white/95 px-3 py-1 text-[11px] font-semibold text-slate-700 shadow-sm">
            Tab violations: {tabSwitchCount}/{Math.max(1, Number(security.maxTabSwitches) || 5)}
          </div>
        </div>
      )}
      {started && !done && security.requireCamera && (
        <ExamCameraPip
          enabled={started && !done}
          faceDetection={Boolean(security.faceDetection || security.requireCamera)}
          maxFaceWarnings={security.maxFaceWarnings ?? 3}
          stream={liveStream}
          onSecurityEvent={onFaceSecurityEvent}
          onNeedReconnect={() => { void reconnectCamera(); }}
        />
      )}
      {warnBanner && started && !done && (
        <div className="fixed inset-x-0 top-16 z-[150] flex justify-center px-3 pointer-events-none">
          <div className="max-w-md rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm font-semibold text-amber-900 shadow-lg">
            Exam Integrity Warning — {warnBanner}
          </div>
        </div>
      )}
      {paused && started && !done && (
        <div className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-white p-6 text-center shadow-2xl">
            {isOfficerPause ? (
              <>
                <h2 className="text-lg font-extrabold text-slate-900">EXAM PAUSED</h2>
                <p className="mt-2 text-sm text-slate-600">
                  This examination has been paused by the examination officer.
                </p>
                {pauseReason ? (
                  <p className="mt-3 text-xs font-semibold text-slate-800">Reason: {pauseReason}</p>
                ) : null}
                <p className="mt-4 text-sm font-medium text-slate-700">
                  Waiting for the examination officer to resume your examination.
                </p>
                <p className="mt-2 text-[11px] text-slate-500">
                  You cannot answer questions while paused. The exam clock continues.
                </p>
              </>
            ) : pauseRemainingSec != null && pauseRemainingSec > 0 ? (
              <>
                <h2 className="text-lg font-extrabold text-slate-900">EXAM PAUSED</h2>
                <p className="mt-2 text-sm text-slate-600">
                  Your examination has been paused because the allowed tab-switch limit was reached.
                </p>
                {pauseReason ? (
                  <p className="mt-3 text-xs font-semibold text-slate-800">Reason: {pauseReason}</p>
                ) : null}
                <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Pause time remaining
                </p>
                <p className="mt-1 font-mono text-3xl font-extrabold tabular-nums text-primary">
                  {String(Math.floor(pauseRemainingSec / 60)).padStart(2, "0")}:
                  {String(pauseRemainingSec % 60).padStart(2, "0")}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Please wait until the pause period is completed. The exam clock continues.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-lg font-extrabold text-slate-900">PAUSE PERIOD COMPLETED</h2>
                <p className="mt-2 text-sm text-slate-600">You may now resume your examination.</p>
                {pauseReason ? (
                  <p className="mt-3 text-xs font-semibold text-slate-800">Reason: {pauseReason}</p>
                ) : null}
                <Button className="mt-5 w-full font-semibold" onClick={() => void clearTimedPause()}>
                  Resume Exam
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {started && !done && !previewMode && calculatorEnabled && (
        <>
          <ExamCalculatorFab onClick={() => setCalcOpen(true)} />
          <ExamCalculator
            open={calcOpen}
            mode={calculatorMode}
            onClose={() => setCalcOpen(false)}
          />
        </>
      )}
      {showSubmitConfirm && started && !done && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-6">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
              <Flag className="h-5 w-5" aria-hidden />
            </div>
            <h2 className="text-center text-lg font-extrabold text-slate-900">Submit examination?</h2>
            <p className="mt-2 text-center text-sm text-slate-600">
              {Math.max(0, TOTAL - answeredCount) > 0 ? (
                <>
                  You have answered <span className="font-bold text-slate-900">{answeredCount}</span> of{" "}
                  <span className="font-bold text-slate-900">{TOTAL}</span> questions.
                  <span className="mt-1 block font-semibold text-amber-700">
                    {Math.max(0, TOTAL - answeredCount)} unanswered — you can still submit.
                  </span>
                </>
              ) : (
                <>
                  You have answered all <span className="font-bold text-slate-900">{TOTAL}</span> questions.
                </>
              )}
            </p>
            <p className="mt-2 text-center text-xs text-slate-500">
              Once submitted, you cannot change your answers.
            </p>
            <div className="mt-5 flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1 font-semibold"
                onClick={() => setShowSubmitConfirm(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="flex-1 font-semibold"
                onClick={() => void confirmSubmit()}
              >
                Submit
              </Button>
            </div>
          </div>
        </div>
      )}
      {fsGate && security.fullscreen && started && !done && !paused && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm"
          style={{ pointerEvents: "auto" }}
        >
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-white p-6 text-center shadow-2xl pointer-events-auto">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary"><Maximize className="h-6 w-6" /></div>
            <h2 className="text-lg font-extrabold text-slate-900">Fullscreen required</h2>
            <p className="mt-2 text-sm text-slate-600">Tap below to continue. Your exam timer is still running.</p>
            <Button className="mt-5 w-full font-semibold" type="button" onClick={() => void restoreFullscreenFromUser()}>
              <Maximize className="mr-2 h-4 w-4" /> Return to fullscreen
            </Button>
            <Button
              className="mt-2 w-full font-semibold"
              type="button"
              variant="outline"
              onClick={() => {
                setFsGate(false);
              }}
            >
              Continue exam
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export { CbtExamPage as CbtExamSession };
