import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  ClipboardList,
  Trophy,
  Bell,
  ChevronRight,
  CalendarDays,
  History,
  User,
  Hash,
  Building2,
  GraduationCap,
} from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatusBadge,
  EmptyState,
  NavCard,
} from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import {
  useStudentContext,
  STUDENT_VISIBLE_EXAM_STATUSES,
  examAvailability,
  isExamAttemptFinished,
  filterExamsForStudent,
} from "@/lib/student";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { withOfflineCache } from "@/lib/offline-query";
import { isOnlineNow } from "@/lib/offline-sync";
import { OfflineKeys } from "@/lib/offline-cache";
import { cn } from "@/lib/utils";
import { processDueExamReminders } from "@/lib/notify";

export const Route = createFileRoute("/student/")({
  head: () => ({ meta: [{ title: "Student Dashboard — D4EXAM" }] }),
  component: Page,
});

type ExamRow = {
  id: string;
  title: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  duration_minutes: number | null;
  course_id?: string | null;
  school_id?: string | null;
  courses: { code: string; name: string; department_id?: string | null; level_id?: string | null } | null;
};

type AttemptRow = { exam_id: string; status: string };

type ResultRow = {
  id: string;
  exam_id: string;
  percentage: number | null;
  grade: string | null;
  pass_fail: string | null;
  status: string;
  released_at: string | null;
  created_at: string | null;
  examinations: { title: string; courses: { code: string } | null } | null;
};

type Notif = { id: string; title: string; created_at: string; read_at: string | null };

function Page() {
  const { data: student, isLoading: sLoading, refetch: refetchStudent, isFetching: sFetching } = useStudentContext();
  const { data: user } = useSessionUser();

  useEffect(() => {
    const sid = student?.schoolId ?? user?.schoolId ?? null;
    if (!sid) return;
    const t = window.setTimeout(() => { void processDueExamReminders(sid); }, 2000);
    return () => window.clearTimeout(t);
  }, [student?.schoolId, user?.schoolId]);
  const navigate = useNavigate();

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, []);

  useRealtimeInvalidate(
    `student-dash-${student?.studentId ?? "anon"}`,
    [
      { table: "examinations" },
      { table: "exam_attempts", filter: student?.studentId ? `student_id=eq.${student.studentId}` : undefined },
      { table: "results", filter: student?.studentId ? `student_id=eq.${student.studentId}` : undefined },
      { table: "notifications", filter: user?.userId ? `recipient_user_id=eq.${user.userId}` : undefined },
    ],
    [
      ["student-dashboard-exams"],
      ["student-dashboard-attempts"],
      ["student-dashboard-results"],
      ["student-dashboard-notifs"],
      ["student-exams"],
      ["student-attempts"],
      ["student-result-ids"],
    ],
    Boolean(student?.studentId),
    1200,
  );

  const examsQ = useQuery({
    queryKey: [
      "student-dashboard-exams",
      student?.schoolId,
      student?.courseIds?.join(","),
      student?.departmentId,
      student?.levelId,
    ],
    enabled: Boolean(student?.schoolId),
    staleTime: 1_500,
    refetchInterval: isOnlineNow() ? 4_000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const uid = user?.userId ?? student?.profileId;
      return withOfflineCache(
        uid,
        OfflineKeys.studentDashboardExams,
        async () => {
          const { data, error } = await supabase
            .from("examinations")
            .select(
              "id, title, status, scheduled_start, scheduled_end, duration_minutes, course_id, school_id, courses(code, name, department_id, level_id)",
            )
            .eq("school_id", student!.schoolId)
            .in("status", [...STUDENT_VISIBLE_EXAM_STATUSES])
            .order("scheduled_start", { ascending: true })
            .limit(150);
          if (error) {
            console.warn("[offline]", error);
            return [] as ExamRow[];
          }
          const rows = (data ?? []) as ExamRow[];
          return filterExamsForStudent(student, rows);
        },
        { schoolId: student?.schoolId, fallback: [] as ExamRow[] },
      );
    },
  });

  const attemptsQ = useQuery({
    queryKey: ["student-dashboard-attempts", student?.studentId],
    enabled: Boolean(student?.studentId),
    staleTime: 1_500,
    refetchInterval: isOnlineNow() ? 5_000 : false,
    refetchOnMount: "always",
    queryFn: async () => {
      const uid = user?.userId ?? student?.profileId;
      return withOfflineCache(
        uid,
        OfflineKeys.studentDashboardAttempts,
        async () => {
          const { data, error } = await supabase
            .from("exam_attempts")
            .select("exam_id, status, ends_at, started_at")
            .eq("student_id", student!.studentId);
          if (error) {
            console.warn("[offline]", error);
            return [] as AttemptRow[];
          }
          return (data ?? []) as AttemptRow[];
        },
        { schoolId: student?.schoolId, fallback: [] as AttemptRow[] },
      );
    },
  });

  const resultsQ = useQuery({
    queryKey: ["student-dashboard-results", student?.studentId],
    enabled: Boolean(student?.studentId),
    staleTime: 2_000,
    refetchInterval: isOnlineNow() ? 10_000 : false,
    refetchOnMount: "always",
    queryFn: async () => {
      const uid = user?.userId ?? student?.profileId;
      return withOfflineCache(
        uid,
        OfflineKeys.studentDashboardResults,
        async () => {
          const { data, error } = await supabase
            .from("results")
            .select(
              "id, exam_id, percentage, grade, pass_fail, status, released_at, created_at, examinations(title, courses(code))",
            )
            .eq("student_id", student!.studentId)
            .order("created_at", { ascending: false })
            .limit(40);
          if (error) {
            console.warn("[offline]", error);
            return [] as ResultRow[];
          }
          return (data ?? []) as ResultRow[];
        },
        { schoolId: student?.schoolId, fallback: [] as ResultRow[] },
      );
    },
  });

  const notifsQ = useQuery({
    queryKey: ["student-dashboard-notifs", user?.userId],
    enabled: Boolean(user?.userId),
    staleTime: 5_000,
    refetchInterval: isOnlineNow() ? 10_000 : false,
    queryFn: async () => {
      return withOfflineCache(
        user!.userId,
        OfflineKeys.studentDashboardNotifs,
        async () => {
          const { data, error } = await supabase
            .from("notifications")
            .select("id, title, created_at, read_at")
            .eq("recipient_user_id", user!.userId)
            .order("created_at", { ascending: false })
            .limit(100);
          if (error) {
            console.warn("[offline]", error);
            return [] as Notif[];
          }
          return (data ?? []) as Notif[];
        },
        { schoolId: student?.schoolId, fallback: [] as Notif[] },
      );
    },
  });

  const attemptsByExam = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of attemptsQ.data ?? []) m.set(a.exam_id, a.status);
    return m;
  }, [attemptsQ.data]);

  const endsAtByExam = useMemo(() => {
    const m = new Map<string, string | null>();
    const examById = new Map((examsQ.data ?? []).map((e) => [e.id, e]));
    for (const a of attemptsQ.data ?? []) {
      const row = a as { exam_id: string; ends_at?: string | null; started_at?: string | null };
      let ea = row.ends_at ?? null;
      if (!ea && row.started_at) {
        const exam = examById.get(row.exam_id);
        const mins = Number(exam?.duration_minutes) || 0;
        if (mins > 0) {
          const startMs = new Date(row.started_at).getTime();
          if (!Number.isNaN(startMs)) {
            ea = new Date(startMs + mins * 60_000).toISOString();
          }
        }
      }
      m.set(row.exam_id, ea);
    }
    return m;
  }, [attemptsQ.data, examsQ.data]);

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const hasLive = [...endsAtByExam.values()].some((ea) => ea);
    if (!hasLive) return;
    const tmr = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(tmr);
  }, [endsAtByExam]);

  function formatLeft(ms: number): string {
    if (ms <= 0) return "00:00:00";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  const finishedByResult = useMemo(() => {
    const s = new Set<string>();
    for (const r of resultsQ.data ?? []) s.add(r.exam_id);
    return s;
  }, [resultsQ.data]);

  const exams = examsQ.data ?? [];
  const results = resultsQ.data ?? [];
  const notifs = notifsQ.data ?? [];

  function isStudentFinished(examId: string): boolean {
    return isExamAttemptFinished(attemptsByExam.get(examId), finishedByResult.has(examId));
  }

  function isWriting(examId: string): boolean {
    return String(attemptsByExam.get(examId) || "").toLowerCase() === "in_progress";
  }

  const written = useMemo(() => {
    const ids = new Set<string>();
    for (const a of attemptsQ.data ?? []) {
      if (isExamAttemptFinished(a.status, finishedByResult.has(a.exam_id))) ids.add(a.exam_id);
    }
    for (const id of finishedByResult) ids.add(id);
    return ids.size;
  }, [attemptsQ.data, finishedByResult]);

  const { availableNow, upcoming } = useMemo(() => {
    void nowTick;
    const continueList: ExamRow[] = [];
    const startList: ExamRow[] = [];
    const up: ExamRow[] = [];
    for (const e of exams) {
      if (isStudentFinished(e.id)) continue;
      if (["completed", "closed", "cancelled"].includes(String(e.status).toLowerCase())) continue;
      // In-progress: only show if time remains (time-up belongs in history/results after auto-submit)
      if (isWriting(e.id)) {
        const ea = endsAtByExam.get(e.id);
        if (ea) {
          const left = new Date(ea).getTime() - nowTick;
          if (left <= 0) continue; // time up — do not show on Ready to start
        }
        continueList.push(e);
        continue;
      }
      const avail = examAvailability(e.status, e.scheduled_start, e.scheduled_end);
      // Window already closed — never show as ready
      if (avail === "missed" || avail === "ended" || avail === "blocked") continue;
      if (avail === "available" || String(e.status).toLowerCase() === "ongoing") startList.push(e);
      else if (avail === "upcoming") up.push(e);
    }
    // Continue (with live countdown) first, then startable exams — never time-up or pure upcoming on this card
    return { availableNow: [...continueList, ...startList], upcoming: up };
  }, [exams, attemptsByExam, finishedByResult, endsAtByExam, nowTick]);

  const readyNow = availableNow;
  // Dashboard card: only exams you can continue or start right now (no upcoming, no time-up)
  const readyList = availableNow;

  const unreadNotifs = notifs.filter((n) => !n.read_at).length;
  const courseCount = student?.courses?.length ?? 0;

  if (sLoading) {
    return <p className="text-sm text-slate-500">Loading dashboard…</p>;
  }

  if (!student) {
    return (
      <>
        <EmptyState
          title="Student profile not found"
          description="Contact School Admin to link your account to a student record. If you just signed in, tap Retry or sign out and sign in again."
        />
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            variant="outline"
            className="font-semibold"
            disabled={sFetching}
            onClick={() => void refetchStudent()}
          >
            {sFetching ? "Loading…" : "Retry"}
          </Button>
        </div>
      </>
    );
  }

  const displayName = (student.fullName || "").trim();

  return (
    <>
      <PageHeader
        title={displayName ? `Welcome, ${displayName}` : "Student dashboard"}
        description="Your examinations, results, courses and notifications."
      />

      <SectionCard title="Student information" className="mb-4 sm:mb-6">
        <div className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <InfoCell icon={User} label="Full name" value={student.fullName || "—"} bold />
          <InfoCell icon={Hash} label="Matric number" value={student.matric || "—"} />
          <InfoCell icon={Building2} label="College / Faculty" value={student.facultyName || "—"} />
          <InfoCell icon={Building2} label="Department" value={student.departmentName || "—"} />
          <InfoCell icon={GraduationCap} label="Level" value={student.levelName || "—"} />
          <InfoCell
            icon={CalendarDays}
            label="Semester"
            value={
              [student.semesterName, student.sessionName].filter(Boolean).join(" · ") || "—"
            }
          />
        </div>
      </SectionCard>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:mb-6 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5">
        <DashCard
          to="/student/examinations"
          label="Ready exams"
          value={readyList.length}
          hint={
            readyNow.length && upcoming.length
              ? `${readyNow.length} live · ${upcoming.length} upcoming`
              : upcoming.length > 0
                ? `${upcoming.length} upcoming`
                : readyNow.length > 0
                  ? `${readyNow.length} live now`
                  : undefined
          }
          icon={ClipboardList}
          color="bg-blue-50 text-primary"
        />
        <DashCard
          to="/student/results"
          label="Results"
          value={results.length}
          icon={Trophy}
          color="bg-amber-50 text-amber-600"
        />
        <DashCard
          to="/student/history"
          label="Exam history"
          value={written}
          icon={History}
          color="bg-violet-50 text-violet-600"
        />
        <DashCard
          to="/student/courses"
          label="Courses"
          value={courseCount}
          icon={BookOpen}
          color="bg-emerald-50 text-emerald-600"
        />
        <DashCard
          to="/student/notifications"
          label="Notifications"
          value={unreadNotifs}
          hint={unreadNotifs ? "unread" : undefined}
          icon={Bell}
          color="bg-rose-50 text-rose-600"
          className="col-span-2 sm:col-span-1"
        />
      </div>

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
        <SectionCard
          title="Ready to start"
          description="Exams for your department and level only"
          action={
            <Button variant="ghost" size="sm" className="font-semibold text-primary" asChild>
              <Link to="/student/examinations">View All</Link>
            </Button>
          }
        >
          {readyList.length === 0 ? (
            <EmptyState
              title="No ready exams"
              description="When officer-approved exams for your department and level are in their time window, they appear here."
            />
          ) : (
            <ul className="space-y-2">
              {readyList.slice(0, 6).map((e) => {
                const avail = examAvailability(e.status, e.scheduled_start, e.scheduled_end);
                const canStart = avail === "available";
                return (
                  <li
                    key={e.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 bg-white px-2.5 py-2.5 sm:px-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {e.courses?.code ? `${e.courses.code} · ` : ""}
                        {e.title}
                      </p>
                      <p className="flex items-center gap-1 text-[11px] text-slate-500 sm:text-xs">
                        <CalendarDays className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {e.scheduled_start
                            ? new Date(e.scheduled_start).toLocaleString()
                            : "Schedule TBC"}
                          {e.duration_minutes ? ` · ${e.duration_minutes} min` : ""}
                        </span>
                      </p>
                    </div>
                    {isWriting(e.id) ? (
                      (() => {
                        const ea = endsAtByExam.get(e.id);
                        const left = ea ? Math.max(0, new Date(ea).getTime() - nowTick) : null;
                        return (
                      <Button
                        size="sm"
                        className="h-8 shrink-0 bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 sm:text-sm"
                        type="button"
                        onClick={() => {
                          void navigate({
                            to: "/student/exam/$id",
                            params: { id: e.id },
                          });
                        }}
                      >
                        {left != null ? formatLeft(left) : "In progress"}
                      </Button>
                        );
                      })()
                    ) : canStart ? (
                      <Button
                        size="sm"
                        className="h-8 shrink-0 bg-primary px-3 text-xs font-bold text-primary-foreground hover:bg-primary/90 sm:text-sm"
                        type="button"
                        onClick={() => {
                          void navigate({
                            to: "/student/exam/$id",
                            params: { id: e.id },
                          });
                        }}
                      >
                        Start
                      </Button>
                    ) : (
                      <StatusBadge status="upcoming" className="shrink-0" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Recent results"
          action={
            <Button variant="ghost" size="sm" className="font-semibold text-primary" asChild>
              <Link to="/student/results">View All</Link>
            </Button>
          }
        >
          {results.length === 0 ? (
            <EmptyState
              title="No results yet"
              description="After you submit an exam, results appear here (scores show when released)."
            />
          ) : (
            <ul className="space-y-2">
              {results.slice(0, 5).map((r) => {
                const isPub =
                  (r.status || "").toLowerCase() === "published" || Boolean(r.released_at);
                return (
                  <li key={r.id}>
                    <NavCard
                      to="/student/results/$id"
                      params={{ id: r.id }}
                      ariaLabel={`Results for ${r.examinations?.title ?? "exam"}`}
                      className="flex items-center justify-between gap-2 rounded-xl border-slate-100 px-2.5 py-2 sm:px-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {r.examinations?.courses?.code
                            ? `${r.examinations.courses.code} · `
                            : ""}
                          {r.examinations?.title ?? "Exam"}
                        </p>
                        <p className="text-[11px] text-slate-500 sm:text-xs">
                          {isPub
                            ? `${r.percentage != null ? `${Math.round(Number(r.percentage))}%` : "—"}${r.grade ? ` · ${r.grade}` : ""}`
                            : "Pending officer release"}
                        </p>
                      </div>
                      <StatusBadge status={isPub ? "Released" : "Held"} />
                    </NavCard>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}

function InfoCell({
  icon: Icon,
  label,
  value,
  bold,
}: {
  icon: typeof User;
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50/60 px-2 py-2 sm:rounded-xl sm:px-3 sm:py-2.5">
      <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400 sm:text-[10px]">
        <Icon className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
        {label}
      </p>
      <p className={cn("mt-0.5 break-words text-xs text-slate-900 sm:text-sm", bold && "font-bold")}>
        {value}
      </p>
    </div>
  );
}

function DashCard({
  to,
  label,
  value,
  hint,
  icon: Icon,
  color,
  className,
}: {
  to: string;
  label: string;
  value: number;
  hint?: string;
  icon: typeof Trophy;
  color: string;
  className?: string;
}) {
  return (
    <NavCard to={to} ariaLabel={label} className={cn("h-full !rounded-xl !p-2.5 sm:!rounded-2xl sm:!p-4", className)}>
      <div className="flex items-center gap-2 sm:gap-3">
        <div
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-lg sm:h-10 sm:w-10 sm:rounded-xl",
            color,
          )}
        >
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-extrabold tabular-nums leading-none text-slate-900 sm:text-2xl">{value}</p>
          <p className="mt-0.5 truncate text-[10px] font-semibold text-slate-500 sm:text-xs">{label}</p>
          {hint ? <p className="truncate text-[10px] text-slate-400">{hint}</p> : null}
        </div>
        <ChevronRight className="hidden h-4 w-4 shrink-0 text-slate-300 sm:block" />
      </div>
    </NavCard>
  );
}
