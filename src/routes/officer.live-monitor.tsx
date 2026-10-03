import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CameraOff,
  CheckCircle2,
  LayoutGrid,
  List,
  Radio,
  Search,
  ShieldAlert,
  UserRound,
  X,
  Wifi,
  WifiOff,
  MessageSquareWarning,
  Loader2,
  ChevronLeft,
  Monitor,
  Mic,
  MicOff,
} from "lucide-react";
import { PageHeader, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { logSecurityEvent } from "@/lib/cbt-security";
import { notifyStudentOfficerWarning } from "@/lib/notify";
import { toast } from "sonner";
import { isNativeShell } from "@/native/platform";
import {
  faceLabel,
  formatDuration,
  humanEventLabel,
  isOnline,
  parsePresence,
  relativeTime,
  severityBadgeClass,
  severityBorderClass,
  severityFromPresence,
  type MonitorSeverity,
} from "@/lib/live-monitor";
import {
  isLiveCamFrameFresh,
  isLiveCamFrameUsable,
  startLiveCamSubscriber,
  LIVE_CAM_STALE_MS,
  type LiveCamFramePayload,
  startLiveScreenSubscriber,
  isLiveScreenFrameFresh,
  isLiveScreenFrameUsable,
  type LiveScreenFramePayload,
} from "@/lib/live-video";
import {
  startLiveMicSubscriber,
  playMicChunk,
  type LiveMicChunkPayload,
} from "@/lib/live-audio";

export const Route = createFileRoute("/officer/live-monitor")({
  head: () => ({ meta: [{ title: "Live Monitoring — D4EXAM" }] }),
  component: OfficerLiveMonitorRoute,
});

function OfficerLiveMonitorRoute() {
  return <LiveMonitorPage />;
}

export type LiveMonitorPageProps = {
  /** When set, only exams on these courses (teacher scope). */
  courseIds?: string[] | null;
  /** Page title override */
  pageTitle?: string;
};

const OFFLINE_HIDE_MS = 3 * 60 * 1000;
const RECENT_SUBMIT_MS = 10 * 60 * 1000;

type AttemptRow = {
  id: string;
  exam_id: string;
  student_id: string;
  status: string;
  started_at: string | null;
  updated_at?: string | null;
  tab_switch_count: number | null;
  metadata: Record<string, unknown> | null;
  examinations: { title: string; status: string; courses: { code: string; name?: string } | null } | null;
  students: {
    full_name?: string | null;
    matric_number: string | null;
    student_id: string | null;
    profiles?: { full_name: string | null } | null;
  } | null;
};

type IntegrityEvent = {
  id: string;
  event_type: string;
  severity: string | null;
  description: string | null;
  created_at: string;
  student_id: string | null;
  exam_id: string | null;
  attempt_id: string | null;
};

type FilterKey = "all" | "normal" | "warning" | "violation" | "offline";
type FrameEntry = { src: string; ts: number; faceStatus?: string; cameraActive?: boolean; answeredCount?: number; totalQuestions?: number; timeRemainingSec?: number | null; tabSwitchCount?: number; studentName?: string; matricNumber?: string; courseCode?: string; examTitle?: string; studentId?: string; examId?: string };

function isFaceOrCameraLogOnly(eventType: string): boolean {
  const t = String(eventType || "").toUpperCase();
  return (
    t.includes("FACE") ||
    t.includes("CAMERA") ||
    t.includes("NO_FACE") ||
    t.includes("ONE_FACE") ||
    t.includes("MULTIPLE_FACE") ||
    t.includes("UNCLEAR")
  );
}

function doneStatusLabel(status: string): string {
  const st = String(status || "").toLowerCase();
  if (st === "submitted") return "Submitted";
  if (st === "terminated") return "Terminated";
  if (st === "flagged") return "Flagged";
  return "Ended";
}

function humanLiveStatus(sev: MonitorSeverity): string {
  if (sev === "normal") return "Online";
  if (sev === "warning") return "Warning";
  if (sev === "violation") return "Violation";
  if (sev === "offline") return "Offline";
  if (sev === "completed") return "Completed";
  return String(sev);
}

function nameFromMetadata(meta: unknown): string {
  if (!meta || typeof meta !== "object") return "";
  const m = meta as Record<string, unknown>;
  return String(m.studentName || m.full_name || m.student_name || "").trim();
}

function pickFeedFrame(
  feedMode: "camera" | "screen" | "both",
  cam?: { src: string; ts: number } | null,
  screen?: { src: string; ts: number } | null,
): { src: string; ts: number } | undefined {
  if (feedMode === "screen") return screen || undefined;
  if (feedMode === "camera") return cam || undefined;
  return cam || screen || undefined;
}

function studentDisplayName(a: AttemptRow): string {
  const matric = String(a.students?.matric_number || a.students?.student_id || "").trim();
  const fromMeta = nameFromMetadata(a.metadata);
  if (fromMeta && fromMeta.toLowerCase() !== matric.toLowerCase()) return fromMeta;
  const fromStudent = String(a.students?.full_name || "").trim();
  if (fromStudent && fromStudent.toLowerCase() !== matric.toLowerCase()) return fromStudent;
  const _prof = a.students?.profiles as unknown;
  const fromProfile = String(
    Array.isArray(_prof)
      ? (_prof[0] as { full_name?: string | null } | undefined)?.full_name || ""
      : (_prof as { full_name?: string | null } | null | undefined)?.full_name || "",
  ).trim();
  if (fromProfile && fromProfile.toLowerCase() !== matric.toLowerCase()) return fromProfile;
  return fromStudent || fromProfile || fromMeta || "Student";
}

function signalBars(
  frameTs: number | null | undefined,
  lastSeenAt: string | null | undefined,
  now = Date.now(),
): 0 | 1 | 2 | 3 | 4 {
  const frameAge = frameTs != null ? now - frameTs : Infinity;
  const seenAge = lastSeenAt ? now - new Date(lastSeenAt).getTime() : Infinity;
  if (Number.isNaN(seenAge)) return 0;
  if (frameAge <= 1_200) return 4;
  if (frameAge <= 2_500) return 3;
  if (frameAge <= LIVE_CAM_STALE_MS || seenAge <= 8_000) return 2;
  if (seenAge <= 25_000) return 1;
  return 0;
}

function SignalBars({ bars, className }: { bars: number; className?: string }) {
  const color =
    bars >= 3 ? "bg-emerald-400" : bars === 2 ? "bg-amber-400" : bars === 1 ? "bg-orange-500" : "bg-red-500";
  return (
    <div className={cn("flex items-end gap-0.5", className)} title={`Signal: ${bars}/4`} aria-label={`Signal ${bars} of 4`}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn(
            "w-[2.5px] rounded-sm transition-colors sm:w-[3px]",
            i <= bars ? color : "bg-white/25",
            i === 1 && "h-1",
            i === 2 && "h-1.5",
            i === 3 && "h-2.5",
            i === 4 && "h-3",
            "sm:h-auto",
            i === 1 && "sm:h-1.5",
            i === 2 && "sm:h-2.5",
            i === 3 && "sm:h-3.5",
            i === 4 && "sm:h-4",
          )}
        />
      ))}
    </div>
  );
}

function lastActivityMs(presenceLastSeen: string | null | undefined, row: AttemptRow): number | null {
  const candidates: number[] = [];
  if (presenceLastSeen) {
    const t = new Date(presenceLastSeen).getTime();
    if (!Number.isNaN(t)) candidates.push(t);
  }
  if (row.updated_at) {
    const t = new Date(row.updated_at).getTime();
    if (!Number.isNaN(t)) candidates.push(t);
  }
  if (row.started_at) {
    const t = new Date(row.started_at).getTime();
    if (!Number.isNaN(t)) candidates.push(t);
  }
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

export function LiveMonitorPage({ courseIds = null, pageTitle }: LiveMonitorPageProps = {} as LiveMonitorPageProps) {
  const { data: user } = useSessionUser();
  const qc = useQueryClient();
  const schoolId = user?.schoolId ?? null;
  const courseIdSet = useMemo(() => {
    if (!courseIds || !courseIds.length) return null;
    return new Set(courseIds.map(String));
  }, [courseIds]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [examFilter, setExamFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [desktopView, setDesktopView] = useState(false);
  const [feedMode, setFeedMode] = useState<"camera" | "screen" | "both">("both");

  // Desktop mode on phone: sidebar + multi-column layout, fit width (no sideways scroll)
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!isNativeShell()) {
      if (desktopView) setDesktopView(false);
      return;
    }
    if (desktopView) {
      document.documentElement.classList.add("d4-monitor-desktop-site");
      try {
        document.body.style.overflowX = "hidden";
        document.documentElement.style.overflowX = "hidden";
      } catch { /* ignore */ }
    } else {
      document.documentElement.classList.remove("d4-monitor-desktop-site");
      try {
        document.body.style.overflowX = "";
        document.documentElement.style.overflowX = "";
      } catch { /* ignore */ }
    }
    return () => {
      document.documentElement.classList.remove("d4-monitor-desktop-site");
      try {
        document.body.style.overflowX = "";
        document.documentElement.style.overflowX = "";
      } catch { /* ignore */ }
    };
  }, [desktopView]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Manual drag order of attempt ids (officer/teacher can rearrange cards). */
  const [cardOrderIds, setCardOrderIds] = useState<string[]>([]);
  const dragIdRef = useRef<string | null>(null);
  const [audioMuted, setAudioMuted] = useState(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioMutedRef = useRef(true);
  const selectedIdRef = useRef<string | null>(null);
  audioMutedRef.current = audioMuted;
  selectedIdRef.current = selectedId;
  const [readAlertIds, setReadAlertIds] = useState<Set<string>>(new Set());
  const [frames, setFrames] = useState<Record<string, FrameEntry>>({});
  const [screenFrames, setScreenFrames] = useState<Record<string, { src: string; ts: number; examId?: string; studentId?: string }>>({});
  const [warningBusy, setWarningBusy] = useState(false);
  const [forcePausedIds, setForcePausedIds] = useState<Record<string, boolean>>({});
  const [actionBusy, setActionBusy] = useState(false);
  const [, setTick] = useState(0);
  const seenAlertIdsRef = useRef<Set<string>>(new Set());
  const alertsBootstrappedRef = useRef(false);

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 3000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!schoolId) return;
    const sub = startLiveCamSubscriber({
      schoolId,
      onFrame: (p: LiveCamFramePayload) => {
        const attemptId = p.attemptId || (p as { attempt_id?: string }).attempt_id;
        if (!attemptId || !p.frame) return;
        const entry = {
          src: p.frame,
          ts: p.ts || Date.now(),
          faceStatus: p.faceStatus,
          cameraActive: p.cameraActive !== false,
          answeredCount: p.answeredCount,
          totalQuestions: p.totalQuestions,
          timeRemainingSec: p.timeRemainingSec,
          tabSwitchCount: typeof (p as { tabSwitchCount?: number }).tabSwitchCount === "number" ? (p as { tabSwitchCount?: number }).tabSwitchCount : undefined,
          studentName: p.studentName ? String(p.studentName).trim() : undefined,
          matricNumber: p.matricNumber ? String(p.matricNumber).trim() : undefined,
          courseCode: p.courseCode ? String(p.courseCode).trim() : undefined,
          examTitle: p.examTitle ? String(p.examTitle).trim() : undefined,
          studentId: String(p.studentId || (p as { student_id?: string }).student_id || "").trim() || undefined,
          examId: String(p.examId || "").trim() || undefined,
        };
        const sid = String(p.studentId || (p as { student_id?: string }).student_id || "");
        setFrames((prev) => {
          const next = { ...prev, [attemptId]: entry };
          if (sid) next[`student:${sid}`] = entry;
          return next;
        });
      },
    });
    return () => sub.stop();
  }, [schoolId]);

  useEffect(() => {
    if (!schoolId) return;
    const sub = startLiveScreenSubscriber({
      schoolId,
      onFrame: (p: LiveScreenFramePayload) => {
        const attemptId = p.attemptId || (p as { attempt_id?: string }).attempt_id;
        if (!attemptId || !p.frame) return;
        const entry = {
          src: p.frame,
          ts: p.ts || Date.now(),
          examId: String(p.examId || (p as { exam_id?: string }).exam_id || "").trim() || undefined,
          studentId: String(p.studentId || (p as { student_id?: string }).student_id || "").trim() || undefined,
        };
        const sid = String(p.studentId || (p as { student_id?: string }).student_id || "");
        setScreenFrames((prev) => {
          const next = { ...prev, [attemptId]: entry };
          if (sid) next[`student:${sid}`] = entry;
          return next;
        });
      },
    });
    return () => sub.stop();
  }, [schoolId]);
  useEffect(() => {
    if (!schoolId) return;
    const sub = startLiveMicSubscriber({
      schoolId,
      onChunk: (payload: LiveMicChunkPayload) => {
        const focused = selectedIdRef.current;
        const muted = audioMutedRef.current;
        let play = false;
        if (focused) play = payload.attemptId === focused;
        else play = !muted;
        if (!play) return;
        try {
          if (!audioCtxRef.current) {
            const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            audioCtxRef.current = new AC();
          }
          const ctx = audioCtxRef.current;
          if (ctx.state === "suspended") void ctx.resume();
          playMicChunk(ctx, payload, focused ? 1.15 : 0.55);
        } catch { /* ignore */ }
      },
    });
    return () => sub.stop();
  }, [schoolId]);


  useRealtimeInvalidate(
    `officer-live-${schoolId ?? "x"}`,
    schoolId
      ? [
          { table: "exam_attempts", filter: `school_id=eq.${schoolId}` },
          { table: "examinations", filter: `school_id=eq.${schoolId}` },
          { table: "integrity_events", filter: `school_id=eq.${schoolId}` },
        ]
      : [],
    [
      ["officer-live", schoolId],
      ["officer-live-attempts", schoolId],
      ["officer-live-events", schoolId],
      ["officer-live-completed", schoolId],
      ["officer-live-recent-done", schoolId],
    ],
    Boolean(schoolId),
    1500,
  );

  const examsQ = useQuery({
    queryKey: ["officer-live", schoolId, courseIds?.slice().sort().join(",") ?? "all"],
    enabled: Boolean(schoolId),
    refetchInterval: 12_000,
    queryFn: async () => {
      if (!schoolId) return [];
      let q = supabase
        .from("examinations")
        .select("id, title, status, scheduled_start, scheduled_end, course_id, courses(code, name)")
        .eq("school_id", schoolId)
        .in("status", ["ongoing", "scheduled", "published", "approved"])
        .order("scheduled_start", { ascending: true })
        .limit(50);
      if (courseIds && courseIds.length) {
        q = q.in("course_id", courseIds);
      }
      const { data, error } = await q;
      if (error) {
        console.warn("[live-monitor] exams query", error);
        return [];
      }
      return data ?? [];
    },
  });

  const attemptsQ = useQuery({
    queryKey: ["officer-live-attempts", schoolId, courseIds?.slice().sort().join(",") ?? "all"],
    enabled: Boolean(schoolId),
    refetchInterval: 3_000,
    queryFn: async () => {
      if (!schoolId) return [] as AttemptRow[];
      const selects = [
        `id, exam_id, student_id, status, started_at, updated_at, ends_at, tab_switch_count, metadata,
           examinations(title, status, courses(code, name)),
           students(matric_number, student_id, profiles(full_name))`,
        `id, exam_id, student_id, status, started_at, updated_at, ends_at, tab_switch_count, metadata,
           examinations(title, status, courses(code, name)),
           students(matric_number, student_id, profiles(full_name))`,
        `id, exam_id, student_id, status, started_at, updated_at, tab_switch_count, metadata,
           examinations(title, status, courses(code, name)),
           students(matric_number, student_id, profiles(full_name))`,
        `id, exam_id, student_id, status, started_at, updated_at, tab_switch_count, metadata,
           examinations(title, status, courses(code, name)),
           students(matric_number, student_id, profiles(full_name))`,
        `id, exam_id, student_id, status, started_at, updated_at, tab_switch_count, metadata,
           examinations(title, status),
           students(matric_number, student_id)`,
      ];
      let lastError: { message?: string } | null = null;
      for (const sel of selects) {
        const { data, error } = await supabase
          .from("exam_attempts")
          .select(sel)
          .eq("school_id", schoolId)
          .in("status", ["in_progress", "paused", "held"])
          .order("started_at", { ascending: false })
          .limit(120);
        if (!error) return (data ?? []) as unknown as AttemptRow[];
        lastError = error;
      }
      if (lastError) console.warn("[live-monitor] attempts query", lastError);
      return [];
    },
  });

  const recentDoneQ = useQuery({
    queryKey: ["officer-live-recent-done", schoolId],
    enabled: Boolean(schoolId),
    refetchInterval: 5_000,
    queryFn: async () => {
      if (!schoolId) return [] as AttemptRow[];
      const since = new Date(Date.now() - RECENT_SUBMIT_MS).toISOString();
      const selects = [
        `id, exam_id, student_id, status, started_at, updated_at, ends_at, tab_switch_count, metadata,
             examinations(title, status, courses(code, name)),
             students(matric_number, student_id, profiles(full_name))`,
        `id, exam_id, student_id, status, started_at, updated_at, ends_at, tab_switch_count, metadata,
             examinations(title, status, courses(code, name)),
             students(matric_number, student_id, profiles(full_name))`,
        `id, exam_id, student_id, status, started_at, updated_at, ends_at, tab_switch_count, metadata,
             examinations(title, status),
             students(matric_number, student_id)`,
      ];
      let useSel = selects[0];
      for (const sel of selects) {
        const probe = await supabase.from("exam_attempts").select(sel).eq("school_id", schoolId).limit(1);
        if (!probe.error) {
          useSel = sel;
          break;
        }
      }
      const base = () =>
        supabase
          .from("exam_attempts")
          .select(useSel)
          .eq("school_id", schoolId)
          .in("status", ["submitted", "terminated", "flagged"])
          .limit(50);
      const bySubmitted = await base().gte("submitted_at", since).order("submitted_at", { ascending: false });
      if (!bySubmitted.error && (bySubmitted.data?.length ?? 0) > 0) {
        return (bySubmitted.data ?? []) as unknown as AttemptRow[];
      }
      const byUpdated = await base().gte("updated_at", since).order("updated_at", { ascending: false });
      if (byUpdated.error) return [];
      return (byUpdated.data ?? []) as unknown as AttemptRow[];
    },
  });

  useEffect(() => {
    // Soft prune only — keep last valid frames through transient query gaps / Realtime hiccups.
    const liveIds = new Set([
      ...(attemptsQ.data ?? []).map((a) => a.id),
      ...(recentDoneQ.data ?? []).map((a) => a.id),
    ]);
    const GRACE_MS = 3 * 60 * 1000;
    const nowMs = Date.now();
    setFrames((prev) => {
      const next: Record<string, FrameEntry> = {};
      let changed = false;
      for (const [id, entry] of Object.entries(prev)) {
        const ageOk = entry.ts != null && nowMs - entry.ts < GRACE_MS;
        const idOk = liveIds.has(id) || id.startsWith("student:");
        if (idOk || ageOk) next[id] = entry;
        else changed = true;
      }
      return changed ? next : prev;
    });
    setScreenFrames((prev) => {
      const next: Record<string, { src: string; ts: number }> = {};
      let changed = false;
      for (const [id, entry] of Object.entries(prev)) {
        const ageOk = entry.ts != null && nowMs - entry.ts < GRACE_MS;
        const idOk = liveIds.has(id) || id.startsWith("student:");
        if (idOk || ageOk) next[id] = entry;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [attemptsQ.data, recentDoneQ.data]);

  const completedQ = useQuery({
    queryKey: ["officer-live-completed", schoolId],
    enabled: Boolean(schoolId),
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!schoolId) return 0;
      const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from("exam_attempts")
        .select("id", { count: "exact", head: true })
        .eq("school_id", schoolId)
        .in("status", ["submitted", "terminated", "flagged"])
        .gte("updated_at", since);
      return count ?? 0;
    },
  });

  const eventsQ = useQuery({
    queryKey: ["officer-live-events", schoolId],
    enabled: Boolean(schoolId),
    staleTime: 1_000,
    refetchInterval: 4_000,
    queryFn: async () => {
      if (!schoolId) return [] as IntegrityEvent[];
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("integrity_events")
        .select("id, event_type, severity, description, created_at, student_id, exam_id, attempt_id")
        .eq("school_id", schoolId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(120);
      if (error) return [];
      return (data ?? []) as IntegrityEvent[];
    },
  });

  const liveExams = (examsQ.data ?? []).filter((e) => e.status === "ongoing");
  const events = Array.isArray(eventsQ.data) ? eventsQ.data : [];
  const now = Date.now();


  const studentIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const a of attemptsQ.data ?? []) ids.add(String(a.student_id));
    for (const a of recentDoneQ.data ?? []) ids.add(String(a.student_id));
    return Array.from(ids).sort().join(",");
  }, [attemptsQ.data, recentDoneQ.data]);

  const studentNamesQ = useQuery({
    queryKey: ["officer-live-student-names", schoolId, studentIdsKey],
    enabled: Boolean(schoolId && studentIdsKey),
    staleTime: 8_000,
    refetchInterval: 12_000,
    queryFn: async () => {
      const ids = studentIdsKey.split(",").filter(Boolean);
      if (!ids.length) return {} as Record<string, { name: string; matric: string }>;
      const map: Record<string, { name: string; matric: string }> = {};
      const nameSelects = [
        "id, full_name, matric_number, student_id, profile_id, profiles(full_name, first_name, last_name)",
        "id, full_name, matric_number, student_id, profile_id, profiles(full_name)",
        "id, full_name, matric_number, student_id, profile_id",
        "id, matric_number, student_id, profile_id, profiles(full_name)",
        "id, matric_number, student_id, profile_id",
      ];
      let studs: unknown[] = [];
      for (const sel of nameSelects) {
        const { data, error } = await supabase.from("students").select(sel).eq("school_id", schoolId!).in("id", ids);
        if (!error) { studs = data ?? []; break; }
      }
      const profileIds: string[] = [];
      for (const s of studs) {
        const row = s as { id: string; full_name?: string | null; matric_number?: string | null; student_id?: string | null; profile_id?: string | null; profiles?: unknown };
        const matric = String(row.matric_number || row.student_id || "").trim();
        let name = String(row.full_name || "").trim();
        const prof = row.profiles as { full_name?: string | null; first_name?: string | null; last_name?: string | null } | { full_name?: string | null }[] | null;
        let pName = "";
        if (Array.isArray(prof)) {
          const pr = prof[0] as { full_name?: string | null; first_name?: string | null; last_name?: string | null } | undefined;
          pName = String(pr?.full_name || [pr?.first_name, pr?.last_name].filter(Boolean).join(" ") || "").trim();
        } else if (prof && typeof prof === "object") {
          const pr = prof as { full_name?: string | null; first_name?: string | null; last_name?: string | null };
          pName = String(pr.full_name || [pr.first_name, pr.last_name].filter(Boolean).join(" ") || "").trim();
        }
        if (!name || name.toLowerCase() === matric.toLowerCase()) name = pName || name;
        if (name || matric) map[row.id] = { name: name || "", matric };
        if (row.profile_id) profileIds.push(String(row.profile_id));
      }
      const missing = ids.filter((id) => !map[id]);
      if (missing.length && profileIds.length) {
        const { data: profs } = await supabase.from("profiles").select("id, full_name, first_name, last_name").in("id", profileIds);
        const byPid: Record<string, string> = {};
        for (const pr of profs ?? []) {
          const r = pr as { id: string; full_name?: string | null; first_name?: string | null; last_name?: string | null };
          const n = String(r.full_name || [r.first_name, r.last_name].filter(Boolean).join(" ") || "").trim();
          if (n) byPid[r.id] = n;
        }
        for (const s of studs) {
          const row = s as { id: string; profile_id?: string | null };
          if (row.profile_id && byPid[String(row.profile_id)]) {
            const existing = map[row.id];
            if (!existing || !existing.name) {
              map[row.id] = { name: byPid[String(row.profile_id)], matric: existing?.matric || "" };
            }
          }
        }
      }
      return map;
    },
  });


  const nameByMatricQ = useQuery({
    queryKey: ["officer-live-name-by-matric", schoolId, studentIdsKey],
    enabled: Boolean(schoolId && studentIdsKey),
    staleTime: 30_000,
    queryFn: async () => {
      const map: Record<string, string> = {};
      const { data } = await supabase
        .from("students")
        .select("id, matric_number, student_id, profiles(full_name, first_name, last_name)")
        .eq("school_id", schoolId!)
        .limit(500);
      for (const s of data ?? []) {
        const row = s as {
          id: string;
          full_name?: string | null;
          matric_number?: string | null;
          student_id?: string | null;
          profiles?: { full_name?: string | null; first_name?: string | null; last_name?: string | null } | { full_name?: string | null }[] | null;
        };
        const matric = String(row.matric_number || row.student_id || "").trim().toLowerCase();
        let name = String(row.full_name || "").trim();
        const prof = row.profiles;
        let pName = "";
        if (Array.isArray(prof)) {
          const pr = prof[0] as { full_name?: string | null; first_name?: string | null; last_name?: string | null } | undefined;
          pName = String(pr?.full_name || [pr?.first_name, pr?.last_name].filter(Boolean).join(" ") || "").trim();
        } else if (prof && typeof prof === "object") {
          const pr = prof as { full_name?: string | null; first_name?: string | null; last_name?: string | null };
          pName = String(pr.full_name || [pr.first_name, pr.last_name].filter(Boolean).join(" ") || "").trim();
        }
        if (!name || name.toLowerCase() === matric) name = pName || name;
        if (name) {
          map[row.id] = name;
          if (matric) map[`matric:${matric}`] = name;
        }
      }
      return map;
    },
  });

    const examIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const a of attemptsQ.data ?? []) { if (a.exam_id) ids.add(String(a.exam_id)); }
    for (const a of recentDoneQ.data ?? []) { if (a.exam_id) ids.add(String(a.exam_id)); }
    return Array.from(ids).sort().join(",");
  }, [attemptsQ.data, recentDoneQ.data]);

  const examEnrichQ = useQuery({
    queryKey: ["officer-live-exam-enrich", schoolId, examIdsKey],
    enabled: Boolean(schoolId && examIdsKey),
    staleTime: 30_000,
    queryFn: async () => {
      const ids = examIdsKey.split(",").filter(Boolean);
      const map: Record<string, { title: string; courseCode: string; courseName: string }> = {};
      if (!ids.length) return map;
      for (const sel of ["id, title, courses(code, name)", "id, title"]) {
        const { data, error } = await supabase.from("examinations").select(sel).eq("school_id", schoolId!).in("id", ids);
        if (!error) {
          for (const r of data ?? []) {
            const row = r as { id: string; title?: string | null; courses?: { code?: string; name?: string } | { code?: string; name?: string }[] | null };
            const c = Array.isArray(row.courses) ? row.courses[0] : row.courses;
            map[row.id] = { title: String(row.title || "").trim(), courseCode: String(c?.code || "").trim(), courseName: String(c?.name || "").trim() };
          }
          break;
        }
      }
      return map;
    },
  });

  const cards = useMemo(() => {
    const inProgress = attemptsQ.data ?? [];
    const recentDone = recentDoneQ.data ?? [];
    const knownIds = new Set([...inProgress, ...recentDone].map((a) => a.id));
    const frameOnly: AttemptRow[] = [];
    for (const [key, entry] of Object.entries(frames)) {
      if (key.startsWith("student:")) continue;
      if (knownIds.has(key)) continue;
      if (!entry?.src || !entry.ts) continue;
      if (now - entry.ts > 60_000) continue;
      frameOnly.push({
        id: key,
        exam_id: String(entry.examId || ""),
        student_id: String(entry.studentId || key),
        status: "in_progress",
        started_at: new Date(entry.ts).toISOString(),
        updated_at: new Date(entry.ts).toISOString(),
        tab_switch_count: 0,
        metadata: {
          lastSeenAt: new Date(entry.ts).toISOString(),
          studentName: entry.studentName || undefined,
          matricNumber: entry.matricNumber || undefined,
          courseCode: entry.courseCode || undefined,
          examTitle: entry.examTitle || undefined,
        },
        examinations: entry.examTitle
          ? { title: entry.examTitle, status: "ongoing", courses: entry.courseCode ? { code: entry.courseCode } : null }
          : null,
        students: (entry.studentName || entry.matricNumber)
          ? {
              full_name: entry.studentName || null,
              matric_number: entry.matricNumber || null,
              student_id: entry.matricNumber || null,
            }
          : null,
      })
    }
    const merged = [...inProgress, ...recentDone, ...frameOnly];
    // Resolve live frames only for the matching attempt/exam (never bleed onto an older paper)
    const resolveCamFrame = (a: AttemptRow) => {
      // 1) Exact attempt id (including pending: keys once upgraded)
      const byAttempt = frames[a.id];
      if (byAttempt) return byAttempt;
      // 2) pending key for this student+exam (frames may start before attempt UUID exists)
      const pendingKey = `pending:${a.student_id}:${a.exam_id}`;
      if (frames[pendingKey]) return frames[pendingKey]!;
      const sid = String(a.student_id || "");
      if (!sid) return null;
      const byStudent = frames[`student:${sid}`];
      if (!byStudent) return null;
      const feid = String(byStudent.examId || "").trim();
      const aeid = String(a.exam_id || "").trim();
      if (feid && aeid && feid !== aeid) return null;
      const st = String(a.status || "").toLowerCase();
      if (["submitted", "terminated", "flagged", "completed"].includes(st)) return null;
      return byStudent;
    };
    const resolveScrFrame = (a: AttemptRow) => {
      const byAttempt = screenFrames[a.id];
      if (byAttempt) return byAttempt;
      const pendingKey = `pending:${a.student_id}:${a.exam_id}`;
      if (screenFrames[pendingKey]) return screenFrames[pendingKey]!;
      const sid = String(a.student_id || "");
      if (!sid) return null;
      const byStudent = screenFrames[`student:${sid}`];
      if (!byStudent) return null;
      const feid = String((byStudent as { examId?: string }).examId || "").trim();
      const aeid = String(a.exam_id || "").trim();
      if (feid && aeid && feid !== aeid) return null;
      const st = String(a.status || "").toLowerCase();
      if (["submitted", "terminated", "flagged", "completed"].includes(st)) return null;
      return byStudent;
    };
    const isFinishedStatus = (a: AttemptRow) => {
      const st = String(a.status || "").toLowerCase();
      if (["submitted", "terminated", "flagged", "completed"].includes(st)) return true;
      // Time-up / expired ends_at still left as in_progress in DB — treat as finished for ranking
      const ends =
        (a as { ends_at?: string | null }).ends_at ||
        (a.metadata && typeof a.metadata === "object"
          ? String((a.metadata as Record<string, unknown>).endsAt || (a.metadata as Record<string, unknown>).ends_at || "")
          : "");
      if (ends) {
        const t = new Date(ends).getTime();
        if (!Number.isNaN(t) && Date.now() > t + 15_000) return true;
      }
      return false;
    };
    // One card per student: ALWAYS prefer the newest active (in-progress) attempt
    const byStudent = new Map<string, AttemptRow>();
    const attemptRank = (a: AttemptRow) => {
      const finished = isFinishedStatus(a);
      const started = a.started_at ? new Date(a.started_at).getTime() : 0;
      const updated = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const frame = resolveCamFrame(a);
      const liveBoost =
        !finished && frame && isLiveCamFrameFresh(frame.ts, Date.now()) ? 1e10 : 0;
      // Active attempts always outrank finished ones; among active, newest start wins
      if (finished) return started + updated * 0.001;
      return 2e15 + started + liveBoost + updated * 0.001;
    };
    for (const a of merged) {
      const key = String(a.student_id || a.id);
      const prev = byStudent.get(key);
      if (!prev || attemptRank(a) >= attemptRank(prev)) byStudent.set(key, a);
    }
    const unique = Array.from(byStudent.values());
    return unique
      .map((a) => {
        const basePresence = parsePresence(a.metadata);
        const camFrame = resolveCamFrame(a);
        const scrFrame = resolveScrFrame(a);
        const frame = pickFeedFrame(feedMode, camFrame, scrFrame);
        const st = String(a.status || "").toLowerCase();
        const isDone =
          ["submitted", "terminated", "flagged", "completed"].includes(st) || isFinishedStatus(a);
        const camLive = Boolean(camFrame && isLiveCamFrameFresh(camFrame.ts, now));
        const scrLive = Boolean(scrFrame && isLiveScreenFrameFresh(scrFrame.ts, now));
        const hasLiveVideo = !isDone && (
          feedMode === "screen" ? scrLive : feedMode === "camera" ? camLive : (camLive || scrLive)
        );
        // Prefer live Realtime frame — never show Offline while video frames are arriving
        const presence = { ...basePresence };
        const statsFrame = camFrame || frame;
        if ((hasLiveVideo || (camFrame && isLiveCamFrameUsable(camFrame.ts, now)) || (scrFrame && isLiveScreenFrameUsable(scrFrame.ts, now))) && (statsFrame || frame)) {
          const tsSrc = frame || statsFrame;
          if (tsSrc?.ts) presence.lastSeenAt = new Date(tsSrc.ts).toISOString();
          presence.cameraActive = true;
          if (statsFrame?.faceStatus) {
            const fs = String(statsFrame.faceStatus).toLowerCase();
            if (fs === "ok" || fs === "none" || fs === "multi" || fs === "unclear" || fs === "unavailable") {
              presence.faceStatus = fs as typeof presence.faceStatus;
            }
          } else if (!presence.faceStatus || presence.faceStatus === "unknown" || presence.faceStatus === "unavailable") {
            presence.faceStatus = "ok";
          }
          if (typeof statsFrame?.answeredCount === "number") presence.answeredCount = statsFrame.answeredCount;
          if (typeof statsFrame?.totalQuestions === "number") presence.totalQuestions = statsFrame.totalQuestions;
          if (typeof statsFrame?.timeRemainingSec === "number") presence.timeRemainingSec = statsFrame.timeRemainingSec;
          if (typeof statsFrame?.tabSwitchCount === "number") {
            (presence as { tabSwitchCount?: number }).tabSwitchCount = statsFrame.tabSwitchCount;
          }
          {
            const dbTab = Number(a.tab_switch_count ?? 0);
            const metaTab = (() => {
              const mm = a.metadata;
              if (!mm || typeof mm !== "object") return 0;
              return Number((mm as Record<string, unknown>).tabSwitchCount ?? 0);
            })();
            const liveTab = Number((presence as { tabSwitchCount?: number }).tabSwitchCount ?? 0);
            const bestTab = Math.max(dbTab, metaTab, liveTab);
            if (bestTab > 0) (presence as { tabSwitchCount?: number }).tabSwitchCount = bestTab;
          }
        } else if (frame?.ts && !presence.lastSeenAt) {
          presence.lastSeenAt = new Date(frame.ts).toISOString();
        }
        let sev: MonitorSeverity = isDone ? "completed" : severityFromPresence(a.status, presence, now);
        if (!isDone && (hasLiveVideo || (camFrame && isLiveCamFrameUsable(camFrame.ts, now))) && sev === "offline") {
          const fs = presence.faceStatus;
          if (fs === "multi") sev = "violation";
          else if (fs === "none" || fs === "unclear") sev = "warning";
          else sev = "normal";
        }
        const resolved = studentNamesQ.data?.[String(a.student_id)];
        const byMatricKey = String(a.students?.matric_number || a.students?.student_id || (a.metadata as Record<string, unknown> | null)?.matricNumber || "").trim().toLowerCase();
        const fromMatricMap = byMatricKey ? nameByMatricQ.data?.[`matric:${byMatricKey}`] : undefined;
        const fromIdMap = nameByMatricQ.data?.[String(a.student_id)];
        const frameId = camFrame || frames[a.id] || frames[`student:${a.student_id}`] || null;
        const metaName = nameFromMetadata(a.metadata);
        const frameName = String(frameId?.studentName || "").trim();
        const fromJoin = studentDisplayName(a);
        const resolvedName = typeof resolved === "string"
          ? resolved.trim()
          : String((resolved as { name?: string } | undefined)?.name || "").trim();
        // Prefer frame/meta first while joins load — live identity from student device
        const nameCandidates = [frameName, metaName, resolvedName, fromIdMap, fromMatricMap, fromJoin].filter(
          (n) => {
            const s = String(n || "").trim();
            if (!s) return false;
            if (s === "Student" || s.toLowerCase() === "unknown") return false;
            return true;
          },
        );
        const name = nameCandidates[0] || "Student";
        const metaMatric = (() => {
          const mm = a.metadata;
          if (!mm || typeof mm !== "object") return "";
          const r = mm as Record<string, unknown>;
          return String(r.matricNumber || r.matric_number || r.matric || r.student_id || "").trim();
        })();
        const frameMatric = String(frameId?.matricNumber || "").trim();
        const resolvedMatric = typeof resolved === "object" && resolved
          ? String((resolved as { matric?: string }).matric || "").trim()
          : "";
        const matric = String(
          a.students?.matric_number || a.students?.student_id || frameMatric || metaMatric || resolvedMatric || "",
        ).trim() || "—";
        const _c = a.examinations?.courses as unknown;
        const courseObj = Array.isArray(_c)
          ? (_c[0] as { code?: string; name?: string } | undefined)
          : (_c as { code?: string; name?: string } | null | undefined);
        const metaCourse = (() => {
          const mm = a.metadata;
          if (!mm || typeof mm !== "object") return "";
          const r = mm as Record<string, unknown>;
          return String(r.courseCode || r.course_code || "").trim();
        })();
        const metaTitle = (() => {
          const mm = a.metadata;
          if (!mm || typeof mm !== "object") return "";
          const r = mm as Record<string, unknown>;
          return String(r.examTitle || r.exam_title || "").trim();
        })();
        const examFromList = (examsQ.data ?? []).find((e) => String(e.id) === String(a.exam_id));
        const listCourse = (() => {
          if (!examFromList) return { code: "", name: "" };
          const c = Array.isArray(examFromList.courses)
            ? (examFromList.courses[0] as { code?: string; name?: string } | undefined)
            : (examFromList.courses as { code?: string; name?: string } | null | undefined);
          return { code: String(c?.code || "").trim(), name: String(c?.name || "").trim() };
        })();
        const courseCode = String(
          courseObj?.code || examEnrichQ.data?.[String(a.exam_id)]?.courseCode || listCourse.code || frameId?.courseCode || metaCourse || "",
        ).trim();
        const courseName = String(
          courseObj?.name || examEnrichQ.data?.[String(a.exam_id)]?.courseName || listCourse.name || "",
        ).trim();
        const course = courseCode && courseName && courseName.toLowerCase() !== courseCode.toLowerCase()
          ? `${courseCode} · ${courseName}`
          : (courseCode || courseName || "—");
        const title = String(
          a.examinations?.title || examEnrichQ.data?.[String(a.exam_id)]?.title || (examFromList as { title?: string } | undefined)?.title || frameId?.examTitle || metaTitle || "",
        ).trim() || "Exam";
        const bars = isDone ? 0 : signalBars(frame?.ts, presence.lastSeenAt, now);
        const activity = lastActivityMs(presence.lastSeenAt, a) ?? (frame?.ts ?? null);
        let videoStatus: "live" | "reconnecting" | "offline" | "done" = "offline";
        if (isDone) videoStatus = "done";
        else if (hasLiveVideo) videoStatus = "live";
        else if (isOnline(presence.lastSeenAt, now) || presence.cameraActive) videoStatus = "reconnecting";
        else videoStatus = "offline";
        return { a, presence, sev, name, matric, course, title, frame, camFrame, scrFrame, camLive, scrLive, hasLiveVideo, bars, isDone, activity, videoStatus };
      })
      .filter((c) => {
        if (c.isDone) {
          if (c.activity == null) return false;
          return now - c.activity <= RECENT_SUBMIT_MS;
        }
        if (c.sev === "offline") {
          if (c.activity == null) return true;
          return now - c.activity <= Math.max(OFFLINE_HIDE_MS, 45 * 60 * 1000);
        }
        return true;
      });
  }, [attemptsQ.data, recentDoneQ.data, now, frames, screenFrames, feedMode, studentNamesQ.data, nameByMatricQ.data, examEnrichQ.data, examsQ.data]);

  const stats = useMemo(() => {
    let online = 0,
      warnings = 0,
      violations = 0,
      offline = 0,
      writing = 0;
    for (const c of cards) {
      if (c.isDone) continue;
      writing += 1;
      if (c.sev === "normal") online += 1;
      else if (c.sev === "warning") {
        warnings += 1;
        online += 1;
      } else if (c.sev === "violation") {
        violations += 1;
        online += 1;
      } else if (c.sev === "offline") offline += 1;
    }
    return { writing, online, warnings, violations, offline, completed: completedQ.data ?? 0 };
  }, [cards, completedQ.data]);

  const examOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cards) {
      const id = String(c.a.exam_id || "");
      if (!id) continue;
      const label = (c.title && c.title !== "Exam" ? c.title : c.course) || "Exam";
      if (!map.has(id)) map.set(id, label);
    }
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [cards]);

  const levelOptions = useMemo(() => {
    const levels = new Set<string>();
    for (const c of cards) {
      const code = String(c.course || "");
      const m = code.match(/(\d{3})/);
      if (m) {
        const n = parseInt(m[1]!, 10);
        const lvl = Math.floor(n / 100) * 100;
        if (lvl >= 100 && lvl <= 900) levels.add(String(lvl));
      }
    }
    return Array.from(levels).sort((a, b) => Number(a) - Number(b));
  }, [cards]);

  const allowedExamIds = useMemo(() => {
    if (!courseIdSet) return null;
    const ids = new Set<string>();
    for (const e of examsQ.data ?? []) {
      ids.add(String(e.id));
    }
    return ids;
  }, [courseIdSet, examsQ.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cards.filter((c) => {
      if (allowedExamIds && !allowedExamIds.has(String(c.a.exam_id || ""))) return false;
      if (examFilter !== "all" && String(c.a.exam_id || "") !== examFilter) return false;
      if (levelFilter !== "all") {
        const code = String(c.course || "");
        const m = code.match(/(\d{3})/);
        const lvl = m ? String(Math.floor(parseInt(m[1]!, 10) / 100) * 100) : "";
        if (lvl !== levelFilter) return false;
      }
      if (filter === "offline" && c.sev !== "offline" && !c.isDone) return false;
      if (filter !== "all" && filter !== "offline" && (c.sev !== filter || c.isDone)) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.matric.toLowerCase().includes(q) || c.course.toLowerCase().includes(q);
    });
  }, [cards, filter, search, examFilter, levelFilter, allowedExamIds]);

  const orderedFiltered = useMemo(() => {
    if (!cardOrderIds.length) return filtered;
    const rank = new Map(cardOrderIds.map((id, i) => [id, i]));
    return [...filtered].sort((a, b) => {
      const ra = rank.has(a.a.id) ? rank.get(a.a.id)! : 1e9;
      const rb = rank.has(b.a.id) ? rank.get(b.a.id)! : 1e9;
      if (ra !== rb) return ra - rb;
      return 0;
    });
  }, [filtered, cardOrderIds]);

  function onCardDragStart(id: string) {
    dragIdRef.current = id;
  }
  function onCardDragOver(e: React.DragEvent, overId: string) {
    e.preventDefault();
    const from = dragIdRef.current;
    if (!from || from === overId) return;
  }
  function onCardDrop(overId: string, place: "before" | "after" | "swap" = "swap") {
    const from = dragIdRef.current;
    dragIdRef.current = null;
    if (!from || from === overId) return;
    setCardOrderIds((prev) => {
      const base = prev.length ? [...prev] : filtered.map((c) => c.a.id);
      for (const c of filtered) {
        if (!base.includes(c.a.id)) base.push(c.a.id);
      }
      const fi = base.indexOf(from);
      let ti = base.indexOf(overId);
      if (fi < 0 || ti < 0) return base;
      base.splice(fi, 1);
      ti = base.indexOf(overId);
      if (ti < 0) {
        base.push(from);
        return base;
      }
      if (place === "before") {
        base.splice(ti, 0, from);
      } else if (place === "after") {
        base.splice(ti + 1, 0, from);
      } else {
        // swap: put dragged where target was, target takes dragged's old slot
        const target = base[ti]!;
        base[ti] = from;
        // insert target at original from index (adjusted)
        const insertAt = fi > ti ? fi : fi;
        // after removing from, indices shifted — recompute clean swap:
        // simpler: remove both and reinsert
        // Rebuild with swap of positions in original order snapshot
        const snap = prev.length ? [...prev] : filtered.map((c) => c.a.id);
        for (const c of filtered) {
          if (!snap.includes(c.a.id)) snap.push(c.a.id);
        }
        const a = snap.indexOf(from);
        const b = snap.indexOf(overId);
        if (a >= 0 && b >= 0) {
          const tmp = snap[a]!;
          snap[a] = snap[b]!;
          snap[b] = tmp;
          return snap;
        }
        base.splice(ti, 0, from);
      }
      return base;
    });
  }

  function onCardDropAtEdge(overId: string, clientX: number, rect: DOMRect) {
    const mid = rect.left + rect.width / 2;
    const place = clientX < mid ? "before" : "after";
    onCardDrop(overId, place);
  }

  const selected = cards.find((c) => c.a.id === selectedId) ?? null;
  const studentNameById = useMemo(() => {
    const m = new Map<string, { name: string; matric: string }>();
    for (const c of cards) m.set(c.a.student_id, { name: c.name, matric: c.matric });
    return m;
  }, [cards]);

  const alerts = useMemo(() => {
    return events
      .filter((e) => {
        const t = String(e.event_type || "").toUpperCase();
        return (
          t.includes("FACE") ||
          t.includes("CAMERA") ||
          t.includes("TAB") ||
          t.includes("FULLSCREEN") ||
          t.includes("CONNECTION") ||
          t.includes("SUBMIT") ||
          t.includes("WARNING") ||
          t.includes("RESULT") ||
          t.includes("TERMINAT") ||
          e.severity === "high" ||
          e.severity === "medium"
        );
      })
      .slice(0, 40);
  }, [events]);

  useEffect(() => {
    if (!events.length) return;
    if (!alertsBootstrappedRef.current) {
      for (const e of events) seenAlertIdsRef.current.add(e.id);
      alertsBootstrappedRef.current = true;
      return;
    }
    for (const e of events) {
      if (seenAlertIdsRef.current.has(e.id)) continue;
      seenAlertIdsRef.current.add(e.id);
      if (isFaceOrCameraLogOnly(e.event_type)) continue;
      const high = e.severity === "high";
      const med = e.severity === "medium";
      if (!high && !med) continue;
      const who = e.student_id ? studentNameById.get(e.student_id)?.name : null;
      const label = humanEventLabel(e.event_type, e.description);
      const msg = who ? `${who}: ${label}` : label;
      if (high) toast.error(msg, { id: `alert-${e.id}`, duration: 5000 });
      else toast.warning(msg, { id: `alert-${e.id}`, duration: 4500 });
    }
  }, [events, studentNameById]);

  // Alerts list retained for future; panel UI removed per product request
  const _unreadAlerts = alerts.filter((a) => !readAlertIds.has(a.id));
  void _unreadAlerts;
  const selectedTimeline = useMemo(() => {
    if (!selected) return [];
    const attemptId = String(selected.a.id || "");
    const examId = String(selected.a.exam_id || "");
    const studentId = String(selected.a.student_id || "");
    return events
      .filter((e) => {
        if (String(e.student_id || "") !== studentId) return false;
        // Prefer attempt-scoped events when attempt_id is present
        if (e.attempt_id) return String(e.attempt_id) === attemptId;
        // Fallback: same exam (legacy rows without attempt_id)
        if (e.exam_id) return String(e.exam_id) === examId;
        return false;
      })
      .slice(0, 30);
  }, [events, selected]);

  const primaryExamLabel = (() => {
    if (liveExams[0]) {
      const c = Array.isArray(liveExams[0].courses)
        ? (liveExams[0].courses[0] as { code?: string } | undefined)?.code
        : (liveExams[0].courses as { code?: string } | null)?.code;
      const code = String(c || "").trim();
      const title = String(liveExams[0].title || "").trim();
      if (code && title) return `${code} · ${title}`;
      if (title) return title;
      if (code) return code;
    }
    const c0 = cards.find((c) => c.course && c.course !== "—" && c.title && c.title !== "Exam") || cards[0];
    if (c0) {
      const course = c0.course && c0.course !== "—" ? c0.course : "";
      const title = c0.title && c0.title !== "Exam" ? c0.title : "";
      if (course && title) return `${course} · ${title}`;
      if (title) return title;
      if (course) return course;
    }
    return "No live exam";
  })();

  async function broadcastOfficerCommand(cmd: "submit" | "hold" | "pause" | "release" | "terminate", attemptId: string, studentId: string, examId: string) {
    try {
      const ch = supabase.channel(`student-exam-cmd:${studentId}`);
      await new Promise<void>((resolve) => {
        const t = window.setTimeout(() => resolve(), 2000);
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            window.clearTimeout(t);
            resolve();
          }
        });
      });
      await ch.send({
        type: "broadcast",
        event: "officer_command",
        payload: { command: cmd, attemptId, studentId, examId, ts: Date.now() },
      });
      window.setTimeout(() => { void supabase.removeChannel(ch); }, 1200);
    } catch (e) {
      console.warn("[live-monitor] officer_command broadcast", e);
    }
  }

  async function officerControl(cmd: "submit" | "hold" | "pause" | "release" | "terminate") {
    if (!selected || !schoolId || actionBusy || selected.isDone) return;
    const labels: Record<string, string> = {
      submit: "force-submit",
      hold: "hold/pause",
      pause: "pause",
      release: "release",
      terminate: "terminate",
    };
    if (!window.confirm(`Are you sure you want to ${labels[cmd] || cmd} this student's examination?`)) return;
    setActionBusy(true);
    try {
      const attemptId = selected.a.id;
      const studentId = selected.a.student_id;
      const examId = selected.a.exam_id;
      const nowIso = new Date().toISOString();
      if (cmd === "hold" || cmd === "pause") {
        const meta = { ...(selected.a.metadata || {}), officer_hold: true, officer_pause: true, officer_hold_at: nowIso };
        let { error } = await supabase.from("exam_attempts").update({ metadata: meta, status: "paused", updated_at: nowIso } as never).eq("id", attemptId).eq("school_id", schoolId);
        if (error) {
          const r2 = await supabase.from("exam_attempts").update({ metadata: meta, status: "paused", updated_at: nowIso } as never).eq("id", attemptId);
          error = r2.error;
        }
        if (error) throw error;
        await logSecurityEvent({ schoolId, examId, attemptId, studentId, eventType: "OFFICER_PAUSE", severity: "medium", description: "Examination paused by officer", extra: { source: "officer_live_monitor", officer_user_id: user?.userId ?? null } });
        await broadcastOfficerCommand("pause", attemptId, studentId, examId);
        window.setTimeout(() => { void broadcastOfficerCommand("pause", attemptId, studentId, examId); }, 800);
        qc.setQueryData(["officer-live-attempts", schoolId, courseIds?.slice().sort().join(",") ?? "all"], (prev: unknown) => {
          if (!Array.isArray(prev)) return prev;
          return prev.map((row: { id?: string; metadata?: Record<string, unknown> }) =>
            String(row?.id) === String(attemptId)
              ? { ...row, status: "paused", metadata: { ...(row.metadata || {}), officer_hold: true, officer_pause: true, officer_hold_at: nowIso } }
              : row,
          );
        });
        setForcePausedIds((prev) => ({ ...prev, [String(attemptId)]: true }));
        toast.success(`Paused — Resume is available for ${selected.name}`);
      } else if (cmd === "release") {
        const prev = { ...(selected.a.metadata || {}) } as Record<string, unknown>;
        delete prev.officer_hold; delete prev.officer_pause; delete prev.officer_hold_at;
        const { error } = await supabase.from("exam_attempts").update({ metadata: prev, status: "in_progress", updated_at: nowIso } as never).eq("id", attemptId).eq("school_id", schoolId);
        if (error) throw error;
        await logSecurityEvent({ schoolId, examId, attemptId, studentId, eventType: "OFFICER_RELEASE", severity: "low", description: "Examination released by officer", extra: { source: "officer_live_monitor", officer_user_id: user?.userId ?? null } });
        await broadcastOfficerCommand("release", attemptId, studentId, examId);
        window.setTimeout(() => { void broadcastOfficerCommand("release", attemptId, studentId, examId); }, 800);
        qc.setQueryData(["officer-live-attempts", schoolId, courseIds?.slice().sort().join(",") ?? "all"], (prev: unknown) => {
          if (!Array.isArray(prev)) return prev;
          return prev.map((row: { id?: string; metadata?: Record<string, unknown> }) => {
            if (String(row?.id) !== String(attemptId)) return row;
            const meta = { ...(row.metadata || {}) };
            delete meta.officer_hold; delete meta.officer_pause; delete meta.officer_hold_at;
            return { ...row, status: "in_progress", metadata: meta };
          });
        });
        setForcePausedIds((prev) => {
          const n = { ...prev };
          delete n[String(attemptId)];
          return n;
        });
        toast.success(`Resumed — ${selected.name} can continue`);
        setForcePausedIds((prev) => {
          const next = { ...prev };
          delete next[String(attemptId)];
          return next;
        });
      } else if (cmd === "terminate") {
        const { error } = await supabase.from("exam_attempts").update({ status: "terminated", terminated_at: nowIso, submitted_at: nowIso, security_review_status: "terminated", updated_at: nowIso } as never).eq("id", attemptId).eq("school_id", schoolId);
        if (error) throw error;
        await logSecurityEvent({ schoolId, examId, attemptId, studentId, eventType: "OFFICER_TERMINATE", severity: "high", description: "Examination terminated by officer for examination violation", extra: { source: "officer_live_monitor", officer_user_id: user?.userId ?? null } });
        await broadcastOfficerCommand("terminate", attemptId, studentId, examId);
        window.setTimeout(() => { void broadcastOfficerCommand("terminate", attemptId, studentId, examId); }, 500);
        window.setTimeout(() => { void broadcastOfficerCommand("terminate", attemptId, studentId, examId); }, 1500);
        toast.success(`Terminated ${selected.name}`);
        setSelectedId(null);
      } else if (cmd === "submit") {
        const prevMeta = { ...(selected.a.metadata || {}) } as Record<string, unknown>;
        delete prevMeta.officer_hold; delete prevMeta.officer_pause; delete prevMeta.officer_hold_at;
        prevMeta.officer_force_submit = true;
        prevMeta.officer_force_submit_at = nowIso;
        const { error } = await supabase.from("exam_attempts").update({
          status: "submitted",
          submitted_at: nowIso,
          updated_at: nowIso,
          metadata: prevMeta,
        } as never).eq("id", attemptId).eq("school_id", schoolId);
        if (error) throw error;
        await logSecurityEvent({ schoolId, examId, attemptId, studentId, eventType: "OFFICER_SUBMIT", severity: "medium", description: "Examination force-submitted by officer", extra: { source: "officer_live_monitor", officer_user_id: user?.userId ?? null } });
        await broadcastOfficerCommand("submit", attemptId, studentId, examId);
        window.setTimeout(() => { void broadcastOfficerCommand("submit", attemptId, studentId, examId); }, 700);
        window.setTimeout(() => { void broadcastOfficerCommand("submit", attemptId, studentId, examId); }, 1800);
        toast.success(`Submitted — ${selected.name}'s exam is closed`);
        setSelectedId(null);
      }
      void attemptsQ.refetch();
      void recentDoneQ.refetch();
      void eventsQ.refetch();
      void qc.invalidateQueries({ queryKey: ["officer-live-attempts", schoolId] });
      void qc.invalidateQueries({ queryKey: ["officer-live-recent-done", schoolId] });
    } catch (e) {
      toast.error("Could not apply officer action");
      console.warn(e);
    } finally {
      setActionBusy(false);
    }
  }

  async function sendOfficerWarning() {

    if (!selected || !schoolId || warningBusy || selected.isDone) return;
    setWarningBusy(true);
    try {
      await logSecurityEvent({
        schoolId,
        examId: selected.a.exam_id,
        attemptId: selected.a.id,
        studentId: selected.a.student_id,
        eventType: "WARNING_SHOWN",
        severity: "high",
        description: "Warning: Follow exam rules. Further violations may void your result.",
        extra: { source: "officer_live_monitor", officer_user_id: user?.userId ?? null, student_facing: true },
      });
      await notifyStudentOfficerWarning({
        schoolId,
        studentId: selected.a.student_id,
        examId: selected.a.exam_id,
        examTitle: selected.title,
        message: "Warning: Follow exam rules. Further violations may void your result.",
      });
      // Instant in-exam delivery via Realtime broadcast (no RLS dependency)
      try {
        const warnCh = supabase.channel(`student-exam-warn:${selected.a.student_id}`);
        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(() => resolve(), 2500);
          warnCh.subscribe((status) => {
            if (status === "SUBSCRIBED") {
              window.clearTimeout(t);
              resolve();
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              window.clearTimeout(t);
              reject(new Error(String(status)));
            }
          });
        });
        await warnCh.send({
          type: "broadcast",
          event: "officer_warning",
          payload: {
            studentId: selected.a.student_id,
            examId: selected.a.exam_id,
            attemptId: selected.a.id,
            message: "Warning: Follow exam rules. Further violations may void your result.",
            ts: Date.now(),
          },
        });
        window.setTimeout(() => { void supabase.removeChannel(warnCh); }, 1500);
      } catch (be) {
        console.warn("[live-monitor] warn broadcast", be);
      }
      toast.success(`Warning sent to ${selected.name}`);
      void eventsQ.refetch();
    } catch (e) {
      toast.error("Could not send warning");
      console.warn(e);
    } finally {
      setWarningBusy(false);
    }
  }

  const FILTERS = [
    ["all", "All"],
    ["normal", "Normal"],
    ["warning", "Warn"],
    ["violation", "Viol."],
    ["offline", "Off"],
  ] as const;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-0 sm:px-0">
      <PageHeader
        title={pageTitle || "Live Monitoring"}
        description={
          <span className="flex flex-wrap items-center gap-1.5 text-[12px] sm:text-sm">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 sm:gap-1.5 sm:px-2 sm:text-[11px]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> LIVE
            </span>
            <span className="min-w-0 truncate text-slate-600">{primaryExamLabel}</span>
          </span>
        }
      />
      <div className="mb-3 grid grid-cols-3 gap-1.5 sm:mb-4 sm:grid-cols-3 sm:gap-2 lg:grid-cols-6">
        <StatCard label="Writing" value={stats.writing} />
        <StatCard label="Online" value={stats.online} tone="emerald" />
        <StatCard label="Warnings" value={stats.warnings} tone="amber" />
        <StatCard label="Violations" value={stats.violations} tone="red" />
        <StatCard label="Offline" value={stats.offline} tone="slate" />
        <StatCard label="Done (12h)" value={stats.completed} tone="blue" />
      </div>
      <div className="mb-3 space-y-2 sm:mb-4">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 sm:h-3.5 sm:w-4" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or matric…"
            className="h-8 pl-8 text-xs sm:h-9 sm:text-sm"
          />
        </div>
        {examOptions.length > 1 ? (
          <div className="flex w-full flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setExamFilter("all")}
              className={cn(
                "rounded-full px-2.5 py-1 text-[10px] font-bold sm:text-[11px]",
                examFilter === "all" ? "bg-primary text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              All exams
            </button>
            {examOptions.map((ex) => (
              <button
                key={ex.id}
                type="button"
                onClick={() => setExamFilter(ex.id)}
                className={cn(
                  "max-w-[14rem] truncate rounded-full px-2.5 py-1 text-[10px] font-bold sm:text-[11px]",
                  examFilter === ex.id ? "bg-primary text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
                title={ex.label}
              >
                {ex.label}
              </button>
            ))}
          </div>
        ) : null}
        {levelOptions.length > 1 ? (
          <div className="flex w-full flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setLevelFilter("all")}
              className={cn(
                "rounded-full px-2.5 py-1 text-[10px] font-bold sm:text-[11px]",
                levelFilter === "all" ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              All levels
            </button>
            {levelOptions.map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => setLevelFilter(lv)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[10px] font-bold sm:text-[11px]",
                  levelFilter === lv ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
              >
                {lv} Level
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {FILTERS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-bold transition sm:px-2.5 sm:py-1 sm:text-[11px]",
                  filter === k ? "bg-primary text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="inline-flex shrink-0 rounded-lg border border-slate-200 bg-white p-0.5">
            <button
              type="button"
              onClick={() => setView("grid")}
              className={cn(
                "inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[10px] font-semibold sm:gap-1 sm:px-2 sm:py-1.5 sm:text-[11px]",
                view === "grid" ? "bg-primary text-white" : "text-slate-600",
              )}
            >
              <LayoutGrid className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> Grid
            </button>
            <button
              type="button"
              onClick={() => setView("list")}
              className={cn(
                "inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[10px] font-semibold sm:gap-1 sm:px-2 sm:py-1.5 sm:text-[11px]",
                view === "list" ? "bg-primary text-white" : "text-slate-600",
              )}
            >
              <List className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> List
            </button>
          </div>
          {isNativeShell() ? (
            <button
              type="button"
              onClick={() => setDesktopView((v) => !v)}
              title={desktopView ? "Exit desktop view" : "Desktop view"}
              aria-pressed={desktopView}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition sm:h-8 sm:w-8",
                desktopView
                  ? "border-primary bg-primary text-white shadow-sm"
                  : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
              )}
            >
              <Monitor className="h-3.5 w-3.5 sm:h-4 sm:w-4" aria-hidden />
              <span className="sr-only">{desktopView ? "Exit desktop view" : "Desktop view"}</span>
            </button>
          ) : null}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-1 lg:gap-4">
        <div>
          {attemptsQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading live sessions…</p>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Radio}
              title="No active students"
              description="Students appear here while writing. Offline sessions leave after 3 minutes. Video is never saved."
            />
          ) : (
            <>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Feed</span>
              {([
                ["camera", "Camera"],
                ["screen", "Screen"],
                ["both", "Both"],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFeedMode(k)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[10px] font-bold",
                    feedMode === k ? "bg-primary text-white" : "bg-slate-100 text-slate-600",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            
              <Button type="button" variant={audioMuted ? "outline" : "default"} size="sm" className={cn("h-7 shrink-0 px-2 text-[10px] font-semibold sm:h-8 sm:text-xs", !audioMuted && "bg-emerald-600 text-white hover:bg-emerald-700")} onClick={() => { setAudioMuted((m) => { const next = !m; if (!next) { try { if (!audioCtxRef.current) { const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext; audioCtxRef.current = new AC(); } void audioCtxRef.current?.resume(); } catch { /* ignore */ } } return next; }); }} title={audioMuted ? "Unmute student microphones" : "Mute all"}>{audioMuted ? (<><MicOff className="mr-1 h-3.5 w-3.5" /> Muted</>) : (<><Mic className="mr-1 h-3.5 w-3.5" /> Listening</>)}</Button>
{view === "grid" ? (
            <div className="d4-monitor-grid grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {orderedFiltered.map((c) => (
                <StudentCard
                  key={c.a.id}
                  name={c.name}
                  matric={c.matric}
                  course={c.course}
                  sev={c.sev}
                  presence={c.presence}
                  frameSrc={
                    feedMode === "screen"
                      ? (c.scrFrame?.src || c.frame?.src)
                      : feedMode === "camera"
                        ? (c.camFrame?.src || c.frame?.src)
                        : (c.camFrame?.src || c.scrFrame?.src || c.frame?.src)
                  }
                  camSrc={c.camFrame?.src}
                  scrSrc={c.scrFrame?.src}
                  feedMode={feedMode}
                  streamLive={c.hasLiveVideo || Boolean(c.camLive || c.scrLive) || Boolean(c.camFrame?.src || c.scrFrame?.src)}
                  bars={c.bars}
                  isDone={c.isDone}
                  statusLabel={c.isDone ? doneStatusLabel(c.a.status) : undefined}
                  dragId={c.a.id}
                  onDragStart={onCardDragStart}
                  onDragOver={onCardDragOver}
                  onDrop={(id, place) => onCardDrop(id, place || "swap")}
                  onClick={() => setSelectedId(c.a.id)}
                />
              ))}
            </div>
          ) : (
            <ul className="space-y-1.5 sm:space-y-2">
              {filtered.map((c) => (
                <li key={c.a.id}>
                  <button
                    type="button"
                    dragId={c.a.id}
                  onDragStart={onCardDragStart}
                  onDragOver={onCardDragOver}
                  onDrop={(id, place) => onCardDrop(id, place || "swap")}
                  onClick={() => setSelectedId(c.a.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg border bg-white p-2 text-left shadow-sm transition hover:shadow-md sm:gap-3 sm:rounded-xl sm:p-3",
                      severityBorderClass(c.sev),
                    )}
                  >
                    <div className="relative h-10 w-14 shrink-0 overflow-hidden rounded-md bg-slate-900 sm:h-12 sm:w-16 sm:rounded-lg">
                      {c.isDone ? (
                        <div className="grid h-full place-items-center bg-sky-900/50">
                          <CheckCircle2 className="h-5 w-5 text-sky-300" />
                        </div>
                      ) : (c.camFrame?.src || c.scrFrame?.src || c.frame?.src) ? (
                        <img
                          src={(c.camFrame?.src || c.frame?.src || c.scrFrame?.src)!}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full place-items-center">
                          <UserRound className="h-4 w-4 text-white/30 sm:h-5 sm:w-5" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-slate-900 sm:text-sm">{c.name}</p>
                      <p className="truncate text-[10px] text-slate-500 sm:text-[11px]">
                        {c.matric} · {c.course}
                      </p>
                    </div>
                    {!c.isDone && <SignalBars bars={c.bars} className="hidden sm:flex" />}
                    <FaceChip
                      presence={c.presence}
                      sev={c.sev}
                      isDone={c.isDone}
                      statusLabel={c.isDone ? doneStatusLabel(c.a.status) : undefined}
                    />
                    {!c.isDone && (
                      <span className="hidden font-mono text-[10px] font-semibold text-slate-600 sm:inline sm:text-[11px]">
                        {formatDuration(c.presence.timeRemainingSec)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
            </>
          )}
        </div>
        
      </div>
      {selected && (
        <div
          className="fixed inset-0 z-[70] flex flex-col bg-black/40 lg:left-64"
          style={{ paddingTop: "max(0px, env(safe-area-inset-top, 0px))" }}
          onClick={() => setSelectedId(null)}
        >
          {/* Spacer for top app bar so header is never covered */}
          <div className="h-12 shrink-0 sm:h-16" aria-hidden />
          <div
            className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-3 py-2.5 sm:px-4 sm:py-3">
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => setSelectedId(null)}
                aria-label="Back to all students"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Back
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-extrabold text-slate-900">{selected.name}</p>
                <p className="truncate text-[11px] text-slate-500">{selected.matric}</p>
              </div>
              <button
                type="button"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full hover:bg-slate-100"
                onClick={() => setSelectedId(null)}
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {/* Feed mode + dual pane */}
            <div className="shrink-0 border-b border-slate-100 px-3 py-2 sm:px-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Feed</span>
                {([
                  ["camera", "Camera"],
                  ["screen", "Screen"],
                  ["both", "Both"],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setFeedMode(k)}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[10px] font-bold transition",
                      feedMode === k ? "bg-primary text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
                    )}
                  >
                    {label}
                  </button>
                ))}
                <span className="ml-auto truncate text-[10px] font-semibold text-slate-500">
                  {selected.course} · {selected.title}
                </span>
              </div>
            </div>
            {(() => {
              const camF = selected.camFrame || frames[selected.a.id] || frames[`student:${selected.a.student_id}`] || null;
              const sf = selected.scrFrame || screenFrames[selected.a.id] || screenFrames[`student:${selected.a.student_id}`] || null;
              const camLive = Boolean(camF && isLiveCamFrameFresh(camF.ts));
              const scrLive = Boolean(sf && isLiveScreenFrameFresh(sf.ts));
              const showCamFrame = Boolean(camF?.src && isLiveCamFrameUsable(camF.ts)) && !selected.isDone;
              const showScrFrame = Boolean(sf?.src && isLiveScreenFrameUsable(sf.ts)) && !selected.isDone;
              const showCam = feedMode === "camera" || feedMode === "both";
              const showScr = feedMode === "screen" || feedMode === "both";
              const dual = showCam && showScr;
              return (
                <div
                  className={cn(
                    "shrink-0 bg-slate-100 p-1.5 sm:p-2",
                    // Only mount visible panes — no reserved empty column
                    dual
                      ? "grid grid-cols-2 items-stretch gap-1.5 sm:gap-3"
                      : "flex flex-col gap-1.5",
                  )}
                >
                  {showCam && (
                    <div
                      className={cn(
                        "relative w-full overflow-hidden rounded-xl bg-slate-900 shadow-inner ring-1 ring-black/10",
                        dual
                          ? "h-[13.5rem] sm:h-[18rem] lg:h-[min(42vh,28rem)] xl:h-[min(48vh,34rem)]"
                          : "mx-auto aspect-square w-full max-w-[min(100%,22rem)] sm:max-w-[min(100%,26rem)] lg:max-w-[min(100%,28rem)]",
                      )}
                    >
                      {showCamFrame ? (
                        <img
                          src={camF!.src}
                          alt={`${selected.name} camera`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-1.5 px-3 text-center text-white/70">
                          {selected.isDone ? (
                            <CheckCircle2 className="h-10 w-10 text-emerald-400/80" />
                          ) : (
                            <CameraOff className="h-10 w-10 opacity-40" />
                          )}
                          <p className="text-xs font-semibold text-white/90">
                            {selected.isDone
                              ? doneStatusLabel(selected.a.status)
                              : camF && isLiveCamFrameUsable(camF.ts)
                                ? "Camera reconnecting…"
                                : "Camera offline"}
                          </p>
                        </div>
                      )}
                      <div className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            camLive ? "animate-pulse bg-emerald-400" : showCamFrame ? "bg-amber-400" : "bg-slate-400",
                          )}
                        />
                        Camera {camLive ? "· Live" : showCamFrame ? "· Delayed" : ""}
                      </div>
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2.5 pb-2 pt-8">
                        <p className="truncate text-[11px] font-bold text-white">{selected.name}</p>
                        <p className="truncate text-[10px] text-white/80">{selected.matric}</p>
                      </div>
                    </div>
                  )}
                  {showScr && (
                    <div
                      className={cn(
                        "relative w-full overflow-hidden rounded-xl bg-slate-950 shadow-inner ring-1 ring-black/10",
                        // Match camera card height exactly in dual mode
                        dual
                          ? "h-[13.5rem] sm:h-[18rem] lg:h-[min(42vh,28rem)] xl:h-[min(48vh,34rem)]"
                          : "mx-auto aspect-square w-full max-w-[min(100%,22rem)] sm:max-w-[min(100%,26rem)] lg:max-w-[min(100%,28rem)]",
                      )}
                    >
                      {showScrFrame ? (
                        <div className="h-full w-full overflow-y-auto overflow-x-hidden overscroll-contain">
                          <img
                            src={sf!.src}
                            alt={`${selected.name} screen`}
                            className="mx-auto block min-h-full w-full bg-black object-contain object-top"
                          />
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "flex flex-col items-center justify-center gap-1.5 px-4 text-center text-white/60",
                            dual ? "h-[13.5rem] sm:h-[18rem] lg:h-[min(42vh,28rem)] xl:h-[min(48vh,34rem)]" : "h-full min-h-[12rem]",
                          )}
                        >
                          <Monitor className="h-10 w-10 opacity-30" />
                          <p className="text-xs font-semibold text-white/80">Screen not shared</p>
                          <p className="text-[10px] text-white/50">Appears when the student shares their screen</p>
                        </div>
                      )}
                      <div className="sticky left-2 top-2 z-[1] inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            scrLive ? "animate-pulse bg-emerald-400" : showScrFrame ? "bg-amber-400" : "bg-slate-400",
                          )}
                        />
                        Screen {scrLive ? "· Live" : showScrFrame ? "· Delayed" : ""}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="grid grid-cols-2 gap-2 border-b border-slate-100 p-3 text-sm sm:p-4">
              <Info label="Course" value={selected.course} />
              <Info label="Exam" value={selected.title} />
              <Info label="Status" value={selected.isDone ? doneStatusLabel(selected.a.status) : humanLiveStatus(selected.sev)} />
              <Info
                label="Time left"
                value={selected.isDone ? "—" : formatDuration(selected.presence.timeRemainingSec)}
              />
              <Info
                label="Answered"
                value={
                  selected.presence.answeredCount != null && selected.presence.totalQuestions != null
                    ? `${selected.presence.answeredCount} / ${selected.presence.totalQuestions}`
                    : "—"
                }
              />
              <Info label="Connection" value={selected.hasLiveVideo || isOnline(selected.presence.lastSeenAt) ? "Online" : "Offline"} />
              <Info label="Camera" value={selected.camLive ? "Active" : (selected.presence.cameraActive || (selected.camFrame?.src && isLiveCamFrameUsable(selected.camFrame.ts)) ? "Reconnecting" : "Off")} />
              <Info label="Face" value={selected.isDone ? "—" : faceLabel(selected.presence)} />
              <Info
                label="Screen"
                value={(() => {
                  const sf = screenFrames[selected.a.id] || screenFrames[`student:${selected.a.student_id}`];
                  if (sf && isLiveScreenFrameFresh(sf.ts)) return "Sharing live";
                  if (sf && isLiveScreenFrameUsable(sf.ts)) return "Sharing (delayed)";
                  return "Not sharing";
                })()}
              />
              <Info label="Tab switches" value={String(Math.max(
                Number(selected.a.tab_switch_count ?? 0),
                Number((selected.presence as { tabSwitchCount?: number }).tabSwitchCount ?? 0),
              ))} />
            </div>
            {!selected.isDone && (
              <div className="flex flex-wrap gap-2 border-b border-slate-100 px-3 py-2.5 sm:px-4 sm:py-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 border-amber-300 bg-amber-50 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                  disabled={warningBusy || actionBusy}
                  onClick={() => void sendOfficerWarning()}
                >
                  {warningBusy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MessageSquareWarning className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Send warning
                </Button>
                <Button size="sm" variant="outline" className="h-8 text-xs font-semibold" disabled={actionBusy || warningBusy} onClick={() => void officerControl("submit")}>
                  {actionBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Submit Exam
                </Button>
                {(() => {
                  const st = String(selected.a.status || "").toLowerCase();
                  const meta = (selected.a.metadata || {}) as Record<string, unknown>;
                  const forced = Boolean(forcePausedIds[String(selected.a.id)]);
                  const statusPaused = st === "paused" || st === "held";
                  const metaPaused =
                    statusPaused &&
                    (meta.officer_pause === true ||
                      meta.officer_hold === true ||
                      String(meta.officer_pause || "").toLowerCase() === "true" ||
                      String(meta.officer_hold || "").toLowerCase() === "true");
                  const showResume = forced || statusPaused || metaPaused;
                  return showResume ? (
                  <Button size="sm" variant="outline" className="h-8 text-xs font-semibold" disabled={actionBusy || warningBusy} onClick={() => void officerControl("release")}>
                    Resume Exam
                  </Button>
                  ) : (
                  <Button size="sm" variant="outline" className="h-8 text-xs font-semibold" disabled={actionBusy || warningBusy} onClick={() => void officerControl("pause")}>
                    Pause Exam
                  </Button>
                  );
                })()}
                <Button size="sm" variant="outline" className="h-8 border-red-300 bg-red-50 text-xs font-semibold text-red-700 hover:bg-red-100" disabled={actionBusy || warningBusy} onClick={() => void officerControl("terminate")}>
                  Terminate Exam
                </Button>
                <p className="w-full text-[10px] text-slate-400">
                  Actions apply server-side and reach the student live. Live video is never saved.
                </p>
              </div>
            )}
            <div className="p-3 sm:p-4">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Events timeline</h4>
              <p className="mb-2 text-[11px] font-medium text-slate-600">
                {selected.title || "Exam"} · Attempt {String(selected.a.id).slice(0, 8)}…
              </p>
                {selectedTimeline.length === 0 ? (
                <p className="text-xs text-slate-500">No integrity events yet for this student on this exam attempt.</p>
              ) : (
                <ul className="space-y-2">
                  {selectedTimeline.map((ev) => (
                    <li key={ev.id} className="flex gap-2 text-xs">
                      <span
                        className={cn(
                          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                          ev.severity === "high"
                            ? "bg-red-500"
                            : ev.severity === "medium"
                              ? "bg-amber-500"
                              : "bg-emerald-500",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-800">
                          {humanEventLabel(ev.event_type, ev.description)}
                        </p>
                        <p className="text-slate-500">{relativeTime(ev.created_at)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: number;
  tone?: "slate" | "emerald" | "amber" | "red" | "blue";
}) {
  const tones = {
    slate: "border-slate-200 bg-white",
    emerald: "border-emerald-100 bg-emerald-50/60",
    amber: "border-amber-100 bg-amber-50/60",
    red: "border-red-100 bg-red-50/60",
    blue: "border-sky-100 bg-sky-50/60",
  };
  return (
    <div className={cn("rounded-lg border p-2 shadow-sm sm:rounded-xl sm:p-3", tones[tone])}>
      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 sm:text-[10px]">{label}</p>
      <p className="mt-0.5 text-base font-extrabold tabular-nums text-slate-900 sm:text-xl">{value}</p>
    </div>
  );
}

function FaceChip({
  presence,
  sev,
  isDone,
  statusLabel,
}: {
  presence: ReturnType<typeof parsePresence>;
  sev: MonitorSeverity;
  isDone?: boolean;
  statusLabel?: string;
}) {
  if (isDone) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-sky-600 px-1.5 py-0.5 text-[9px] font-bold text-white sm:gap-1 sm:px-2 sm:text-[10px]">
        <CheckCircle2 className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
        {statusLabel || "Submitted"}
      </span>
    );
  }
  const isAmberFace = presence.faceStatus === "none" || presence.faceStatus === "unclear" || sev === "warning";
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 truncate rounded-full px-1.5 py-0.5 text-[9px] font-bold text-white sm:gap-1 sm:px-2 sm:text-[10px]",
        isAmberFace ? "bg-amber-500 text-white" : severityBadgeClass(sev),
      )}
    >
      {!presence.cameraActive ? (
        <CameraOff className="h-2.5 w-2.5 shrink-0 sm:h-3 sm:w-3" />
      ) : sev === "normal" ? (
        <CheckCircle2 className="h-2.5 w-2.5 shrink-0 sm:h-3 sm:w-3" />
      ) : (
        <AlertTriangle className="h-2.5 w-2.5 shrink-0 sm:h-3 sm:w-3" />
      )}
      <span className="truncate">{faceLabel(presence)}</span>
    </span>
  );
}

function StudentCard({
  name,
  matric,
  course,
  sev,
  presence,
  frameSrc,
  camSrc,
  scrSrc,
  feedMode = "camera",
  streamLive,
  bars,
  isDone,
  statusLabel,
  onClick,
  dragId,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  name: string;
  matric: string;
  course: string;
  sev: MonitorSeverity;
  presence: ReturnType<typeof parsePresence>;
  frameSrc?: string;
  camSrc?: string;
  scrSrc?: string;
  feedMode?: "camera" | "screen" | "both";
  streamLive?: boolean;
  bars: number;
  isDone?: boolean;
  statusLabel?: string;
  onClick: () => void;
  dragId?: string;
  onDragStart?: (id: string) => void;
  onDragOver?: (e: React.DragEvent, id: string) => void;
  onDrop?: (id: string, place?: "before" | "after" | "swap") => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      draggable={Boolean(dragId)}
      onDragStart={(e) => {
        if (!dragId) return;
        try {
          e.dataTransfer.setData("text/plain", dragId);
          e.dataTransfer.effectAllowed = "move";
        } catch { /* ignore */ }
        onDragStart?.(dragId);
      }}
      onDragOver={(e) => {
        if (!dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver?.(e, dragId);
      }}
      onDrop={(e) => {
        if (!dragId) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        // Left half = insert before, right half = insert after (rearrange);
        // center band still swaps via onDrop default when nearly center
        const place =
          e.clientX < mid - rect.width * 0.2
            ? "before"
            : e.clientX > mid + rect.width * 0.2
              ? "after"
              : "swap";
        onDrop?.(dragId, place);
      }}
      onTouchStart={(e) => {
        if (!dragId) return;
        const touch = e.touches[0];
        if (!touch) return;
        (e.currentTarget as HTMLElement).dataset.d4LongPress = "0";
        const timer = window.setTimeout(() => {
          (e.currentTarget as HTMLElement).dataset.d4LongPress = "1";
          onDragStart?.(dragId);
          try {
            if (navigator.vibrate) navigator.vibrate(20);
          } catch { /* ignore */ }
        }, 380);
        (e.currentTarget as HTMLElement).dataset.d4LpTimer = String(timer);
      }}
      onTouchEnd={(e) => {
        const el = e.currentTarget as HTMLElement;
        const timer = Number(el.dataset.d4LpTimer || 0);
        if (timer) window.clearTimeout(timer);
        if (el.dataset.d4LongPress === "1" && dragId) {
          // Find element under finger
          const tch = e.changedTouches[0];
          if (tch) {
            const under = document.elementFromPoint(tch.clientX, tch.clientY) as HTMLElement | null;
            const card = under?.closest?.("[data-d4-card-id]") as HTMLElement | null;
            const overId = card?.dataset?.d4CardId;
            if (overId && overId !== dragId) {
              const rect = card.getBoundingClientRect();
              const mid = rect.left + rect.width / 2;
              const place =
                tch.clientX < mid - rect.width * 0.2
                  ? "before"
                  : tch.clientX > mid + rect.width * 0.2
                    ? "after"
                    : "swap";
              onDrop?.(overId, place);
            }
          }
        }
        el.dataset.d4LongPress = "0";
      }}
      data-d4-card-id={dragId || undefined}
      className={cn(
        "overflow-hidden rounded-lg border bg-white text-left shadow-sm transition hover:shadow-md sm:rounded-xl sm:border-2",
        severityBorderClass(sev),
        dragId && "cursor-grab active:cursor-grabbing touch-manipulation",
      )}
      title={dragId ? "Long-press or drag to rearrange" : undefined}
    >
      <div
        className={cn(
          "relative aspect-[4/3] min-h-[6.5rem] sm:min-h-[11rem] lg:min-h-[15rem] xl:min-h-[17rem]",
          isDone
            ? "bg-gradient-to-br from-sky-800 via-slate-800 to-slate-900"
            : "bg-gradient-to-br from-slate-800 to-slate-900",
        )}
      >
        {isDone ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-sky-600/90 via-sky-800/80 to-slate-900 px-2 text-center">
            <CheckCircle2 className="h-8 w-8 text-white drop-shadow sm:h-10 sm:w-10" />
            <p className="rounded-full bg-sky-500/90 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-white shadow sm:text-[11px]">
              {statusLabel || "Submitted"}
            </p>
            <p className="text-[9px] font-semibold text-sky-100/90">Result pending release</p>
          </div>
        ) : feedMode === "both" && (camSrc || scrSrc) ? (
          <div className="flex h-full w-full">
            <div className="relative h-full w-1/2 overflow-hidden border-r border-white/10">
              {camSrc ? (
                <img src={camSrc} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full place-items-center bg-slate-900">
                  <UserRound className="h-5 w-5 text-white/25" />
                </div>
              )}
            </div>
            <div className="relative h-full w-1/2 overflow-hidden bg-black">
              {scrSrc ? (
                <img src={scrSrc} alt="" className="h-full w-full object-contain" />
              ) : (
                <div className="grid h-full place-items-center bg-slate-950">
                  <Monitor className="h-5 w-5 text-white/25" />
                </div>
              )}
            </div>
          </div>
        ) : feedMode === "screen" && scrSrc ? (
          <img src={scrSrc} alt="" className="h-full w-full object-contain bg-black" />
        ) : frameSrc ? (
          <img
            src={frameSrc}
            alt=""
            className={cn(
              "h-full w-full",
              feedMode === "screen" ? "object-contain bg-black" : "object-cover",
            )}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <UserRound className="h-7 w-7 text-white/25 sm:h-10 sm:w-10" />
          </div>
        )}
        <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded-full bg-black/55 px-1 py-0.5 text-[8px] font-bold uppercase text-white sm:left-1.5 sm:top-1.5 sm:gap-1 sm:px-1.5 sm:text-[9px]">
          <span
            className={cn(
              "h-1 w-1 rounded-full sm:h-1.5 sm:w-1.5",
              isDone
                ? "bg-sky-400"
                : streamLive
                  ? "animate-pulse bg-red-500"
                  : isOnline(presence.lastSeenAt)
                    ? "animate-pulse bg-emerald-400"
                    : "bg-slate-400",
            )}
          />
          {isDone ? "Submitted" : streamLive ? "Live" : isOnline(presence.lastSeenAt) ? "Live" : "Off"}
        </span>
        {!isDone && (
          <div className="absolute right-1 top-1 rounded bg-black/55 px-1 py-0.5 sm:right-1.5 sm:top-1.5 sm:px-1.5 sm:py-1">
            <SignalBars bars={bars} />
          </div>
        )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-1.5 pb-1.5 pt-8 sm:px-2 sm:pb-2">
          <div className="mb-1 flex items-center justify-between gap-0.5">
            <FaceChip presence={presence} sev={sev} isDone={isDone} statusLabel={statusLabel} />
            {!isDone && (
              <span className="shrink-0 rounded bg-black/50 px-1 py-0.5 font-mono text-[9px] font-semibold text-white sm:px-1.5 sm:text-[10px]">
                {formatDuration(presence.timeRemainingSec)}
              </span>
            )}
          </div>
          <p className="truncate text-[10px] font-bold leading-tight text-white drop-shadow sm:text-xs lg:text-sm">{name}</p>
          <p className="truncate text-[8px] font-medium leading-tight text-white/85 sm:text-[10px]">{matric}</p>
          <p className="truncate text-[8px] leading-tight text-white/65 sm:text-[9px]">{course}</p>
        </div>
      </div>
    </button>
  );
}

function AlertsPanel({
  alerts,
  readIds,
  studentNameById,
  onOpen,
  onMarkAll,
}: {
  alerts: IntegrityEvent[];
  readIds: Set<string>;
  studentNameById: Map<string, { name: string; matric: string }>;
  onOpen: (studentId: string | null) => void;
  onMarkAll: () => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm sm:rounded-2xl">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <h3 className="text-sm font-extrabold text-slate-900">
          Alerts <span className="text-slate-400">({alerts.length})</span>
        </h3>
        <button type="button" onClick={onMarkAll} className="text-[11px] font-semibold text-primary hover:underline">
          Mark all read
        </button>
      </div>
      <ul className="max-h-[22rem] divide-y divide-slate-50 overflow-y-auto sm:max-h-[28rem]">
        {alerts.length === 0 ? (
          <li className="p-4 text-center text-xs text-slate-500">No recent alerts</li>
        ) : (
          alerts.map((ev) => {
            const who = ev.student_id ? studentNameById.get(ev.student_id) : null;
            const high = ev.severity === "high";
            const med = ev.severity === "medium";
            return (
              <li key={ev.id}>
                <button
                  type="button"
                  onClick={() => onOpen(ev.student_id)}
                  className={cn(
                    "flex w-full gap-2 px-3 py-2 text-left transition hover:bg-slate-50",
                    !readIds.has(ev.id) && "bg-slate-50/50",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full",
                      high ? "bg-red-100 text-red-600" : med ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600",
                    )}
                  >
                    {high ? <ShieldAlert className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold text-slate-900">{who?.name ?? "Student"}</p>
                    <p
                      className={cn(
                        "truncate text-[11px] font-semibold",
                        high ? "text-red-600" : med ? "text-amber-700" : "text-slate-600",
                      )}
                    >
                      {humanEventLabel(ev.event_type, ev.description)}
                    </p>
                    <p className="text-[10px] text-slate-400">{relativeTime(ev.created_at)}</p>
                  </div>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="truncate text-sm font-semibold capitalize text-slate-900">{value}</p>
    </div>
  );
}
