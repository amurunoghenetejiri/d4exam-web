import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Send,
  Clock,
  CalendarDays,
  Loader2,
  CheckCircle2,
  ArrowLeft,
} from "lucide-react";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { notifyStudentsExamApproved } from "@/lib/notify";
import { serverNotifyStudentsExamApproved } from "@/lib/notify-student-exam.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/officer/post-to-students")({
  head: () => ({
    meta: [
      { title: "Post to Students — D4EXAM" },
      {
        name: "description",
        content: "Post approved examinations to the student examinations page.",
      },
    ],
  }),
  component: Page,
});

type ExamRow = {
  id: string;
  title: string;
  status: string;
  duration_minutes: number;
  scheduled_start: string | null;
  scheduled_end: string | null;
  course_id: string | null;
  created_at: string;
  courses: { code: string; name: string } | null;
};

function courseCode(item: { courses?: unknown }): string {
  const c = item.courses;
  if (!c) return "—";
  if (Array.isArray(c)) return String((c[0] as { code?: string } | undefined)?.code ?? "—");
  if (typeof c === "object") return String((c as { code?: string }).code ?? "—");
  return "—";
}

function Page() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const qc = useQueryClient();
  const [selected, setSelected] = useState<ExamRow | null>(null);
  const [busy, setBusy] = useState(false);

  const listQ = useQuery({
    queryKey: ["officer-post-students", schoolId],
    enabled: Boolean(schoolId),
    staleTime: 10_000,
    refetchInterval: 25_000,
    queryFn: async () => {
      if (!schoolId) return [] as ExamRow[];
      const full =
        "id, title, status, duration_minutes, scheduled_start, scheduled_end, course_id, created_at, courses(code, name)";
      const basic =
        "id, title, status, duration_minutes, scheduled_start, scheduled_end, course_id, created_at";
      let res = await supabase
        .from("examinations")
        .select(full)
        .eq("school_id", schoolId)
        .in("status", ["approved", "scheduled"])
        .order("created_at", { ascending: false })
        .limit(80);
      if (res.error) {
        res = await supabase
          .from("examinations")
          .select(basic)
          .eq("school_id", schoolId)
          .in("status", ["approved", "scheduled"])
          .order("created_at", { ascending: false })
          .limit(80);
      }
      if (res.error) {
        console.warn("[post-to-students]", res.error);
        return [] as ExamRow[];
      }
      return (Array.isArray(res.data) ? res.data : []) as ExamRow[];
    },
  });

  const queue = listQ.data ?? [];
  const counts = useMemo(
    () => ({
      total: queue.length,
      scheduled: queue.filter((e) => e.status === "scheduled").length,
      approved: queue.filter((e) => e.status === "approved").length,
    }),
    [queue],
  );

  async function postExam(item: ExamRow) {
    if (!schoolId || !user) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("examinations")
        .update({ status: "published" } as never)
        .eq("id", item.id)
        .eq("school_id", schoolId);
      if (error) throw new Error(error.message);

      try {
        await supabase.from("audit_logs").insert({
          school_id: schoolId,
          actor_user_id: user.userId,
          actor_role: "examination_officer",
          action: "exam_posted",
          entity_type: "examination",
          entity_id: item.id,
          description: `${item.title} → published (post to students)`,
        } as never);
      } catch {
        /* non-fatal */
      }

      const payload = {
        schoolId,
        examId: item.id,
        examTitle: item.title,
        courseCode: courseCode(item) !== "—" ? courseCode(item) : undefined,
        start: item.scheduled_start || undefined,
        end: item.scheduled_end || undefined,
        scheduledStart: item.scheduled_start || undefined,
        scheduledEnd: item.scheduled_end || undefined,
      };
      try {
        await serverNotifyStudentsExamApproved({ data: payload });
      } catch {
        try {
          await notifyStudentsExamApproved(payload as never);
        } catch (e) {
          console.warn("[post-to-students] notify", e);
        }
      }

      toast.success("Posted to students — examination is now live");
      setSelected(null);
      await qc.invalidateQueries({ queryKey: ["officer-post-students"] });
      await qc.invalidateQueries({ queryKey: ["officer-approvals"] });
      await listQ.refetch();
    } catch (e) {
      toast.error((e as Error).message || "Could not post examination");
    } finally {
      setBusy(false);
    }
  }

  if (!schoolId) {
    return (
      <EmptyState
        title="No school linked"
        description="Your officer account is not linked to a school."
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Post to Students"
        description="Approved exams waiting to go live on the student examinations page"
        actions={
          <Button variant="outline" size="sm" className="font-semibold" asChild>
            <Link to="/officer/approvals">
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              Approvals
            </Link>
          </Button>
        }
      />

      <div className="mb-5 grid grid-cols-3 gap-2 sm:gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
          <p className="text-[10px] font-semibold text-slate-500 sm:text-xs">Ready to post</p>
          <p className="mt-0.5 text-xl font-extrabold tabular-nums text-slate-900 sm:text-2xl">
            {listQ.isLoading ? "…" : counts.total}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
          <p className="text-[10px] font-semibold text-slate-500 sm:text-xs">Scheduled</p>
          <p className="mt-0.5 text-xl font-extrabold tabular-nums text-slate-900 sm:text-2xl">
            {listQ.isLoading ? "…" : counts.scheduled}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
          <p className="text-[10px] font-semibold text-slate-500 sm:text-xs">Approved</p>
          <p className="mt-0.5 text-xl font-extrabold tabular-nums text-slate-900 sm:text-2xl">
            {listQ.isLoading ? "…" : counts.approved}
          </p>
        </div>
      </div>

      <SectionCard
        title="Queue"
        description="These exams are approved but not yet visible to students"
      >
        {listQ.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : queue.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="Nothing waiting to post"
            description="When you approve an exam and choose Later, it appears here until you post it."
          />
        ) : (
          <ul className="space-y-3">
            {queue.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-extrabold text-slate-900 sm:text-base">
                      {item.title}
                    </p>
                    <StatusBadge status={String(item.status).replaceAll("_", " ")} />
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">{courseCode(item)}</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {item.duration_minutes} min
                    </span>
                    {item.scheduled_start ? (
                      <>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="h-3 w-3" />
                          {new Date(item.scheduled_start).toLocaleString()}
                        </span>
                      </>
                    ) : null}
                  </p>
                </div>
                <Button className="shrink-0 font-semibold" onClick={() => setSelected(item)}>
                  <Send className="mr-1.5 h-4 w-4" />
                  Post to students
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <Dialog open={Boolean(selected)} onOpenChange={(o) => { if (!o && !busy) setSelected(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-extrabold">Confirm post</DialogTitle>
            <DialogDescription>
              Post <span className="font-semibold text-slate-900">{selected?.title}</span> to the
              student examinations page? Students will be notified.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setSelected(null)}>
              Cancel
            </Button>
            <Button
              className="font-semibold"
              disabled={busy || !selected}
              onClick={() => selected && void postExam(selected)}
            >
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              <Send className="mr-1.5 h-4 w-4" />
              Post now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
