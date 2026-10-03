import { createFileRoute, Outlet, useChildMatches, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { PageHeader, EmptyState, StatusBadge } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { SchoolResultHeader } from "@/components/brand/SchoolResultHeader";
import { useStudentContext } from "@/lib/student";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { isOnlineNow } from "@/lib/offline-sync";

export const Route = createFileRoute("/student/results")({
  head: () => ({ meta: [{ title: "My Results — D4EXAM" }] }),
  component: Page,
});

type ResultRow = {
  id: string;
  exam_id: string;
  total_score: number | null;
  max_score: number | null;
  percentage: number | null;
  grade: string | null;
  pass_fail: string | null;
  status: string;
  security_review_status?: string | null;
  released_at: string | null;
  created_at: string | null;
  exam_title?: string | null;
  course_code?: string | null;
  course_name?: string | null;
  assessment?: string | null;
};

function Page() {
  const childMatches = useChildMatches();
  if (childMatches.length > 0) {
    return <Outlet />;
  }
  return <ResultsList />;
}

/**
 * Load student results without fragile nested joins.
 * Nested examinations(courses(...)) often fails RLS/embedding and returns empty.
 */
async function fetchStudentResults(studentId: string): Promise<ResultRow[]> {
  // 1) Flat results query — most reliable under RLS
  const base = await supabase
    .from("results")
    .select(
      "id, exam_id, total_score, max_score, percentage, grade, pass_fail, status, security_review_status, released_at, created_at",
    )
    .eq("student_id", studentId)
    .order("created_at", { ascending: false });

  if (base.error) {
    console.warn("[student-results] base query", base.error.message);
  }

  let rows = (base.data ?? []) as ResultRow[];

  // 2) If empty, try without order (some policies choke on order)
  if (!rows.length && base.error) {
    const retry = await supabase
      .from("results")
      .select(
        "id, exam_id, total_score, max_score, percentage, grade, pass_fail, status, security_review_status, released_at, created_at",
      )
      .eq("student_id", studentId);
    if (!retry.error && retry.data?.length) {
      rows = retry.data as ResultRow[];
    }
  }

  if (!rows.length) return [];

  // 3) Enrich exam + course titles (multiple fallbacks — RLS-safe)
  const examIds = [...new Set(rows.map((r) => r.exam_id).filter(Boolean))];
  if (examIds.length) {
    type ExamMeta = {
      id: string;
      title?: string | null;
      course_id?: string | null;
      assessment_type?: string | null;
      assessment_kind?: string | null;
      courses?: { code?: string; name?: string } | null;
    };
    const byId = new Map<string, ExamMeta>();

    const trySelect = async (cols: string) => {
      const { data, error } = await supabase.from("examinations").select(cols).in("id", examIds);
      if (error) {
        console.warn("[student-results] examinations", cols, error.message);
        return;
      }
      for (const e of (data ?? []) as ExamMeta[]) {
        const prev = byId.get(e.id) || { id: e.id };
        byId.set(e.id, {
          ...prev,
          ...e,
          title: e.title || prev.title,
          courses: e.courses || prev.courses,
        });
      }
    };

    await trySelect("id, title, course_id, assessment_type, courses(code, name)");
    if ([...byId.values()].some((e) => !e.title)) {
      await trySelect("id, title, course_id, assessment_type");
    }
    // Course names when embed blocked
    const courseIds = [
      ...new Set(
        [...byId.values()].map((e) => e.course_id).filter(Boolean).map(String),
      ),
    ];
    const courseMap = new Map<string, { code?: string; name?: string }>();
    if (courseIds.length) {
      const { data: courses } = await supabase
        .from("courses")
        .select("id, code, name")
        .in("id", courseIds.slice(0, 200));
      for (const c of courses ?? []) {
        courseMap.set(String((c as { id: string }).id), {
          code: (c as { code?: string }).code,
          name: (c as { name?: string }).name,
        });
      }
    }

    // Extra fallback: exam_attempts → examinations(title) for this student
    const stillMissing = rows
      .map((r) => r.exam_id)
      .filter((id) => {
        const e = byId.get(id);
        return !e?.title || !String(e.title).trim();
      });
    if (stillMissing.length) {
      try {
        const { data: atts } = await supabase
          .from("exam_attempts")
          .select("exam_id, examinations(title, course_id)")
          .eq("student_id", studentId)
          .in("exam_id", stillMissing.slice(0, 100));
        for (const a of atts ?? []) {
          const examId = String((a as { exam_id?: string }).exam_id || "");
          const ex = (a as { examinations?: { title?: string; course_id?: string } | null }).examinations;
          if (!examId || !ex?.title) continue;
          const prev = byId.get(examId) || { id: examId };
          byId.set(examId, {
            ...prev,
            title: String(ex.title).trim() || prev.title,
            course_id: ex.course_id || prev.course_id,
          });
        }
      } catch (e) {
        console.warn("[student-results] attempt title fallback", e);
      }
    }

    rows = rows.map((r) => {
      const e = byId.get(r.exam_id);
      const course =
        e?.courses ||
        (e?.course_id ? courseMap.get(String(e.course_id)) : null) ||
        null;
      const rawTitle = e?.title ? String(e.title).trim() : "";
      const title =
        rawTitle ||
        (course?.code && course?.name
          ? `${course.code} — ${course.name}`
          : null) ||
        (course?.code ? `${course.code} Examination` : null) ||
        null;
      return {
        ...r,
        exam_title: title,
        course_code: course?.code ?? null,
        course_name: course?.name ?? null,
        assessment: e?.assessment_type || e?.assessment_kind || null,
      };
    });
  }

  return rows;
}

function ResultsList() {
  const { data: student, isLoading, isError, error } = useStudentContext();
  const { data: user } = useSessionUser();
  const navigate = useNavigate();

  const resultsQ = useQuery({
    queryKey: ["student-results", student?.studentId],
    enabled: Boolean(student?.studentId),
    staleTime: 5_000,
    refetchInterval: isOnlineNow() ? 20_000 : false,
    retry: 2,
    queryFn: async () => {
      if (!student?.studentId) return [] as ResultRow[];
      return fetchStudentResults(student.studentId);
    },
  });

  useRealtimeInvalidate(
    `student-results-${student?.studentId ?? "x"}`,
    student?.studentId
      ? [{ table: "results", filter: `student_id=eq.${student.studentId}` }]
      : [],
    [["student-results", student?.studentId]],
    Boolean(student?.studentId),
  );

  if (isLoading || (student?.studentId && resultsQ.isLoading)) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading results…
      </div>
    );
  }

  if (!student) {
    return (
      <>
        <PageHeader title="My Results" description="Your examination and test results." />
        <EmptyState
          title="Student profile not linked"
          description={
            isError
              ? (error as Error)?.message || "Could not load your student profile. Contact school admin."
              : "Your account is not linked to a student record yet. Contact your school admin."
          }
        />
      </>
    );
  }

  if (resultsQ.isError) {
    return (
      <>
        <PageHeader title="My Results" description="Your examination and test results." />
        <EmptyState
          title="Could not load results"
          description={(resultsQ.error as Error)?.message || "Please check your connection and try again."}
        />
        <div className="mt-3 flex justify-center">
          <Button type="button" variant="outline" onClick={() => void resultsQ.refetch()}>
            Retry
          </Button>
        </div>
      </>
    );
  }

  const rows = resultsQ.data ?? [];

  return (
    <>
      <PageHeader
        title="My Results"
        description="Results of exams and tests you have written. Held results stay hidden until the examination officer releases them."
      />
      <SchoolResultHeader />
      {rows.length === 0 ? (
        <EmptyState
          title="No results yet"
          description="After you submit an exam or test, your result appears here once it is saved. Scores stay hidden until the officer releases them."
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const st = (r.status || "").toLowerCase().replace(/\s+/g, "_");
            const srs = String(r.security_review_status || "")
              .toLowerCase()
              .replace(/\s+/g, "_");
            const published =
              st === "published" ||
              srs === "accepted" ||
              Boolean(r.released_at);
            const terminated =
              st === "terminated" ||
              srs === "terminated" ||
              srs === "cancelled" ||
              st === "cancelled";
            // Officer review takes priority over generic "held/pending"
            const officerReview =
              !published &&
              !terminated &&
              (srs === "flagged" ||
                srs === "further_review" ||
                srs === "under_review" ||
                srs === "review" ||
                srs === "pending_review" ||
                srs === "security_review" ||
                st === "flagged" ||
                // explicit pending security review on attempt-linked results
                (srs === "pending" && st !== "held"));
            const teacherMark =
              !published &&
              !terminated &&
              !officerReview &&
              (st === "processing" ||
                st === "awaiting_marking" ||
                st === "pending_marking" ||
                srs === "awaiting_marking" ||
                srs === "pending_marking" ||
                (st === "submitted" && !r.released_at && r.percentage == null && r.grade == null));
            const autoSubmitted = st === "auto_submitted" || srs === "auto_submitted";

            let statusLabel: string | null = null;
            let statusMsg = "";
            let msgClass = "text-amber-700";
            if (terminated) {
              statusLabel = "Terminated";
              statusMsg = "This examination was terminated. Scores are not released.";
              msgClass = "text-red-700";
            } else if (published) {
              statusLabel = null;
              statusMsg = "";
            } else if (officerReview) {
              statusLabel = "Under officer review";
              statusMsg =
                "Your result is under officer review. Scores stay hidden until the review is complete.";
              msgClass = "text-amber-800";
            } else if (teacherMark) {
              statusLabel = "Awaiting teacher mark";
              statusMsg =
                "Not yet marked by the teacher. Written/essay parts still need marking before release.";
              msgClass = "text-sky-700";
            } else if (autoSubmitted) {
              statusLabel = "Waiting for release";
              statusMsg =
                "Your paper was auto-submitted. Result is waiting for officer release.";
              msgClass = "text-amber-700";
            } else {
              statusLabel = "Result held";
              statusMsg =
                "Result is held pending officer release. Scores stay hidden until released.";
              msgClass = "text-amber-700";
            }

            const targetId = r.id || r.exam_id;
            const title =
              (r.exam_title && String(r.exam_title).trim()) ||
              (r.course_code ? `${r.course_code} Examination` : null) ||
              "Examination";
            const courseLine = [r.course_code, r.course_name].filter(Boolean).join(" — ");
            const typeLabel =
              r.assessment === "test" || r.assessment === "Test"
                ? "Test"
                : r.assessment === "exam" || r.assessment === "examination"
                  ? "Exam"
                  : r.assessment
                    ? String(r.assessment)
                    : null;
            return (
              <li key={r.id} className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-slate-900">
                      {title}
                      {typeLabel ? (
                        <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          {typeLabel}
                        </span>
                      ) : null}
                    </p>
                    {courseLine ? <p className="text-xs text-slate-500">{courseLine}</p> : null}
                    {published ? (
                      <p className="mt-1 text-sm font-semibold text-slate-800">
                        {r.percentage != null ? `${Math.round(Number(r.percentage))}%` : "—"}
                        {r.total_score != null && r.max_score != null
                          ? ` · ${r.total_score}/${r.max_score}`
                          : r.total_score != null
                            ? ` · Score ${r.total_score}`
                            : ""}
                        {r.grade ? ` · Grade ${r.grade}` : ""}
                        {r.pass_fail ? ` · ${r.pass_fail}` : ""}
                      </p>
                    ) : statusMsg ? (
                      <p className={`mt-1 text-xs font-semibold ${msgClass}`}>{statusMsg}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {statusLabel ? <StatusBadge status={statusLabel} /> : null}
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 px-2.5 text-xs font-semibold"
                      variant={published ? "default" : "outline"}
                      onClick={() => {
                        void navigate({
                          to: "/student/results/$id",
                          params: { id: targetId },
                        });
                      }}
                    >
                      {published ? "View result" : "View status"}{" "}
                      <ChevronRight className="ml-1 h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
