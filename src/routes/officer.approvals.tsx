import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState, useRef, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  XCircle,
  MessageSquareWarning,
  Clock,
  FileText,
  CalendarDays,
  Loader2,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Send,
  Undo2,
} from "lucide-react";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { SplitHandle } from "@/components/dashboard/SplitHandle";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import {
  DEFAULT_EXAM_SECURITY,
  fromExamSettingsRow,
  parseSecurityFromDescription,
  securitySummaryLines,
  type ExamSettingsRow,
} from "@/lib/exam-security";
import { parseExamMeta } from "@/lib/exam-meta";
import { notifyStudentsExamApproved } from "@/lib/notify";
import { serverNotifyStudentsExamApproved } from "@/lib/notify-student-exam.functions";
import { namedTeacherExamDecision as notifyTeacherExamDecision } from "@/lib/notify-named";
import { toast } from "sonner";

export const Route = createFileRoute("/officer/approvals")({
  head: () => ({
    meta: [
      { title: "Examination Approvals — D4EXAM" },
      {
        name: "description",
        content: "Review teacher-submitted examinations. Approve, reject or request changes.",
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
  description: string | null;
  course_id: string | null;
  created_by: string | null;
  created_at: string;
  questions_to_answer?: number | null;
  courses: { code: string; name: string } | null;
};

function courseCode(item: { courses?: unknown }): string {
  const c = item.courses;
  if (!c) return "—";
  if (Array.isArray(c)) return String((c[0] as { code?: string } | undefined)?.code ?? "—");
  if (typeof c === "object") return String((c as { code?: string }).code ?? "—");
  return "—";
}
function courseName(item: { courses?: unknown }): string {
  const c = item.courses;
  if (!c) return "Course";
  if (Array.isArray(c)) return String((c[0] as { name?: string } | undefined)?.name ?? "Course");
  if (typeof c === "object") return String((c as { name?: string }).name ?? "Course");
  return "Course";
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function endFromStartLocal(startLocal: string, durationMin: number) {
  if (!startLocal) return "";
  const d = new Date(startLocal);
  if (Number.isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() + Math.max(1, durationMin));
  return toLocalInput(d);
}

function Page() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const qc = useQueryClient();

  const [selected, setSelected] = useState<ExamRow | null>(null);
  const [action, setAction] = useState<"approve" | "reject" | "changes" | null>(null);
  const [comment, setComment] = useState("");
  const [scheduleStart, setScheduleStart] = useState("");
  const [scheduleEnd, setScheduleEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [approvalsLeftPct, setApprovalsLeftPct] = useState(55);
  const approvalsSplitRef = useRef<HTMLDivElement | null>(null);
  const approvalsDragging = useRef(false);
  const onApprovalsSplitDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    approvalsDragging.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);
  const onApprovalsSplitMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!approvalsDragging.current || !approvalsSplitRef.current) return;
    e.preventDefault();
    const rect = approvalsSplitRef.current.getBoundingClientRect();
    if (rect.width < 48) return;
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setApprovalsLeftPct(Math.max(28, Math.min(72, pct)));
  }, []);
  const onApprovalsSplitUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    approvalsDragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);
  /** After approve: ask whether to post to students now */
  const [postPromptExam, setPostPromptExam] = useState<ExamRow | null>(null);
  const [postBusy, setPostBusy] = useState(false);

  const listQ = useQuery({
    queryKey: ["officer-approvals", schoolId],
    enabled: Boolean(schoolId),
    staleTime: 15_000,
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!schoolId) return [] as ExamRow[];
      const full =
        "id, title, status, duration_minutes, scheduled_start, scheduled_end, description, course_id, created_by, created_at, questions_to_answer, courses(code, name)";
      const basic =
        "id, title, status, duration_minutes, scheduled_start, scheduled_end, description, course_id, created_by, created_at, questions_to_answer";
      let res = await supabase
        .from("examinations")
        .select(full)
        .eq("school_id", schoolId)
        .order("updated_at", { ascending: false })
        .limit(100);
      if (res.error) {
        res = await supabase
          .from("examinations")
          .select(basic)
          .eq("school_id", schoolId)
          .order("updated_at", { ascending: false })
          .limit(100);
      }
      if (res.error) {
        console.warn("[officer-approvals] list", res.error);
        return [] as ExamRow[];
      }
      const list = (Array.isArray(res.data) ? res.data : []) as ExamRow[];
      const rank = (s: string) => {
        const x = (s || "").toLowerCase();
        if (x === "pending_approval") return 0;
        if (x === "changes_requested") return 1;
        return 2;
      };
      return [...list].sort((a, b) => rank(String(a.status)) - rank(String(b.status)));
    },
  });

  const exams = listQ.data ?? [];
  const examIds = exams.map((e) => e.id);

  const qCountsQ = useQuery({
    queryKey: ["officer-approval-qcounts", schoolId, exams.map((e) => e.course_id).join(",")],
    enabled: Boolean(schoolId && exams.length),
    staleTime: 20_000,
    queryFn: async () => {
      if (!schoolId) return {} as Record<string, number>;
      const courseIds = [...new Set(exams.map((e) => e.course_id).filter(Boolean))] as string[];
      if (!courseIds.length) return {};
      const { data } = await supabase
        .from("questions")
        .select("course_id")
        .eq("school_id", schoolId)
        .eq("status", "active")
        .in("course_id", courseIds);
      const map: Record<string, number> = {};
      for (const q of data ?? []) {
        const c = (q as { course_id: string }).course_id;
        map[c] = (map[c] ?? 0) + 1;
      }
      return map;
    },
  });
  const qCounts = qCountsQ.data ?? {};

  const settingsQ = useQuery({
    queryKey: ["officer-exam-settings", schoolId, examIds.join(",")],
    enabled: Boolean(schoolId && examIds.length),
    staleTime: 20_000,
    queryFn: async () => {
      try {
        const FULL_COLS =
          "exam_id, fullscreen, tab_monitoring, max_tab_switches, block_copy_paste, randomize_questions, randomize_options, require_camera, require_microphone, require_screen_share, screen_share_mode, face_detection, max_face_warnings, face_violation_action, threshold_action, total_marks, instructions, result_visibility, questions_to_answer";
        const MID_COLS =
          "exam_id, fullscreen, tab_monitoring, max_tab_switches, block_copy_paste, randomize_questions, randomize_options, require_camera, require_microphone, threshold_action, total_marks, instructions, result_visibility";
        const BASIC_COLS =
          "exam_id, fullscreen, tab_monitoring, max_tab_switches, block_copy_paste, randomize_questions, randomize_options, require_camera, require_microphone, threshold_action, total_marks, instructions, result_visibility";

        let data: ExamSettingsRow[] | null = null;
        let error: { message: string } | null = null;
        for (const cols of [FULL_COLS, MID_COLS, BASIC_COLS]) {
          const res = await supabase.from("exam_settings").select(cols).in("exam_id", examIds);
          if (!res.error) {
            data = (res.data ?? []) as unknown as ExamSettingsRow[];
            error = null;
            break;
          }
          error = res.error;
        }
        if (error || !data) {
          console.warn("exam_settings not available:", error?.message);
          return {} as Record<string, ExamSettingsRow>;
        }
        const map: Record<string, ExamSettingsRow> = {};
        for (const row of data) map[row.exam_id] = row;
        return map;
      } catch {
        return {} as Record<string, ExamSettingsRow>;
      }
    },
  });
  const settingsMap = settingsQ.data ?? {};

  function questionsToAnswerFor(item: ExamRow): number | null {
    if (typeof item.questions_to_answer === "number" && item.questions_to_answer > 0) {
      return Math.floor(item.questions_to_answer);
    }
    const fromSettings = settingsMap[item.id]?.questions_to_answer;
    if (typeof fromSettings === "number" && fromSettings > 0) return Math.floor(fromSettings);
    const meta = parseExamMeta(item.description);
    if (meta.questionsToAnswer && meta.questionsToAnswer > 0) return meta.questionsToAnswer;
    const sec = parseSecurityFromDescription(item.description);
    if (sec?.questionsToAnswer && sec.questionsToAnswer > 0) return sec.questionsToAnswer;
    return null;
  }

  const activeQueue = useMemo(
    () => exams.filter((q) => ["pending_approval", "changes_requested"].includes(q.status)),
    [exams],
  );

  const history = useMemo(
    () =>
      exams.filter((q) =>
        ["approved", "scheduled", "published", "rejected", "ongoing", "completed", "closed"].includes(
          q.status,
        ),
      ),
    [exams],
  );

  const stats = useMemo(
    () => ({
      pending: exams.filter((q) => q.status === "pending_approval").length,
      changes: exams.filter((q) => q.status === "changes_requested").length,
      total: activeQueue.length,
    }),
    [exams, activeQueue.length],
  );

  function resolveSecurity(item: ExamRow) {
    const row = settingsMap[item.id];
    if (row) {
      return {
        security: fromExamSettingsRow(row, item.description),
        source: "table" as const,
      };
    }
    const fromDesc = parseSecurityFromDescription(item.description);
    if (fromDesc) return { security: fromDesc, source: "snapshot" as const };
    return { security: DEFAULT_EXAM_SECURITY, source: "default" as const };
  }

  function openAction(item: ExamRow, a: "approve" | "reject" | "changes") {
    setSelected(item);
    setAction(a);
    setComment("");
    const start = item.scheduled_start ? toLocalInput(new Date(item.scheduled_start)) : "";
    setScheduleStart(start);
    const end =
      item.scheduled_end
        ? toLocalInput(new Date(item.scheduled_end))
        : start
          ? endFromStartLocal(start, 4 * 60)
          : "";
    setScheduleEnd(end);
  }

  function onOfficerStartChange(v: string) {
    setScheduleStart(v);
    if (v && selected) {
      setScheduleEnd(endFromStartLocal(v, 4 * 60));
    }
  }

  function closeDialog() {
    setSelected(null);
    setAction(null);
    setComment("");
  }

  async function setExamVisibility(item: ExamRow, mode: "post" | "release") {
    if (!schoolId || !user) return;
    const nextStatus = mode === "post" ? "published" : item.scheduled_start ? "scheduled" : "approved";
    setBusy(true);
    try {
      const { error } = await supabase
        .from("examinations")
        .update({ status: nextStatus } as never)
        .eq("id", item.id)
        .eq("school_id", schoolId);
      if (error) {
        toast.error(error.message || "Could not update exam visibility");
        return;
      }
      try {
        await supabase.from("audit_logs").insert({
          school_id: schoolId,
          actor_user_id: user.userId,
          actor_role: "examination_officer",
          action: mode === "post" ? "exam_posted" : "exam_released",
          entity_type: "examination",
          entity_id: item.id,
          description: `${item.title} → ${nextStatus}`,
        } as never);
      } catch {
        /* ignore */
      }
      toast.success(
        mode === "post"
          ? "Posted to students — exam is now live on student examinations"
          : "Exam released — hidden from students until you post again",
      );
      if (mode === "post" && schoolId) {
        try {
          const payload = {
            schoolId,
            examId: item.id,
            examTitle: item.title,
            courseId: item.course_id,
            courseCode: courseCode(item) !== "—" ? courseCode(item) : undefined,
            courseTitle: courseName(item) !== "Course" ? courseName(item) : undefined,
            start: item.scheduled_start || undefined,
            end: item.scheduled_end || undefined,
            scheduledStart: item.scheduled_start || undefined,
            scheduledEnd: item.scheduled_end || undefined,
            availableNow: true,
          };
          try {
            await serverNotifyStudentsExamApproved({ data: payload });
          } catch (se) {
            console.warn("[officer.approvals] server student notify failed, client fallback", se);
            try { await notifyStudentsExamApproved(payload); } catch (ce) { console.warn(ce); }
          }
        } catch (e) { console.warn("[officer.approvals] notify students on post failed:", e); }
      }
      await qc.invalidateQueries({ queryKey: ["officer-approvals"] });
      await qc.invalidateQueries({ queryKey: ["student-exams"] });
      await qc.invalidateQueries({ queryKey: ["student-dashboard-exams"] });
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not update examination");
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction() {
    if (!selected || !action || !schoolId || !user) return;

    if (action === "reject" && !comment.trim()) {
      toast.error("Add a reason when rejecting an examination.");
      return;
    }
    if (action === "changes" && !comment.trim()) {
      toast.error("Describe the changes the teacher must make.");
      return;
    }

    let endLocal = scheduleEnd;
    if (action === "approve" && scheduleStart) {
      if (!endLocal) endLocal = endFromStartLocal(scheduleStart, 4 * 60);
      if (new Date(endLocal) <= new Date(scheduleStart)) {
        toast.error("End time must be after start time.");
        return;
      }
    }

    setBusy(true);
    try {
      let nextStatus = "approved";
      if (action === "reject") nextStatus = "rejected";
      if (action === "changes") nextStatus = "changes_requested";
      if (action === "approve" && scheduleStart) nextStatus = "scheduled";

      const update: Record<string, unknown> = { status: nextStatus };
      if (action === "approve") {
        if (scheduleStart) update.scheduled_start = new Date(scheduleStart).toISOString();
        if (endLocal) update.scheduled_end = new Date(endLocal).toISOString();
      }
      if (comment.trim()) {
        const prefix =
          action === "approve"
            ? "[Officer note]"
            : action === "reject"
              ? "[Rejected]"
              : "[Changes requested]";
        const base = (selected.description || "").replace(
          /\n?\[(Officer note|Rejected|Changes requested)\][\s\S]*$/,
          "",
        );
        update.description = `${base}\n${prefix} ${comment.trim()}`.trim();
      }

      const { error } = await supabase
        .from("examinations")
        .update(update as never)
        .eq("id", selected.id)
        .eq("school_id", schoolId);
      if (error) {
        console.warn("[officer.approvals] update exam", error);
        toast.error(error.message || "Could not update examination. Try again.");
        return;
      }

      {
        const { error: auditErr } = await supabase.from("audit_logs").insert({
          school_id: schoolId,
          actor_user_id: user.userId,
          actor_role: "examination_officer",
          action: `exam_${action}`,
          entity_type: "examination",
          entity_id: selected.id,
          description: `${selected.title} → ${nextStatus}${comment.trim() ? `: ${comment.trim()}` : ""}`,
        } as never);
        if (auditErr) console.warn("[officer.approvals] audit_logs insert skipped:", auditErr.message);
      }

      if (selected.created_by) {
        const when =
          action === "approve" && scheduleStart
            ? `Starts ${new Date(scheduleStart).toLocaleString()}.`
            : undefined;
        const decision =
          action === "approve"
            ? "approved"
            : action === "reject"
              ? "rejected"
              : "revision_requested";
        try {
          await notifyTeacherExamDecision({
            teacherUserId: selected.created_by,
            schoolId,
            examId: selected.id,
            examTitle: selected.title,
            decision,
            scheduleNote: when,
            note: comment.trim() || undefined,
            courseCode: courseCode(selected) !== "—" ? courseCode(selected) : undefined,
            courseTitle: courseName(selected) !== "Course" ? courseName(selected) : undefined,
            start: scheduleStart || selected.scheduled_start || undefined,
            end: endLocal || selected.scheduled_end || undefined,
          });
        } catch (e) {
          console.warn("[officer.approvals] notify teacher failed:", e);
        }
      }

      

      const wasApprove = action === "approve";
      const approvedSnapshot: ExamRow = {
        ...selected,
        status: nextStatus,
        scheduled_start: scheduleStart
          ? new Date(scheduleStart).toISOString()
          : selected.scheduled_start,
        scheduled_end: endLocal
          ? new Date(endLocal).toISOString()
          : selected.scheduled_end,
      };
      toast.success(
        wasApprove
          ? scheduleStart
            ? `Approved — starts ${new Date(scheduleStart).toLocaleString()}`
            : "Examination approved"
          : action === "reject"
            ? "Examination rejected"
            : "Changes requested from teacher",
      );
      closeDialog();
      await qc.invalidateQueries({ queryKey: ["officer-approvals"] });
      await listQ.refetch();
      if (wasApprove) {
        setPostPromptExam(approvedSnapshot);
      }
    } catch (err) {
      toast.error((err as Error).message || "Could not update examination");
    } finally {
      setBusy(false);
    }
  }


  async function confirmPostToStudents(postNow: boolean) {
    const item = postPromptExam;
    if (!item || !schoolId || !user) {
      setPostPromptExam(null);
      return;
    }
    if (!postNow) {
      setPostPromptExam(null);
      toast.message("Saved for later — open Post to Students when you are ready.");
      return;
    }
    setPostBusy(true);
    try {
      await setExamVisibility(item, "post");
      setPostPromptExam(null);
      await qc.invalidateQueries({ queryKey: ["officer-approvals"] });
      await qc.invalidateQueries({ queryKey: ["officer-post-students"] });
      await listQ.refetch();
    } catch (e) {
      toast.error((e as Error).message || "Could not post examination");
    } finally {
      setPostBusy(false);
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
        title="Examination Approvals"
        description={`${user?.fullName ?? "Officer"} · Review schedule, questions to answer, and security before approving`}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-3">
        <Stat label="Pending approval" value={stats.pending} icon={Clock} tone="warning" />
        <Stat label="Changes requested" value={stats.changes} icon={MessageSquareWarning} tone="info" />
        <Stat label="In queue" value={stats.total} icon={FileText} tone="primary" />
      </div>

      <div
        ref={approvalsSplitRef}
        className="flex flex-row gap-0"
        style={{ height: "min(36rem, 62vh)" }}
      >
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          style={{ width: `${approvalsLeftPct}%` }}
        >
        <SectionCard
          title="Awaiting your decision"
          description={listQ.isFetching ? "Refreshing…" : "Teachers submit → you approve → Post to students (makes exam live)"}
          className="flex h-full min-h-0 flex-col overflow-hidden"
          bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {listQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading examinations…</p>
          ) : listQ.isError ? (
            <EmptyState
              title="Could not load examinations"
              description={(listQ.error as Error)?.message || "Refresh the page or try again shortly."}
            />
          ) : activeQueue.length === 0 ? (
            <EmptyState
              title="No examinations awaiting approval"
              description="When a teacher submits an exam, it appears here."
            />
          ) : (
            <ul className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
              {activeQueue.map((item) => {
                const bank = item.course_id ? qCounts[item.course_id] ?? 0 : 0;
                const toAnswer = questionsToAnswerFor(item);
                const { security } = resolveSecurity(item);
                const open = expandedId === item.id;
                return (
                  <li
                    key={item.id}
                    className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-bold text-slate-900">{item.title}</p>
                          <p className="text-xs text-slate-500">
                            {courseCode(item)} · {item.duration_minutes} min
                            {toAnswer != null ? ` · Answer ${toAnswer}` : ""}
                          </p>
                        </div>
                        <StatusBadge status={String(item.status).split("_").join(" ")} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" className="font-semibold" onClick={() => openAction(item, "approve")}>
                          <CheckCircle2 className="mr-1.5 h-4 w-4" />
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" className="font-semibold" onClick={() => openAction(item, "changes")}>
                          <MessageSquareWarning className="mr-1.5 h-4 w-4" />
                          Request changes
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="font-semibold text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => openAction(item, "reject")}
                        >
                          <XCircle className="mr-1.5 h-4 w-4" />
                          Reject
                        </Button>
                      </div>
                      <button
                        type="button"
                        className="mt-2 text-xs font-semibold text-primary"
                        onClick={() => setExpandedId(open ? null : item.id)}
                      >
                        {open ? "Hide details" : "View full details & security"}
                      </button>
                      {open && (
                        <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 text-xs text-slate-700">
                          <ul className="space-y-1">
                            {securitySummaryLines(security).map((line) => (
                              <li key={line}>• {line}</li>
                            ))}
                          </ul>
                          <Button size="sm" variant="secondary" className="font-semibold" asChild>
                            <Link to="/officer/exam-preview/$id" params={{ id: item.id }}>
                              Preview as student
                            </Link>
                          </Button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
        </div>

        <SplitHandle
          onPointerDown={onApprovalsSplitDown}
          onPointerMove={onApprovalsSplitMove}
          onPointerUp={onApprovalsSplitUp}
        />

        <div
          className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
          style={{ width: `${100 - approvalsLeftPct}%` }}
        >
        <SectionCard
          title="Recent decisions"
          className="flex h-full min-h-0 flex-col overflow-hidden"
          bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
          description="After you approve, click Post to students so the exam appears live for eligible students. Release hides it again."
        >
          {history.length === 0 ? (
            <EmptyState title="No decisions yet" description="Processed examinations will show here." />
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 space-y-3">
              {history.slice(0, 20).map((item) => {
                const st = String(item.status).toLowerCase();
                const canPost = ["approved", "scheduled"].includes(st);
                const canRelease = st === "published";
                return (
                  <li key={item.id} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
                        <p className="text-xs text-slate-500">
                          {courseCode(item)}
                          {item.scheduled_start
                            ? ` · Starts ${new Date(item.scheduled_start).toLocaleString()}`
                            : ""}
                        </p>
                      </div>
                      <StatusBadge status={String(item.status).split("_").join(" ")} />
                    </div>
                    {(canPost || canRelease) && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {canPost && (
                          <Button
                            size="sm"
                            className="h-8 font-semibold"
                            disabled={busy}
                            onClick={() => void setExamVisibility(item, "post")}
                          >
                            <Send className="mr-1.5 h-3.5 w-3.5" />
                            Post to students
                          </Button>
                        )}
                        {canRelease && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 font-semibold"
                            disabled={busy}
                            onClick={() => void setExamVisibility(item, "release")}
                          >
                            <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                            Release (unpost)
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
        </div>
      </div>

      <Dialog open={Boolean(action && selected)} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {action === "approve" && "Approve examination"}
              {action === "reject" && "Reject examination"}
              {action === "changes" && "Request changes"}
            </DialogTitle>
            <DialogDescription>
              {selected?.title} · {selected ? courseCode(selected) : "—"} · {selected?.duration_minutes} min
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {action === "approve" && (
              <>
                <div className="space-y-2">
                  <Label className="font-semibold">Start</Label>
                  <Input
                    type="datetime-local"
                    value={scheduleStart}
                    onChange={(e) => onOfficerStartChange(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="font-semibold">End</Label>
                  <Input
                    type="datetime-local"
                    value={scheduleEnd}
                    onChange={(e) => setScheduleEnd(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="space-y-2">
              <Label className="font-semibold">
                {action === "approve" ? "Note (optional)" : "Comment (required)"}
              </Label>
              <Textarea
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={
                  action === "approve"
                    ? "Optional note for the teacher…"
                    : action === "reject"
                      ? "Reason for rejection…"
                      : "What should the teacher change?"
                }
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button
              className="font-semibold"
              variant={action === "reject" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void confirmAction()}
            >
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {action === "approve" && "Confirm approval"}
              {action === "reject" && "Confirm rejection"}
              {action === "changes" && "Send to teacher"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(postPromptExam)} onOpenChange={(o) => { if (!o && !postBusy) setPostPromptExam(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-extrabold">Post to students?</DialogTitle>
            <DialogDescription className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900">{postPromptExam?.title}</span> is approved.
              Posting makes it visible on the student examinations page and sends a notification.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
            Choose <span className="font-semibold text-slate-800">Post now</span> to go live, or{" "}
            <span className="font-semibold text-slate-800">Later</span> to keep it on the Post to Students queue.
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={postBusy}
              onClick={() => void confirmPostToStudents(false)}
            >
              Later
            </Button>
            <Button
              className="font-semibold"
              disabled={postBusy}
              onClick={() => void confirmPostToStudents(true)}
            >
              {postBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              <Send className="mr-1.5 h-4 w-4" />
              Post now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof Clock;
  tone: "warning" | "info" | "primary";
}) {
  const tones = {
    warning: "bg-amber-50 text-amber-600",
    info: "bg-sky-50 text-sky-600",
    primary: "bg-blue-50 text-primary",
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-extrabold text-slate-900">{value}</p>
        </div>
        <span className={`grid h-9 w-9 place-items-center rounded-xl ${tones[tone]}`}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
    </div>
  );
}
