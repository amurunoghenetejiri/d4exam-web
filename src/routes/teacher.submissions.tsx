import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, ChevronRight, Loader2 } from "lucide-react";
import { PageHeader, SectionCard, EmptyState, StatusBadge } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { useTeacherContext } from "@/lib/teacher";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/teacher/submissions")({
  head: () => ({
    meta: [{ title: "Submissions — D4EXAM" }],
  }),
  component: Page,
});

function isEssayType(ty: string): boolean {
  const t = (ty || "").toLowerCase();
  return (
    t.includes("essay") ||
    t.includes("short") ||
    t.includes("theory") ||
    t.includes("descript") ||
    t === "numerical"
  );
}

function Page() {
  const { data: teacher, isLoading } = useTeacherContext();
  const navigate = useNavigate();

  const dataQ = useQuery({
    queryKey: ["teacher-submissions-by-exam", teacher?.schoolId, teacher?.courseIds],
    enabled: Boolean(teacher?.schoolId),
    staleTime: 5_000,
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!teacher?.schoolId) return [] as { examId: string; title: string; total: number; marked: number; pending: number }[];

      let examQ = supabase
        .from("examinations")
        .select("id, title, course_id")
        .eq("school_id", teacher.schoolId)
        .limit(200);
      if (teacher.courseIds?.length) {
        examQ = examQ.in("course_id", teacher.courseIds);
      }
      const { data: exams } = await examQ;
      const examList = exams ?? [];
      if (!examList.length) return [];

      const examIds = examList.map((e) => e.id as string);
      const essayExamIds = new Set<string>();
      try {
        const { data: links } = await supabase
          .from("exam_questions")
          .select("exam_id, question_id")
          .in("exam_id", examIds)
          .limit(4000);
        const qids = [...new Set((links ?? []).map((l) => String(l.question_id)).filter(Boolean))];
        if (qids.length) {
          const { data: qs } = await supabase.from("questions").select("id, question_type").in("id", qids);
          const essayQ = new Set(
            (qs ?? [])
              .filter((q) => isEssayType(String((q as { question_type?: string }).question_type)))
              .map((q) => String((q as { id: string }).id)),
          );
          for (const l of links ?? []) {
            if (essayQ.has(String(l.question_id))) essayExamIds.add(String(l.exam_id));
          }
        }
      } catch {
        /* keep all */
      }

      const targetExamIds = essayExamIds.size ? [...essayExamIds] : examIds;
      if (!targetExamIds.length) return [];

      const { data: attempts } = await supabase
        .from("exam_attempts")
        .select("id, exam_id, status, metadata")
        .eq("school_id", teacher.schoolId)
        .in("exam_id", targetExamIds)
        .in("status", ["submitted", "terminated", "flagged"])
        .limit(3000);

      const byExam = new Map<string, { total: number; marked: number }>();
      for (const a of attempts ?? []) {
        const eid = String(a.exam_id);
        const cur = byExam.get(eid) || { total: 0, marked: 0 };
        cur.total += 1;
        const meta = (a.metadata || {}) as Record<string, unknown>;
        if (meta.essay_marked === true || meta.subjective_marked === true) cur.marked += 1;
        byExam.set(eid, cur);
      }

      const titleMap = new Map(examList.map((e) => [e.id as string, e.title as string]));
      const out: { examId: string; title: string; total: number; marked: number; pending: number }[] = [];
      for (const examId of targetExamIds) {
        const list = byExam.get(examId) || { total: 0, marked: 0 };
        // Only show exams that have at least one submission OR are known essay exams
        if (!list.total && essayExamIds.size && !essayExamIds.has(examId)) continue;
        if (!list.total && !essayExamIds.has(examId)) continue;
        out.push({
          examId,
          title: titleMap.get(examId) || "Examination",
          total: list.total,
          marked: list.marked,
          pending: Math.max(0, list.total - list.marked),
        });
      }
      // Prefer pending first
      out.sort((a, b) => b.pending - a.pending || a.title.localeCompare(b.title));
      return out;
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
      </div>
    );
  }

  if (!teacher) {
    return (
      <>
        <PageHeader title="Submissions" description="Essay / theory scripts awaiting marking" />
        <EmptyState title="Teacher profile not found" description="Your account is not linked as a teacher." />
      </>
    );
  }

  const rows = dataQ.data ?? [];

  return (
    <>
      <PageHeader
        title="Submissions"
        description="Only examinations that need essay or theory marking. Open an exam to mark student scripts."
      />
      <SectionCard
        title="Exams requiring marking"
        className="mt-2"
        action={
          <ClipboardList className="h-4 w-4 text-primary" />
        }
      >
        {dataQ.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : !rows.length ? (
          <EmptyState
            title="Nothing to mark"
            description="When students submit papers with essay questions for your courses, they appear here."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.examId}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-1 py-3.5 text-left transition hover:bg-slate-50"
                  onClick={() =>
                    void navigate({ to: "/teacher/marking", search: { examId: r.examId } })
                  }
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{r.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {r.total} submission{r.total === 1 ? "" : "s"}
                      {r.pending ? ` · ${r.pending} waiting for marking` : " · all marked"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={r.pending ? "Needs marking" : "Marked"} />
                    <ChevronRight className="h-5 w-5 text-slate-400" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void navigate({ to: "/teacher/marking" })}
          >
            Open marking center
          </Button>
        </div>
      </SectionCard>
    </>
  );
}
