import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Clock, Loader2, UserRound } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { friendlyError } from "@/lib/friendly-error";
import {
  
  notifyStudentsResultsHeld,
  notifyStudentsExamRescheduled,
  notifyStudentsRewriteAllowed,
  notifyStudentResultTerminated,
} from "@/lib/notify";
import { namedStudentsResultsReleased } from "@/lib/notify-named";
import { cn } from "@/lib/utils";
import { resolveStudentDetails } from "@/lib/resolve-student-details";
import { resolveStudentNamesForOfficer } from "@/lib/officer-student-names.functions";
import { humanEventLabel, relativeTime } from "@/lib/live-monitor";

type ExamRow = {
  id: string; title: string; status: string; course_id: string | null;
  scheduled_start: string | null; scheduled_end: string | null; duration_minutes: number | null;
  courses: { code: string; name: string } | null;
};
type ResultRow = {
  id: string; exam_id: string; student_id: string; attempt_id: string | null;
  total_score: number | null; max_score: number | null; percentage: number | null;
  grade: string | null; pass_fail: string | null; correct_count: number | null;
  wrong_count: number | null; unanswered_count: number | null; status: string;
  security_review_status: string | null; released_at: string | null; created_at: string | null;
  students: {
    full_name?: string | null;
    matric_number: string | null;
    student_id: string | null;
    profiles: { full_name: string | null } | null;
  } | null;
};
type IntegrityEvent = { id: string; event_type: string; severity: string | null; description: string | null; created_at: string };

function resultReasonLabel(status: string, security: string | null, releasedAt: string | null): { label: string; className: string } {
  const s = (status || "").toLowerCase();
  const sec = (security || "").toLowerCase();
  if (s === "terminated" || sec.includes("flag") || sec.includes("contamin")) {
    return { label: "Contaminated — integrity / rules issue", className: "bg-red-100 text-red-800 border-red-200" };
  }
  if (s === "published" || releasedAt) {
    return { label: "Released", className: "bg-emerald-100 text-emerald-800 border-emerald-200" };
  }
  if (sec.includes("teacher_marked") || sec === "marked") {
    return { label: "Teacher marked — ready to release", className: "bg-sky-100 text-sky-900 border-sky-200" };
  }
  if (sec.includes("await") || sec.includes("essay") || sec.includes("marking")) {
    return { label: "Waiting for teacher marking", className: "bg-violet-100 text-violet-900 border-violet-200" };
  }
  if (s === "held" || sec.includes("hold") || sec.includes("held")) {
    return { label: "Held by departmental officer", className: "bg-amber-100 text-amber-900 border-amber-200" };
  }
  if (s === "pending" || s === "under_review" || !releasedAt) {
    return { label: "Waiting for official release", className: "bg-orange-100 text-orange-900 border-orange-200" };
  }
  return { label: status || "—", className: "bg-slate-100 text-slate-700 border-slate-200" };
}

function isHeld(status: string, releasedAt: string | null) {
  const s = (status || "").toLowerCase();
  if (s === "published" || releasedAt) return false;
  if (s === "terminated") return false;
  return true;
}
function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return "—"; }
}

export function OfficerResultsPage() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const qc = useQueryClient();
  const [selectedExamId, setSelectedExamId] = useState<string | null>(null);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const examsQ = useQuery({
    queryKey: ["officer-results-exams", schoolId],
    enabled: Boolean(schoolId),
    refetchInterval: 12_000,
    queryFn: async () => {
      if (!schoolId) return [] as ExamRow[];
      const { data, error } = await supabase
        .from("examinations")
        .select("id, title, status, course_id, scheduled_start, scheduled_end, duration_minutes, courses(code, name)")
        .eq("school_id", schoolId)
        .in("status", ["completed", "closed", "ongoing", "scheduled", "approved", "published"])
        .order("updated_at", { ascending: false })
        .limit(60);
      if (error) {
        console.warn("[officer-results] exams", error);
        return [] as ExamRow[];
      }
      return (data ?? []) as ExamRow[];
    },
  });

  const examIds = (examsQ.data ?? []).map((e) => e.id);

  const attemptsQ = useQuery({
    queryKey: ["officer-exam-attempts", schoolId, examIds.join(",")],
    enabled: Boolean(schoolId && examIds.length),
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!examIds.length) return {} as Record<string, { total: number; finished: number }>;
      const { data, error } = await supabase.from("exam_attempts").select("exam_id, status").in("exam_id", examIds);
      if (error) {
        console.warn("[officer-results] attempts", error);
        return {} as Record<string, { total: number; finished: number }>;
      }
      const map: Record<string, { total: number; finished: number }> = {};
      for (const a of data ?? []) {
        const eid = (a as { exam_id: string }).exam_id;
        if (!map[eid]) map[eid] = { total: 0, finished: 0 };
        map[eid].total += 1;
        const st = String((a as { status: string }).status || "").toLowerCase();
        if (["submitted", "completed", "finished", "graded", "marked", "terminated", "flagged"].includes(st)) map[eid].finished += 1;
      }
      return map;
    },
  });

  const resultsCountsQ = useQuery({
    queryKey: ["officer-results-counts", schoolId, examIds.join(",")],
    enabled: Boolean(schoolId && examIds.length),
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!examIds.length) return {} as Record<string, { total: number; held: number; published: number }>;
      const { data, error } = await supabase.from("results").select("exam_id, status, released_at").eq("school_id", schoolId!).in("exam_id", examIds);
      if (error) {
        console.warn("[officer-results] counts", error);
        return {} as Record<string, { total: number; held: number; published: number }>;
      }
      const map: Record<string, { total: number; held: number; published: number }> = {};
      for (const r of data ?? []) {
        const eid = (r as { exam_id: string }).exam_id;
        if (!map[eid]) map[eid] = { total: 0, held: 0, published: 0 };
        map[eid].total += 1;
        if (isHeld(String((r as { status: string }).status), (r as { released_at: string | null }).released_at)) map[eid].held += 1;
        else if (String((r as { status: string }).status).toLowerCase() !== "terminated") map[eid].published += 1;
      }
      return map;
    },
  });

  const selectedExam = (examsQ.data ?? []).find((e) => e.id === selectedExamId) ?? null;

  const examResultsQ = useQuery({
    queryKey: ["officer-exam-results", schoolId, selectedExamId],
    enabled: Boolean(schoolId && selectedExamId),
    refetchInterval: 8_000,
    queryFn: async () => {
      if (!schoolId || !selectedExamId) return [] as ResultRow[];
      const selects = [
        `id, exam_id, student_id, attempt_id, total_score, max_score, percentage, grade, pass_fail,
           correct_count, wrong_count, unanswered_count, status, security_review_status, released_at, created_at,
           students(matric_number, student_id, profiles(full_name))`,
        `id, exam_id, student_id, attempt_id, total_score, max_score, percentage, grade, pass_fail,
           correct_count, wrong_count, unanswered_count, status, security_review_status, released_at, created_at,
           students(matric_number, student_id)`,
        `id, exam_id, student_id, attempt_id, total_score, max_score, percentage, grade, pass_fail,
           correct_count, wrong_count, unanswered_count, status, security_review_status, released_at, created_at`,
      ];
      let rows: ResultRow[] = [];
      for (const sel of selects) {
        const { data, error } = await supabase
          .from("results")
          .select(sel)
          .eq("school_id", schoolId).eq("exam_id", selectedExamId).order("created_at", { ascending: false }).limit(200);
        if (!error) {
          rows = (data ?? []) as unknown as ResultRow[];
          break;
        }
        console.warn("[officer-results] exam results select failed", error);
      }
      // Resolve names: server fn when available, always client fallback
      const allIds = [...new Set(rows.map((r) => r.student_id).filter(Boolean))];
      if (allIds.length && schoolId) {
        let map: Record<string, { full_name: string; matric_number: string | null; student_id: string | null }> = {};
        try {
          map = (await resolveStudentNamesForOfficer({
            data: { schoolId, studentIds: allIds },
          })) || {};
        } catch (e) {
          console.warn("[officer-results] server name resolve failed", e);
        }
        try {
          const clientMap = await resolveStudentDetails(schoolId, allIds);
          for (const [id, d] of Object.entries(clientMap)) {
            if (!map[id]?.full_name) {
              map[id] = {
                full_name: d.fullName,
                matric_number: d.matric === "—" ? null : d.matric,
                student_id: d.matric === "—" ? null : d.matric,
              };
            }
          }
        } catch (e) {
          console.warn("[officer-results] client name resolve failed", e);
        }
        rows = rows.map((r) => {
          const hit = map?.[r.student_id];
          const prev = (r.students || {}) as Record<string, unknown>;
          const full = (hit?.full_name || "").trim()
            || (typeof prev.full_name === "string" ? prev.full_name.trim() : "")
            || String((prev.profiles as { full_name?: string } | null)?.full_name || "").trim();
          return {
            ...r,
            students: {
              ...prev,
              full_name: full || null,
              matric_number: hit?.matric_number || prev.matric_number || null,
              student_id: hit?.student_id || prev.student_id || null,
              profiles: full ? { full_name: full } : (prev.profiles as { full_name: string | null } | null) || null,
            },
          } as ResultRow;
        });
      }
      return rows;
    },
  });

  const selectedResult = (examResultsQ.data ?? []).find((r) => r.id === selectedResultId) ?? null;

  const detailEventsQ = useQuery({
    queryKey: ["officer-result-events", schoolId, selectedResult?.student_id, selectedResult?.exam_id],
    enabled: Boolean(schoolId && selectedResult?.student_id && selectedResult?.exam_id),
    queryFn: async () => {
      if (!schoolId || !selectedResult) return [] as IntegrityEvent[];
      const { data, error } = await supabase.from("integrity_events").select("id, event_type, severity, description, created_at")
        .eq("school_id", schoolId).eq("exam_id", selectedResult.exam_id).eq("student_id", selectedResult.student_id)
        .order("created_at", { ascending: false }).limit(40);
      if (error) return [];
      return (data ?? []) as IntegrityEvent[];
    },
  });

  const attemptDetailQ = useQuery({
    queryKey: ["officer-result-attempt", selectedResult?.attempt_id, selectedResult?.exam_id, selectedResult?.student_id],
    enabled: Boolean(selectedResult),
    queryFn: async () => {
      if (!selectedResult) return null;
      if (selectedResult.attempt_id) {
        const { data } = await supabase.from("exam_attempts").select("id, status, started_at, submitted_at, tab_switch_count").eq("id", selectedResult.attempt_id).maybeSingle();
        if (data) return data;
      }
      const { data } = await supabase.from("exam_attempts").select("id, status, started_at, submitted_at, tab_switch_count")
        .eq("exam_id", selectedResult.exam_id).eq("student_id", selectedResult.student_id).order("submitted_at", { ascending: false }).limit(1).maybeSingle();
      return data;
    },
  });

  async function heldStudentIds(examId: string): Promise<string[]> {
    const { data } = await supabase.from("results").select("student_id, status, released_at").eq("exam_id", examId).eq("school_id", schoolId!);
    const ids: string[] = [];
    for (const r of data ?? []) {
      if (isHeld(String((r as { status: string }).status), (r as { released_at: string | null }).released_at)) {
        const sid = (r as { student_id: string | null }).student_id;
        if (sid) ids.push(sid);
      }
    }
    return [...new Set(ids)];
  }

  async function tryAutoCompleteExam(examId: string) {
    if (!schoolId) return;
    const { data: attempts } = await supabase.from("exam_attempts").select("id, status").eq("exam_id", examId).eq("school_id", schoolId);
    const list = attempts ?? [];
    if (!list.length) return;
    const done = list.filter((a) => ["submitted", "completed", "finished", "graded", "marked", "terminated", "flagged"].includes(String((a as { status: string }).status || "").toLowerCase()));
    if (done.length === list.length && done.length > 0) {
      await supabase.from("examinations").update({ status: "completed" } as never).eq("id", examId).eq("school_id", schoolId).neq("status", "completed");
      await qc.invalidateQueries({ queryKey: ["officer-results-exams"] });
    }
  }

  useEffect(() => {
    if (!schoolId || !attemptsQ.data) return;
    for (const [examId, stats] of Object.entries(attemptsQ.data)) {
      if (stats.total > 0 && stats.finished >= stats.total) void tryAutoCompleteExam(examId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, attemptsQ.dataUpdatedAt]);

  async function examHasEssayQuestions(examId: string): Promise<boolean> {
    try {
      const { data: links } = await supabase.from("exam_questions").select("question_id").eq("exam_id", examId).limit(300);
      const qids = (links ?? []).map((l) => String(l.question_id)).filter(Boolean);
      if (!qids.length) return false;
      const { data: qs } = await supabase.from("questions").select("id, question_type").in("id", qids);
      return (qs ?? []).some((q) => {
        const ty = String((q as { question_type?: string }).question_type || "").toLowerCase();
        return ["essay", "short_answer", "short-answer", "theory", "descriptive", "numerical"].some(
          (x) => ty === x || ty.includes(x.replace("-", "_")),
        );
      });
    } catch {
      return false;
    }
  }

  async function releaseResults(examId: string) {
    if (!schoolId || !user) return;
    // Essay papers: block release until teacher has marked scripts
    if (await examHasEssayQuestions(examId)) {
      const { data: pendingRows } = await supabase
        .from("results")
        .select("id, security_review_status, status")
        .eq("exam_id", examId)
        .eq("school_id", schoolId)
        .neq("status", "terminated");
      const unmarked = (pendingRows ?? []).filter((r) => {
        const sec = String((r as { security_review_status?: string }).security_review_status || "").toLowerCase();
        const st = String((r as { status?: string }).status || "").toLowerCase();
        // Already released / published is fine; teacher_marked / marked / clear after teacher work
        if (st === "published" || sec === "teacher_marked" || sec === "marked" || sec === "flagged") return false;
        // Pending objective-only (essay papers need teacher_marked)
        return true;
      });
      if (unmarked.length > 0) {
        toast.error(
          `Cannot release yet — ${unmarked.length} script(s) still need teacher essay marking (Not marked).`,
        );
        return;
      }
    }
    if (!confirm("Release all held results to students? Flagged stay under review.")) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      // Skip results under integrity review / flagged / further review / cancelled
      const { data: candidates } = await supabase
        .from("results")
        .select("id, student_id, security_review_status, status")
        .eq("exam_id", examId)
        .eq("school_id", schoolId)
        .neq("status", "terminated");
      const skipStatuses = new Set(["flagged", "further_review", "cancelled", "under_review"]);
      const toRelease = (candidates ?? []).filter((r) => {
        const sec = String((r as { security_review_status?: string }).security_review_status || "").toLowerCase();
        const st = String((r as { status?: string }).status || "").toLowerCase();
        if (skipStatuses.has(sec)) return false;
        if (st === "terminated" || st === "cancelled") return false;
        return true;
      });
      const skipCount = (candidates ?? []).length - toRelease.length;
      if (!toRelease.length) {
        toast.error(
          skipCount
            ? `No results released — ${skipCount} still under integrity review / flagged.`
            : "No held results to release.",
        );
        return;
      }
      const ids = toRelease.map((r) => r.id);
      const { data, error } = await supabase
        .from("results")
        .update({ status: "published", released_at: now, released_by: user.userId } as never)
        .in("id", ids)
        .select("id, student_id");
      if (error) throw error;
      const released = data ?? [];
      const studentIds = [...new Set(released.map((r) => r.student_id).filter(Boolean))] as string[];
      const examTitle = (examsQ.data ?? []).find((e) => e.id === examId)?.title ?? "your examination";
      if (studentIds.length) void namedStudentsResultsReleased({ schoolId, studentIds, examTitle });
      toast.success(
        skipCount
          ? `Released ${released.length} result(s); ${skipCount} held under integrity review`
          : `Released ${released.length} result(s)`,
      );
      await qc.invalidateQueries({ queryKey: ["officer-results-exams"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-counts"] });
      await qc.invalidateQueries({ queryKey: ["officer-exam-results"] });
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  }

  async function holdAllResults(examId: string) {
    if (!schoolId || !user) return;
    const reason = window.prompt("Reason for holding all results:", "Under officer review") || "";
    if (!confirm("Hold all results? Students will not see scores until released.")) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("results").update({ status: "pending", released_at: null } as never).eq("exam_id", examId).eq("school_id", schoolId).neq("status", "terminated");
      if (error) throw error;
      const sids = await heldStudentIds(examId);
      const examTitle = (examsQ.data ?? []).find((e) => e.id === examId)?.title ?? "your examination";
      if (sids.length) void notifyStudentsResultsHeld({ schoolId, studentIds: sids, examTitle, reason });
      toast.success("Results held — students notified");
      await qc.invalidateQueries({ queryKey: ["officer-results-counts"] });
      await qc.invalidateQueries({ queryKey: ["officer-exam-results"] });
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  }

  async function rescheduleExam(examId: string) {
    if (!schoolId || !user) return;
    const reason = window.prompt("Reason for reschedule (held students only):", "") || "";
    const startStr = window.prompt("New start (YYYY-MM-DDTHH:MM)", "");
    if (!startStr) return;
    const endStr = window.prompt("New end (YYYY-MM-DDTHH:MM)", "");
    if (!endStr) return;
    const start = new Date(startStr); const end = new Date(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) { toast.error("Invalid schedule"); return; }
    setBusy(true);
    try {
      const heldIds = await heldStudentIds(examId);
      const { error } = await supabase.from("examinations").update({ scheduled_start: start.toISOString(), scheduled_end: end.toISOString(), status: "scheduled" } as never).eq("id", examId).eq("school_id", schoolId);
      if (error) throw error;
      if (heldIds.length) {
        await supabase.from("exam_attempts").delete().eq("exam_id", examId).in("student_id", heldIds);
        await supabase.from("results").delete().eq("exam_id", examId).in("student_id", heldIds);
        const examTitle = (examsQ.data ?? []).find((e) => e.id === examId)?.title ?? "your examination";
        void notifyStudentsExamRescheduled({ schoolId, studentIds: heldIds, examTitle, reason, windowLabel: `${start.toLocaleString()} – ${end.toLocaleString()}` });
      }
      toast.success(heldIds.length ? `Rescheduled — ${heldIds.length} held student(s) can rewrite` : "Exam rescheduled");
      await qc.invalidateQueries({ queryKey: ["officer-results-exams"] });
      await qc.invalidateQueries({ queryKey: ["officer-exam-results"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-counts"] });
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  }

  async function allowRewrite(examId: string) {
    if (!schoolId || !user) return;
    const heldIds = await heldStudentIds(examId);
    if (!heldIds.length) { toast.error("No held results to rewrite"); return; }
    const reason = window.prompt(`Allow rewrite for ${heldIds.length} held student(s). Reason:`, "") || "";
    if (!confirm(`Open rewrite for ${heldIds.length} held student(s)?`)) return;
    setBusy(true);
    try {
      await supabase.from("exam_attempts").delete().eq("exam_id", examId).in("student_id", heldIds);
      await supabase.from("results").delete().eq("exam_id", examId).in("student_id", heldIds);
      await supabase.from("examinations").update({ status: "scheduled" } as never).eq("id", examId).eq("school_id", schoolId).in("status", ["completed", "closed"]);
      const examTitle = (examsQ.data ?? []).find((e) => e.id === examId)?.title ?? "your examination";
      void notifyStudentsRewriteAllowed({ schoolId, studentIds: heldIds, examTitle, reason });
      toast.success(`Rewrite opened for ${heldIds.length} student(s)`);
      setSelectedResultId(null);
      await qc.invalidateQueries({ queryKey: ["officer-exam-attempts"] });
      await qc.invalidateQueries({ queryKey: ["officer-exam-results"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-counts"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-exams"] });
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  }

  async function releaseOneResult(result: ResultRow) {
    if (!schoolId || !user) return;
    if (await examHasEssayQuestions(result.exam_id)) {
      const sec = String(result.security_review_status || "").toLowerCase();
      if (sec !== "teacher_marked") {
        toast.error("Cannot release — teacher has not marked this student's essay script yet.");
        return;
      }
    }
    if (!confirm("Release this student's result?")) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from("results").update({ status: "published", released_at: now, released_by: user.userId } as never).eq("id", result.id).eq("school_id", schoolId);
      if (error) throw error;
      const examTitle = (examsQ.data ?? []).find((e) => e.id === result.exam_id)?.title ?? "your examination";
      void namedStudentsResultsReleased({ schoolId, studentIds: [result.student_id], examTitle });
      toast.success("Result released — student notified");
      await qc.invalidateQueries({ queryKey: ["officer-exam-results"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-counts"] });
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  }

  async function terminateOneResult(result: ResultRow) {
    if (!schoolId || !user) return;
    const reason = window.prompt("Terminate this paper. Reason:", "Exam rules violation") || "Exam rules violation";
    if (!confirm("Terminate this student's paper?")) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("results").update({ status: "terminated", security_review_status: "flagged", released_at: null } as never).eq("id", result.id).eq("school_id", schoolId);
      if (error) throw error;
      if (result.attempt_id) await supabase.from("exam_attempts").update({ status: "terminated" } as never).eq("id", result.attempt_id);
      else await supabase.from("exam_attempts").update({ status: "terminated" } as never).eq("exam_id", result.exam_id).eq("student_id", result.student_id);
      const examTitle = (examsQ.data ?? []).find((e) => e.id === result.exam_id)?.title ?? "your examination";
      void notifyStudentResultTerminated({ schoolId, studentId: result.student_id, examTitle, reason });
      toast.success("Paper terminated — student notified");
      await qc.invalidateQueries({ queryKey: ["officer-exam-results"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-counts"] });
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  }

  async function rescheduleOneResult(result: ResultRow) {
    if (!schoolId || !user) return;
    const reason = window.prompt("Reason for reschedule:", "") || "";
    const startStr = window.prompt("New start (YYYY-MM-DDTHH:MM)", "");
    if (!startStr) return;
    const endStr = window.prompt("New end (YYYY-MM-DDTHH:MM)", "");
    if (!endStr) return;
    const start = new Date(startStr); const end = new Date(endStr);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) { toast.error("Invalid schedule"); return; }
    if (!confirm("Clear this student's attempt so they can rewrite?")) return;
    setBusy(true);
    try {
      await supabase.from("examinations").update({ scheduled_start: start.toISOString(), scheduled_end: end.toISOString(), status: "scheduled" } as never).eq("id", result.exam_id).eq("school_id", schoolId);
      await supabase.from("exam_attempts").delete().eq("exam_id", result.exam_id).eq("student_id", result.student_id);
      await supabase.from("results").delete().eq("id", result.id);
      const examTitle = (examsQ.data ?? []).find((e) => e.id === result.exam_id)?.title ?? "your examination";
      void notifyStudentsExamRescheduled({ schoolId, studentIds: [result.student_id], examTitle, reason, windowLabel: `${start.toLocaleString()} – ${end.toLocaleString()}` });
      toast.success("Student rescheduled");
      setSelectedResultId(null);
      await qc.invalidateQueries({ queryKey: ["officer-exam-results"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-counts"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-exams"] });
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  }

  async function rewriteOneResult(result: ResultRow) {
    if (!schoolId || !user) return;
    const reason = window.prompt("Reason for rewrite:", "") || "";
    if (!confirm("Clear this student's attempt & result so they can rewrite?")) return;
    setBusy(true);
    try {
      await supabase.from("exam_attempts").delete().eq("exam_id", result.exam_id).eq("student_id", result.student_id);
      await supabase.from("results").delete().eq("id", result.id);
      await supabase.from("examinations").update({ status: "scheduled" } as never).eq("id", result.exam_id).eq("school_id", schoolId).in("status", ["completed", "closed"]);
      const examTitle = (examsQ.data ?? []).find((e) => e.id === result.exam_id)?.title ?? "your examination";
      void notifyStudentsRewriteAllowed({ schoolId, studentIds: [result.student_id], examTitle, reason });
      toast.success("Rewrite allowed");
      setSelectedResultId(null);
      await qc.invalidateQueries({ queryKey: ["officer-exam-results"] });
      await qc.invalidateQueries({ queryKey: ["officer-results-counts"] });
      await qc.invalidateQueries({ queryKey: ["officer-exam-attempts"] });
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  }

  const rows = examsQ.data ?? [];
  const attempts = attemptsQ.data ?? {};
  const counts = resultsCountsQ.data ?? {};

  if (selectedExam && selectedResult) {
    const name = (
      (selectedResult.students as { full_name?: string | null } | null | undefined)?.full_name?.trim()
      || selectedResult.students?.profiles?.full_name?.trim()
      || "Student"
    );
    const matric = selectedResult.students?.matric_number || selectedResult.students?.student_id || "—";
    const held = isHeld(selectedResult.status, selectedResult.released_at);
    const terminated = String(selectedResult.status || "").toLowerCase() === "terminated";
    const pct = Number(selectedResult.percentage ?? 0);
    const pass = String(selectedResult.pass_fail || "").toLowerCase() === "pass";
    const attempt = attemptDetailQ.data as { started_at?: string | null; submitted_at?: string | null; tab_switch_count?: number | null; status?: string | null } | null;
    const events = detailEventsQ.data ?? [];
    return (
      <div className="mx-auto w-full max-w-3xl space-y-2.5">
        <button type="button" onClick={() => setSelectedResultId(null)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to students
        </button>
        <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm sm:rounded-xl sm:p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-base font-extrabold text-slate-900">{name}</p>
              <p className="truncate text-xs font-medium text-slate-500">{matric}</p>
              <p className="mt-0.5 truncate text-[10px] text-slate-500">{selectedExam.courses?.code} · {selectedExam.title}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {terminated ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-800">Terminated</span>
              ) : held ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700"><span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Held</span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Released</span>
              )}
            </div>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-2">
            <MiniStat label="Score" value={`${selectedResult.total_score ?? "—"} / ${selectedResult.max_score ?? "—"}`} />
            <MiniStat label="%" value={`${Math.round(pct)}%`} />
            <MiniStat label="Grade" value={selectedResult.grade || "—"} />
            <MiniStat label="Result" value={pass ? "PASS" : selectedResult.pass_fail ? "FAIL" : "—"} tone={pass ? "green" : selectedResult.pass_fail ? "red" : "slate"} />
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-center text-[10px]">
            <div className="rounded-md bg-emerald-50 py-1.5"><p className="font-bold text-emerald-800">{selectedResult.correct_count ?? "—"}</p><p className="text-emerald-700">Correct</p></div>
            <div className="rounded-md bg-red-50 py-1.5"><p className="font-bold text-red-800">{selectedResult.wrong_count ?? "—"}</p><p className="text-red-700">Wrong</p></div>
            <div className="rounded-md bg-amber-50 py-1.5"><p className="font-bold text-amber-900">{selectedResult.unanswered_count ?? "—"}</p><p className="text-amber-800">Blank</p></div>
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] sm:text-[11px]">
            <Meta label="Submitted" value={fmt(attempt?.submitted_at ?? selectedResult.created_at)} />
            <Meta label="Started" value={fmt(attempt?.started_at)} />
            <Meta label="Attempt" value={attempt?.status || "—"} />
            <Meta label="Tab switches" value={String(attempt?.tab_switch_count ?? 0)} />
            <Meta label="Security" value={(selectedResult.security_review_status || "pending").replaceAll("_", " ")} />
            <Meta label="Released" value={selectedResult.released_at ? fmt(selectedResult.released_at) : "Not yet"} />
          </div>
          {(() => {
            const rr = resultReasonLabel(selectedResult.status, selectedResult.security_review_status, selectedResult.released_at);
            return (
              <div className={cn("mt-2 rounded-lg border px-3 py-2 text-xs font-semibold", rr.className)}>
                Result status: {rr.label}
              </div>
            );
          })()}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" className="h-7 bg-primary px-2 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90" disabled={busy || !held} onClick={() => void releaseOneResult(selectedResult)}>Release</Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] text-red-700" disabled={busy || terminated} onClick={() => void terminateOneResult(selectedResult)}>Terminate</Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy} onClick={() => void rescheduleOneResult(selectedResult)}>Reschedule</Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy} onClick={() => void rewriteOneResult(selectedResult)}>Rewrite</Button>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm sm:rounded-xl sm:p-4">
          <h3 className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Activity log</h3>
          {events.length === 0 ? (
            <p className="mt-1.5 text-[11px] text-slate-500">No integrity events recorded for this attempt.</p>
          ) : (
            <ul className="mt-1.5 max-h-56 space-y-1.5 overflow-y-auto">
              {events.map((ev) => (
                <li key={ev.id} className="flex gap-2 text-[11px]">
                  <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", ev.severity === "high" ? "bg-red-500" : ev.severity === "medium" ? "bg-amber-500" : "bg-emerald-500")} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800">{humanEventLabel(ev.event_type, ev.description)}</p>
                    <p className="text-slate-500">{relativeTime(ev.created_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  if (selectedExam) {
    const heldCount = counts[selectedExam.id]?.held ?? 0;
    const examResults = examResultsQ.data ?? [];
    const st = String(selectedExam.status || "").toLowerCase();
    return (
      <div className="mx-auto w-full max-w-3xl space-y-2.5">
        <button type="button" onClick={() => { setSelectedExamId(null); setSelectedResultId(null); }} className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> All examinations
        </button>
        <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:rounded-xl sm:p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-bold text-primary">{selectedExam.courses?.code ?? "—"}</p>
              <p className="text-sm font-extrabold text-slate-900">{selectedExam.title}</p>
              <p className="mt-0.5 text-[10px] text-slate-500">
                {selectedExam.duration_minutes ? `${selectedExam.duration_minutes} min` : ""}
                {selectedExam.scheduled_start ? ` · ${fmt(selectedExam.scheduled_start)}` : ""}
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase text-slate-600">{st}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button size="sm" className="h-7 bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90" disabled={busy || heldCount === 0} onClick={() => void releaseResults(selectedExam.id)}>
              Release ({heldCount})
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" disabled={busy} onClick={() => void holdAllResults(selectedExam.id)}>Hold all</Button>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" disabled={busy} onClick={() => void rescheduleExam(selectedExam.id)}>Reschedule</Button>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" disabled={busy || heldCount === 0} onClick={() => void allowRewrite(selectedExam.id)}>Rewrite</Button>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm sm:rounded-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Student results ({examResults.length})</p>
            {heldCount > 0 && <span className="text-[10px] font-semibold text-red-600">{heldCount} held</span>}
          </div>
          {examResultsQ.isLoading ? (
            <p className="p-4 text-sm text-slate-500"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading…</p>
          ) : examResults.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No results yet for this exam.</p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {examResults.map((r) => {
                const nm =
                  (r.students as { full_name?: string | null } | null)?.full_name?.trim()
                  || r.students?.profiles?.full_name?.trim()
                  || "Student";
                const mat = r.students?.matric_number || r.students?.student_id || "—";
                const h = isHeld(r.status, r.released_at);
                const term = String(r.status || "").toLowerCase() === "terminated";
                return (
                  <li key={r.id}>
                    <button type="button" onClick={() => setSelectedResultId(r.id)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50">
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100"><UserRound className="h-4 w-4 text-slate-500" /></div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-bold text-slate-900">{nm}</p>
                        <p className="truncate text-[10px] text-slate-500">{mat}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-bold tabular-nums text-slate-800">{r.percentage != null ? `${Math.round(Number(r.percentage))}%` : "—"}</p>
                        <p className="text-[10px] text-slate-500">{r.grade || "—"}</p>
                      </div>
                      {term ? (
                        <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-bold text-red-800">Term.</span>
                      ) : ["flagged", "further_review", "under_review"].includes(String(r.security_review_status || "").toLowerCase()) ? (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-900">Integrity review</span>
                      ) : h ? (
                        <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700">Held</span>
                      ) : (
                        <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">Out</span>
                      )}
                      <ChevronRight className="h-4 w-4 text-slate-300" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Results Release" description="Review held results, release scores, reschedule or allow rewrite. Exams auto-complete when all attempts are finished." />
      {examsQ.isLoading ? (
        <p className="text-sm text-slate-500"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading examinations…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={Clock} title="No examinations" description="Completed and ongoing exams with results appear here." />
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => {
            const c = counts[e.id] ?? { total: 0, held: 0, published: 0 };
            const a = attempts[e.id] ?? { total: 0, finished: 0 };
            return (
              <li key={e.id}>
                <button type="button" onClick={() => setSelectedExamId(e.id)} className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:shadow-md">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-primary">{e.courses?.code ?? "—"}</p>
                    <p className="truncate text-sm font-bold text-slate-900">{e.title}</p>
                    <p className="mt-0.5 text-[10px] text-slate-500">
                      {a.finished}/{a.total} attempts done · {c.held} held · {c.published} released
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase text-slate-600">{e.status}</span>
                  <ChevronRight className="h-4 w-4 text-slate-300" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MiniStat({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "green" | "red" }) {
  const tones = { slate: "bg-slate-50 text-slate-900", green: "bg-emerald-50 text-emerald-800", red: "bg-red-50 text-red-800" };
  return (
    <div className={cn("rounded-md px-2 py-1.5 text-center", tones[tone])}>
      <p className="text-[9px] font-semibold uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-sm font-extrabold tabular-nums">{value}</p>
    </div>
  );
}
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-slate-400">{label}: </span>
      <span className="font-semibold capitalize text-slate-800">{value}</span>
    </div>
  );
}
