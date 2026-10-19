import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, CalendarDays } from "lucide-react";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import {
  useStudentContext,
  STUDENT_VISIBLE_EXAM_STATUSES,
  examAvailability,
  formatExamWindow,
  isExamAttemptFinished,
  filterExamsForStudent,
} from "@/lib/student";
import { supabase } from "@/integrations/supabase/client";
import { processDueExamReminders } from "@/lib/notify";
import { assertOnline } from "@/lib/require-online";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { useSessionUser } from "@/lib/session";
import { withOfflineCache } from "@/lib/offline-query";
import { OfflineKeys } from "@/lib/offline-cache";
import { isOnlineNow } from "@/lib/offline-sync";

export const Route = createFileRoute("/student/examinations")({
  head: () => ({
    meta: [
      { title: "My Examinations — D4EXAM" },
      {
        name: "description",
        content: "Only examinations approved by the Examination Officer appear here.",
      },
    ],
  }),
  component: Page,
});

type ExamRow = {
  id: string;
  title: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  duration_minutes: number;
  course_id: string | null;
  school_id?: string | null;
  courses: { code: string; name: string; department_id?: string | null; level_id?: string | null } | null;
};

type AttemptRow = {
  exam_id: string;
  status: string;
  submitted_at: string | null;
  ends_at?: string | null;
  started_at?: string | null;
};

const DONE_ATTEMPT_STATUSES = ["submitted", "terminated", "flagged"];

function formatCountdown(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

function useCountdown(targetIso: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!targetIso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [targetIso]);
  if (!targetIso) return { remainingMs: null as number | null, ready: false };
  const target = new Date(targetIso).getTime();
  if (Number.isNaN(target)) return { remainingMs: null, ready: false };
  const remainingMs = Math.max(0, target - now);
  return { remainingMs, ready: remainingMs <= 0 };
}

function StartExamButton({ examId, continueMode, remainingMs, hasResult }: { examId: string; continueMode?: boolean; remainingMs?: number | null; hasResult?: boolean }) {
  const navigate = useNavigate();
  const timeUp = Boolean(continueMode && remainingMs != null && remainingMs <= 0);
  // Time-up attempts are auto-submitted — send user to finalize/result, not a red "Time up" CTA
  if (timeUp) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-9 w-full px-4 text-sm font-bold sm:h-8 sm:w-auto"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (hasResult) {
            void navigate({ to: "/student/results/$id", params: { id: examId } });
          } else {
            void navigate({ to: "/student/exam/$id", params: { id: examId } });
          }
        }}
      >
        {hasResult ? "View result" : "Open submission"}
      </Button>
    );
  }
  const label = continueMode
    ? (remainingMs != null && remainingMs > 0
          ? formatCountdown(remainingMs)
          : "In progress")
    : "Start exam";
  return (
    <Button
      type="button"
      size="sm"
      className={
        continueMode
            ? "h-9 w-full bg-emerald-600 px-4 text-sm font-bold text-white hover:bg-emerald-700 sm:h-8 sm:w-auto"
            : "h-9 w-full bg-primary px-4 text-sm font-bold text-primary-foreground hover:bg-primary/90 sm:h-8 sm:w-auto"
      }
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof navigator !== "undefined" && navigator.onLine === false /* hard offline only */) {
          window.alert("Connect to the internet to write this exam.");
          return;
        }
        void navigate({ to: "/student/exam/$id", params: { id: examId } });
      }}
    >
      {label}
    </Button>
  );
}

function StartOrCountdownButton({
  examId,
  scheduledStart,
  canStartNow,
  continueMode,
  endsAt,
}: {
  examId: string;
  scheduledStart: string | null;
  canStartNow: boolean;
  continueMode?: boolean;
  endsAt?: string | null;
}) {
  const { remainingMs, ready } = useCountdown(scheduledStart);
  const { remainingMs: attemptLeft } = useCountdown(endsAt ?? null);

  if (continueMode) {
    return <StartExamButton examId={examId} continueMode remainingMs={attemptLeft} />;
  }

  if (canStartNow || ready) {
    return <StartExamButton examId={examId} />;
  }

  if (remainingMs == null) {
    return (
      <Button size="sm" variant="outline" className="h-9 w-full font-semibold sm:h-8 sm:w-auto" disabled>
        Schedule TBC
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      disabled
      className={cn(
        "h-9 w-full font-mono text-[11px] font-bold tabular-nums sm:h-8 sm:w-auto sm:min-w-[9.5rem] sm:text-xs",
        remainingMs < 5 * 60_000 && "border-amber-300 text-amber-800",
        remainingMs < 60_000 && "border-red-300 text-red-700",
      )}
    >
      <Clock className="mr-1.5 h-3.5 w-3.5 shrink-0" />
      Starts in {formatCountdown(remainingMs)}
    </Button>
  );
}

function Page() {
  const { data: student, isLoading: sLoading } = useStudentContext();
  const { data: user } = useSessionUser();
  const schoolId = student?.schoolId ?? null;
  const uid = user?.userId ?? student?.profileId;

  useEffect(() => {
    if (!schoolId) return;
    const t = window.setTimeout(() => { void processDueExamReminders(schoolId); }, 2500);
    return () => window.clearTimeout(t);
  }, [schoolId]);

  useRealtimeInvalidate(
    `student-exams-sync-${student?.studentId ?? "x"}`,
    student?.studentId
      ? [
          { table: "exam_attempts", filter: `student_id=eq.${student.studentId}` },
          { table: "results", filter: `student_id=eq.${student.studentId}` },
          { table: "examinations" },
        ]
      : [],
    [
      ["student-exams"],
      ["student-attempts", student?.studentId],
      ["student-result-ids", student?.studentId],
      ["student-dashboard-exams"],
      ["student-dashboard-attempts"],
    ],
    Boolean(student?.studentId),
    1500,
  );

  const examsQ = useQuery({
    queryKey: ["student-exams", schoolId, student?.courseIds?.join(","), student?.departmentId, student?.levelId],
    enabled: Boolean(schoolId && student?.studentId),
    staleTime: 1_500,
    refetchInterval: isOnlineNow() ? 4_000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!schoolId || !student) return [] as ExamRow[];
      return withOfflineCache(
        uid,
        OfflineKeys.studentExams,
        async () => {
          const { data, error } = await supabase
            .from("examinations")
            .select(
              "id, title, status, scheduled_start, scheduled_end, duration_minutes, course_id, school_id, courses(code, name, department_id, level_id)",
            )
            .eq("school_id", schoolId)
            .in("status", [...STUDENT_VISIBLE_EXAM_STATUSES])
            .order("scheduled_start", { ascending: true, nullsFirst: false })
            .limit(150);
          if (error) {
            console.warn("[student-exams]", error);
            return [] as ExamRow[];
          }
          const rows = (data ?? []) as ExamRow[];
          return filterExamsForStudent(student, rows);
        },
        { schoolId, fallback: [] as ExamRow[] },
      );
    },
  });

  const attemptsQ = useQuery({
    queryKey: ["student-attempts", student?.studentId],
    enabled: Boolean(student?.studentId),
    staleTime: 5_000,
    refetchInterval: isOnlineNow() ? 8_000 : false,
    refetchOnMount: "always",
    queryFn: async () => {
      if (!student?.studentId) return [] as AttemptRow[];
      return withOfflineCache(
        uid,
        OfflineKeys.studentExamAttempts,
        async () => {
          const { data, error } = await supabase
            .from("exam_attempts")
            .select("exam_id, status, submitted_at, ends_at, started_at")
            .eq("student_id", student.studentId);
          if (error) {
            console.warn("[offline]", error);
            return [] as AttemptRow[];
          }
          return (data ?? []) as AttemptRow[];
        },
        { schoolId: student.schoolId, fallback: [] as AttemptRow[] },
      );
    },
  });

  const resultsQ = useQuery({
    queryKey: ["student-result-ids", student?.studentId],
    enabled: Boolean(student?.studentId),
    staleTime: 5_000,
    refetchInterval: isOnlineNow() ? 15_000 : false,
    refetchOnMount: "always",
    queryFn: async () => {
      if (!student?.studentId) return {} as Record<string, string>;
      return withOfflineCache(
        uid,
        `${OfflineKeys.studentResults}::ids`,
        async () => {
          let q = supabase
            .from("results")
            .select("id, exam_id")
            .eq("student_id", student.studentId);
          if (student.schoolId) q = q.eq("school_id", student.schoolId);
          const { data, error } = await q;
          if (error) {
            console.warn("[offline]", error);
            return {} as Record<string, string>;
          }
          const map: Record<string, string> = {};
          for (const r of data ?? []) {
            map[(r as { exam_id: string }).exam_id] = (r as { id: string }).id;
          }
          return map;
        },
        { schoolId: student.schoolId, fallback: {} as Record<string, string> },
      );
    },
  });
  const resultIdByExam = resultsQ.data ?? {};

  const attemptByExam = useMemo(() => {
    const map = new Map<string, AttemptRow>();
    for (const a of attemptsQ.data ?? []) map.set(a.exam_id, a);
    return map;
  }, [attemptsQ.data]);

  const exams = examsQ.data ?? [];

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const { live, upcoming, done } = useMemo(() => {
    void tick;
    const liveList: ExamRow[] = [];
    const upList: ExamRow[] = [];
    const doneList: ExamRow[] = [];

    for (const e of exams) {
      const attempt = attemptByExam.get(e.id);
      const hasResult = Boolean(resultIdByExam[e.id]);
      const studentFinished = isExamAttemptFinished(attempt?.status, hasResult);

      if (studentFinished || ["completed", "closed", "cancelled"].includes(String(e.status).toLowerCase())) {
        doneList.push(e);
        continue;
      }

      if (String(attempt?.status || "").toLowerCase() === "in_progress") {
        liveList.push(e);
        continue;
      }

      const avail = examAvailability(e.status, e.scheduled_start, e.scheduled_end);
      if (avail === "available" || String(e.status).toLowerCase() === "ongoing") {
        liveList.push(e);
      } else if (avail === "missed" || avail === "ended") {
        doneList.push(e);
      } else if (avail === "upcoming") {
        upList.push(e);
      } else {
        doneList.push(e);
      }
    }

    return { live: liveList, upcoming: upList, done: doneList };
  }, [exams, attemptByExam, resultIdByExam, tick]);

  if (sLoading) return <p className="text-sm text-slate-500">Loading…</p>;

  if (!student) {
    return (
      <EmptyState
        title="Student profile not found"
        description="Contact School Admin to link your account."
      />
    );
  }

  const termLine = [student.sessionName, student.semesterName].filter(Boolean).join(" · ");

  return (
    <>
      <PageHeader
        title="My Examinations"
        description={
          termLine
            ? `${termLine} · Only officer-approved exams for your department and level appear here.`
            : "You only see exams for your department and level after the Examination Officer has approved them."
        }
      />

      {examsQ.isLoading ? (
        <p className="text-sm text-slate-500">Loading examinations…</p>
      ) : exams.length === 0 ? (
        <EmptyState
          title="No examinations available"
          description="When your lecturers submit exams for your courses (or department and level) and the officer approves them, they will appear here."
        />
      ) : (
        <div className="space-y-4 sm:space-y-6">
          <SectionCard title="Available now">
            {live.length === 0 ? (
              <p className="text-sm text-slate-500">No exams available to start right now.</p>
            ) : (
              <ExamList
                items={live}
                canStart
                attemptByExam={attemptByExam}
                resultIdByExam={resultIdByExam}
                sessionName={student.sessionName}
                semesterName={student.semesterName}
              />
            )}
          </SectionCard>
          <SectionCard title="Upcoming">
            {upcoming.length === 0 ? (
              <p className="text-sm text-slate-500">No upcoming examinations.</p>
            ) : (
              <ExamList
                items={upcoming}
                attemptByExam={attemptByExam}
                resultIdByExam={resultIdByExam}
                sessionName={student.sessionName}
                semesterName={student.semesterName}
                showCountdown
              />
            )}
          </SectionCard>
          <SectionCard title="Completed / missed">
            {done.length === 0 ? (
              <p className="text-sm text-slate-500">No completed examinations yet.</p>
            ) : (
              <ExamList
                items={done}
                attemptByExam={attemptByExam}
                resultIdByExam={resultIdByExam}
                completed
                sessionName={student.sessionName}
                semesterName={student.semesterName}
              />
            )}
          </SectionCard>
        </div>
      )}
    </>
  );
}

function ExamList({
  items,
  canStart,
  completed,
  showCountdown,
  attemptByExam,
  resultIdByExam,
  sessionName,
  semesterName,
}: {
  items: ExamRow[];
  canStart?: boolean;
  completed?: boolean;
  showCountdown?: boolean;
  attemptByExam: Map<string, AttemptRow>;
  resultIdByExam: Record<string, string>;
  sessionName?: string | null;
  semesterName?: string | null;
}) {
  const navigate = useNavigate();
  return (
    <ul className="space-y-3">
      {items.map((e) => {
        const attempt = attemptByExam.get(e.id);
        const resultId = resultIdByExam[e.id];
        const studentFinished = isExamAttemptFinished(attempt?.status, Boolean(resultId));
        const avail = examAvailability(e.status, e.scheduled_start, e.scheduled_end);
        const badge = studentFinished
          ? attempt?.status === "terminated"
            ? "terminated"
            : attempt?.status === "flagged"
              ? "flagged"
              : "completed"
          : avail === "missed" || avail === "ended"
            ? "missed"
            : String(e.status).replaceAll("_", " ");

        const windowText =
          e.scheduled_start || e.scheduled_end
            ? formatExamWindow(e.scheduled_start, e.scheduled_end)
            : "Schedule TBC";
        const term =
          [sessionName, semesterName].filter(Boolean).join(" · ") || null;

        return (
          <li
            key={e.id}
            className="rounded-2xl border border-slate-100 bg-white p-3.5 shadow-sm sm:p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-base font-bold leading-snug text-slate-900">{e.title}</p>
                <p className="mt-1 text-xs font-medium text-slate-600 sm:text-sm">
                  <span className="font-semibold text-primary">{e.courses?.code ?? "—"}</span>
                  {e.courses?.name ? ` · ${e.courses.name}` : ""}
                </p>
              </div>
              <StatusBadge status={badge} className="shrink-0" />
            </div>

            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <span className="inline-flex items-center rounded-md bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-100">
                {e.duration_minutes} min
              </span>
              {term ? (
                <span className="inline-flex items-center rounded-md bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-100">
                  {term}
                </span>
              ) : null}
            </div>

            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500 sm:text-xs">
              <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span>{windowText}</span>
            </p>
            {attempt?.submitted_at ? (
              <p className="mt-1 text-[11px] font-medium text-emerald-700 sm:text-xs">
                Submitted {new Date(attempt.submitted_at).toLocaleString()}
              </p>
            ) : null}

            <div className="mt-3 flex flex-col gap-2 border-t border-slate-50 pt-3 sm:flex-row sm:items-center sm:justify-end">
              {canStart && !studentFinished && (
                <StartOrCountdownButton
                  examId={e.id}
                  scheduledStart={e.scheduled_start}
                  canStartNow
                  continueMode={String(attempt?.status || "").toLowerCase() === "in_progress"}
                  endsAt={attempt?.ends_at ?? null}
                />
              )}
              {showCountdown && !studentFinished && (
                <StartOrCountdownButton
                  examId={e.id}
                  scheduledStart={e.scheduled_start}
                  canStartNow={false}
                />
              )}
              {completed && studentFinished && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 w-full font-semibold sm:h-8 sm:w-auto"
                  type="button"
                  onClick={() => {
                    void navigate({
                      to: "/student/results/$id",
                      params: { id: resultId || e.id },
                    });
                  }}
                >
                  View result
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
