import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Send,
  Save,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Undo2,
  Pencil,
  Trash2,
  ListChecks,
} from "lucide-react";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTeacherContext } from "@/lib/teacher";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import {
  DEFAULT_EXAM_SECURITY,
  embedSecurityInDescription,
  loadTeacherSecurityDefaults,
  normalizeSecuritySettings,
  parseSecurityFromDescription,
  resolveScreenShareMode,
  securitySummaryLines,
  stripInternalMarkers,
  toExamSettingsRow,
} from "@/lib/exam-security";
import { embedExamMeta, parseExamMeta, assessmentKindLabel, type AssessmentKind } from "@/lib/exam-meta";
import { namedOfficersExamSubmitted as notifyOfficersExamSubmitted } from "@/lib/notify-named";
import { ensureExamQuestionsLinked } from "@/lib/cbt-load-questions";
import { toast } from "sonner";
import { D4DateTimeField } from "@/components/ui/d4-datetime";
import { cn } from "@/lib/utils";
import type { ExamSecuritySettings, FaceViolationAction, ScreenShareMode } from "@/types";

export const Route = createFileRoute("/teacher/examinations")({
  validateSearch: (search: Record<string, unknown>) =>
    ({ course: typeof search.course === "string" ? search.course : undefined }) as { course?: string },
  head: () => ({
    meta: [
      { title: "Examinations — D4EXAM" },
      { name: "description", content: "Create and schedule examinations for your assigned courses." },
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
  description: string | null;
  created_by: string | null;
  courses: { code: string; name: string } | null;
};

function toLocalInput(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function endFromStart(startLocal: string, durationMin: number) {
  if (!startLocal) return "";
  const d = new Date(startLocal);
  if (Number.isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() + Math.max(1, durationMin));
  return toLocalInput(d.toISOString());
}

async function tryUpsertExamSettings(
  examId: string,
  security: ExamSecuritySettings,
  questionsToAnswer: number | null = null,
) {
  try {
    const row = toExamSettingsRow(examId, security, 0, questionsToAnswer);
    const { error } = await supabase.from("exam_settings").upsert(row as never, { onConflict: "exam_id" });
    if (error) {
      const msg = String(error.message || "");
      if (msg.includes("allow_calculator") || msg.includes("calculator_type") || msg.includes("schema cache")) {
        const { allow_calculator: _a, calculator_type: _b, ...rest } = row as Record<string, unknown>;
        const { error: err2 } = await supabase.from("exam_settings").upsert(rest as never, { onConflict: "exam_id" });
        if (!err2) return { savedToTable: true as const, error: null };
        console.warn("exam_settings upsert skipped:", err2.message);
        return { savedToTable: false as const, error: err2.message };
      }
      console.warn("exam_settings upsert skipped:", error.message);
      return { savedToTable: false as const, error: error.message };
    }
    return { savedToTable: true as const, error: null };
  } catch (e) {
    return { savedToTable: false as const, error: (e as Error).message };
  }
}

function extractOfficerFeedback(description: string | null | undefined): {
  kind: "rejected" | "changes" | "note" | null;
  message: string | null;
} {
  if (!description) return { kind: null, message: null };
  const rejected = description.match(/\[Rejected\]\s*([^\n]*(?:\n(?!\[)[^\n]*)*)/i);
  if (rejected?.[1]?.trim()) return { kind: "rejected", message: rejected[1].trim() };
  const changes = description.match(/\[Changes requested\]\s*([^\n]*(?:\n(?!\[)[^\n]*)*)/i);
  if (changes?.[1]?.trim()) return { kind: "changes", message: changes[1].trim() };
  const note = description.match(/\[Officer note\]\s*([^\n]*(?:\n(?!\[)[^\n]*)*)/i);
  if (note?.[1]?.trim()) return { kind: "note", message: note[1].trim() };
  return { kind: null, message: null };
}

function Page() {
  const { course: courseFromUrl } = Route.useSearch();
  const { data: teacher, isLoading: tLoading } = useTeacherContext();
  const { data: session } = useSessionUser();
  const qc = useQueryClient();
  const [builder, setBuilder] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  const lockedCourseId =
    courseFromUrl && teacher?.courseIds.includes(courseFromUrl) ? courseFromUrl : null;
  const lockedCourse = teacher?.courses.find((c) => c.id === lockedCourseId) ?? null;

  const [courseId, setCourseId] = useState("");
  const [carryoverIds, setCarryoverIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [assessmentKind, setAssessmentKind] = useState<AssessmentKind>("examination");
  const [description, setDescription] = useState("");
  const [durationText, setDurationText] = useState("60");
  const [questionsText, setQuestionsText] = useState("20");
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<string[]>([]);
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [security, setSecurity] = useState<ExamSecuritySettings>({ ...DEFAULT_EXAM_SECURITY });

  const durationMinutes = Math.max(1, Number.parseInt(durationText, 10) || 0);
  const questionsToAnswer = Math.max(1, Number.parseInt(questionsText, 10) || 0);

  useEffect(() => {
    if (lockedCourseId) setCourseId(lockedCourseId);
  }, [lockedCourseId]);

  const bankCountQ = useQuery({
    queryKey: ["teacher-bank-count", teacher?.schoolId, courseId],
    enabled: Boolean(teacher?.schoolId && courseId),
    queryFn: async () => {
      if (!teacher || !courseId) return 0;
      const { count, error } = await supabase
        .from("questions")
        .select("*", { count: "exact", head: true })
        .eq("school_id", teacher.schoolId)
        .eq("course_id", courseId)
        .eq("status", "active");
      if (error) return 0;
      return count ?? 0;
    },
  });
  const bankCount = bankCountQ.data ?? 0;

  const bankListQ = useQuery({
    queryKey: ["teacher-bank-list", teacher?.schoolId, courseId],
    enabled: Boolean(teacher?.schoolId && courseId),
    queryFn: async () => {
      if (!teacher || !courseId) return [] as { id: string; question_text: string; question_type: string | null; marks: number | null }[];
      const { data, error } = await supabase
        .from("questions")
        .select("id, question_text, question_type, marks")
        .eq("school_id", teacher.schoolId)
        .eq("course_id", courseId)
        .in("status", ["active", "approved"])
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) {
        // fallback without status filter
        const r2 = await supabase
          .from("questions")
          .select("id, question_text, question_type, marks")
          .eq("school_id", teacher.schoolId)
          .eq("course_id", courseId)
          .order("created_at", { ascending: true })
          .limit(200);
        return (r2.data ?? []) as { id: string; question_text: string; question_type: string | null; marks: number | null }[];
      }
      return (data ?? []) as { id: string; question_text: string; question_type: string | null; marks: number | null }[];
    },
  });
  const bankList = bankListQ.data ?? [];

  const carryoversQ = useQuery({
    queryKey: ["teacher-carryovers", teacher?.schoolId, courseId],
    enabled: Boolean(teacher?.schoolId && courseId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("course_carryovers")
        .select("id, student_id, students(id, full_name, matric_number, student_id, levels(name))")
        .eq("school_id", teacher!.schoolId)
        .eq("course_id", courseId)
        .eq("status", "active")
        .limit(200);
      if (error) {
        return [] as Array<{
          id: string;
          student_id: string;
          students: {
            full_name?: string | null;
            matric_number?: string | null;
            student_id?: string;
            levels?: { name?: string } | null;
          } | null;
        }>;
      }
      return (data ?? []) as Array<{
        id: string;
        student_id: string;
        students: {
          full_name?: string | null;
          matric_number?: string | null;
          student_id?: string;
          levels?: { name?: string } | null;
        } | null;
      }>;
    },
  });

  const listQ = useQuery({
    queryKey: ["teacher-exams", teacher?.schoolId, teacher?.courseIds, lockedCourseId, session?.userId],
    enabled: Boolean(teacher?.schoolId && teacher.courseIds.length),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!teacher || !session) return [] as ExamRow[];
      const { data, error } = await supabase
        .from("examinations")
        .select(
          "id, title, status, duration_minutes, scheduled_start, scheduled_end, course_id, description, created_by, courses(code, name)",
        )
        .eq("school_id", teacher.schoolId)
        .in("course_id", lockedCourseId ? [lockedCourseId] : teacher.courseIds)
        .order("updated_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return ((data ?? []) as ExamRow[]).filter((e) => {
        if (e.status === "draft") return !e.created_by || e.created_by === session.userId;
        return true;
      });
    },
  });

  function resetForm() {
    setCourseId(lockedCourseId ?? teacher?.courses[0]?.id ?? "");
    setTitle("");
    setAssessmentKind("examination");
    setDescription("");
    setDurationText("60");
    setQuestionsText("20");
    setStartAt("");
    setEndAt("");
    setSecurity(teacher ? loadTeacherSecurityDefaults(teacher.teacherId) : { ...DEFAULT_EXAM_SECURITY });
    setStep(1);
    setEditingId(null);
  }

  function openBuilder() {
    if (!teacher?.courses.length) {
      toast.error("No courses assigned");
      return;
    }
    resetForm();
    setCourseId(lockedCourseId ?? teacher.courses[0].id);
    setBuilder(true);
  }

  function openEdit(e: ExamRow) {
    if (e.status !== "draft" && e.status !== "changes_requested") {
      toast.error("Only draft or changes-requested exams can be edited");
      return;
    }
    const instructions = stripInternalMarkers(e.description);
    const meta = parseExamMeta(e.description);
    const sec =
      parseSecurityFromDescription(e.description) ??
      (teacher ? loadTeacherSecurityDefaults(teacher.teacherId) : { ...DEFAULT_EXAM_SECURITY });
    setEditingId(e.id);
    setCourseId(e.course_id ?? "");
    setTitle(e.title);
    setAssessmentKind((meta.assessmentKind as AssessmentKind) || "examination");
    setDescription(instructions);
    setDurationText(String(e.duration_minutes || 60));
    setQuestionsText(String(meta.questionsToAnswer ?? 20));
    setSelectedQuestionIds(Array.isArray((meta as { selectedQuestionIds?: string[] }).selectedQuestionIds) ? (meta as { selectedQuestionIds?: string[] }).selectedQuestionIds! : []);
    setCarryoverIds(Array.isArray((meta as { selectedCarryoverStudentIds?: string[] }).selectedCarryoverStudentIds) ? (meta as { selectedCarryoverStudentIds?: string[] }).selectedCarryoverStudentIds! : []);
    setStartAt(toLocalInput(e.scheduled_start));
    setEndAt(toLocalInput(e.scheduled_end));
    setSecurity(normalizeSecuritySettings(sec));
    setStep(1);
    setBuilder(true);
  }

  function onStartChange(v: string) {
    setStartAt(v);
    // End time stays blank until teacher sets it explicitly
  }

  function onDurationTextChange(raw: string) {
    if (raw === "" || /^\d+$/.test(raw)) {
      setDurationText(raw);
    }
  }

  function onQuestionsTextChange(raw: string) {
    if (raw === "" || /^\d+$/.test(raw)) setQuestionsText(raw);
  }

  function toggleSec<K extends keyof ExamSecuritySettings>(key: K, value: ExamSecuritySettings[K]) {
    setSecurity((s) => normalizeSecuritySettings({ ...s, [key]: value }));
  }

  function setScreenMode(mode: ScreenShareMode) {
    setSecurity((s) =>
      normalizeSecuritySettings({
        ...s,
        screenShareMode: mode,
        requireScreenShare: mode === "required",
      }),
    );
  }

  function validateStep(s: number, forSubmit = false) {
    if (s === 1) {
      if (!courseId || !teacher?.courseIds.includes(courseId)) {
        toast.error("Select an assigned course");
        return false;
      }
      if (!title.trim()) {
        toast.error("Title is required");
        return false;
      }
      if (!durationText || durationMinutes < 5) {
        toast.error("Duration must be at least 5 minutes");
        return false;
      }
      if (!questionsText || questionsToAnswer < 1) {
        toast.error("Questions to answer must be at least 1");
        return false;
      }
      if (selectedQuestionIds.length > 0 && questionsToAnswer > selectedQuestionIds.length) {
        toast.error(`You selected only ${selectedQuestionIds.length} question(s). Lower "Students must answer".`);
        return false;
      }
      if (forSubmit && selectedQuestionIds.length === 0 && bankCount > 0 && questionsToAnswer > bankCount) {
        toast.error(`Bank has only ${bankCount} active questions.`);
        return false;
      }
    }
    if (s === 2 && startAt && !endAt) {
      toast.error("Set the exam end date and time");
      return false;
    }
    if (s === 2 && startAt && endAt && new Date(endAt) <= new Date(startAt)) {
      toast.error("End must be after start");
      return false;
    }
    return true;
  }

  async function persist(status: "draft" | "pending_approval") {
    if (!teacher || !session) return;
    if (!validateStep(1, status === "pending_approval")) return;
    setBusy(true);
    try {
      const plain = stripInternalMarkers(description.trim() || "");
      const sec = normalizeSecuritySettings(security);
      const metaBlob = `[[D4_EXAM_META]]${JSON.stringify({ questionsToAnswer, assessmentKind, selectedQuestionIds: selectedQuestionIds.length ? selectedQuestionIds : undefined, selectedCarryoverStudentIds: carryoverIds.length ? carryoverIds : undefined })}`;
      const secBlob = `[[D4_SECURITY_JSON]]${JSON.stringify(sec)}`;
      let desc: string | null = [plain, metaBlob, secBlob].filter(Boolean).join("\n") || null;
      const computedEnd = endAt || ""; // Teacher must set end time explicitly — do not auto-fill
      const payload = {
        school_id: teacher.schoolId,
        course_id: courseId,
        created_by: session.userId,
        title: title.trim(),
        description: desc,
        duration_minutes: durationMinutes,
        scheduled_start: startAt ? new Date(startAt).toISOString() : null,
        scheduled_end: computedEnd ? new Date(computedEnd).toISOString() : null,
        status,
        questions_to_answer: questionsToAnswer > 0 ? questionsToAnswer : null,
      };
      let examId = editingId;
      if (editingId) {
        const { error } = await supabase
          .from("examinations")
          .update(payload as never)
          .eq("id", editingId)
          .eq("school_id", teacher.schoolId);
        if (error) throw error;
      } else {
        const { data: created, error } = await supabase
          .from("examinations")
          .insert(payload as never)
          .select("id")
          .single();
        if (error) throw error;
        if (!created?.id) throw new Error("Examination was not created");
        examId = created.id as string;
      }
      if (examId) await tryUpsertExamSettings(examId, sec, questionsToAnswer);
      if (examId && courseId) {
        try {
          await ensureExamQuestionsLinked({
            examId,
            courseId,
            schoolId: teacher.schoolId,
            maxQuestions: questionsToAnswer > 0 ? questionsToAnswer : null,
            questionIds: selectedQuestionIds.length ? selectedQuestionIds : null,
          });
        } catch (linkErr) {
          console.warn("[teacher] ensureExamQuestionsLinked", linkErr);
        }
      }
      if (status === "pending_approval" && examId) {
        const course = teacher.courses.find((c) => c.id === courseId);
        void notifyOfficersExamSubmitted({
          schoolId: teacher.schoolId,
          teacherName: session.fullName ?? "Teacher",
          examId,
          examTitle: title.trim(),
          courseLabel: course?.code,
        });
      }
      toast.success(status === "draft" ? "Draft saved" : "Submitted for officer approval");
      setBuilder(false);
      setEditingId(null);
      await qc.invalidateQueries({ queryKey: ["teacher-exams"] });
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not save examination");
    } finally {
      setBusy(false);
    }
  }

  async function submitExisting(id: string) {
    if (!teacher || !session) return;
    try {
      const { data: existing } = await supabase
        .from("examinations")
        .select("description, title, course_id, courses(code)")
        .eq("id", id)
        .maybeSingle();
      const row = existing as {
        description?: string;
        title?: string;
        course_id?: string | null;
        courses?: { code?: string } | null;
      } | null;
      let desc = row?.description ?? null;
      const meta = parseExamMeta(desc);
      const sec = normalizeSecuritySettings(
        parseSecurityFromDescription(desc) ?? loadTeacherSecurityDefaults(teacher.teacherId),
      );
      const plain = stripInternalMarkers(desc);
      const metaBlob = `[[D4_EXAM_META]]${JSON.stringify({ ...meta, assessmentKind: meta.assessmentKind || "examination" })}`;
      const secBlob = `[[D4_SECURITY_JSON]]${JSON.stringify(sec)}`;
      desc = [plain, metaBlob, secBlob].filter(Boolean).join("\n") || null;
      const { error } = await supabase
        .from("examinations")
        .update({
          status: "pending_approval",
          description: desc,
          questions_to_answer:
            meta.questionsToAnswer && meta.questionsToAnswer > 0
              ? meta.questionsToAnswer
              : null,
        } as never)
        .eq("id", id)
        .eq("school_id", teacher.schoolId);
      if (error) throw error;
      await tryUpsertExamSettings(id, sec, meta.questionsToAnswer);
      if (row?.course_id) {
        try {
          await ensureExamQuestionsLinked({
            examId: id,
            courseId: row.course_id,
            schoolId: teacher.schoolId,
            maxQuestions: (meta.questionsToAnswer && meta.questionsToAnswer > 0) ? meta.questionsToAnswer : null,
            questionIds: Array.isArray((meta as { selectedQuestionIds?: string[] }).selectedQuestionIds)
              ? (meta as { selectedQuestionIds?: string[] }).selectedQuestionIds
              : null,
          });
        } catch (linkErr) {
          console.warn("[teacher] ensureExamQuestionsLinked", linkErr);
        }
      }
      void notifyOfficersExamSubmitted({
        schoolId: teacher.schoolId,
        teacherName: session.fullName ?? "Teacher",
        examId: id,
        examTitle: row?.title ?? "Examination",
        courseLabel: row?.courses?.code,
      });
      toast.success("Submitted for officer approval");
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not submit");
    }
  }

  async function cancelSubmit(id: string) {
    if (!teacher) return;
    if (!confirm("Withdraw this examination from officer review?")) return;
    try {
      const { error } = await supabase
        .from("examinations")
        .update({ status: "draft" } as never)
        .eq("id", id)
        .eq("school_id", teacher.schoolId)
        .in("status", ["pending_approval", "changes_requested"]);
      if (error) throw error;
      toast.success("Submission cancelled");
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not cancel");
    }
  }

  async function deleteExam(id: string) {
    if (!teacher) return;
    if (!confirm("Delete this draft permanently?")) return;
    try {
      const { error } = await supabase
        .from("examinations")
        .delete()
        .eq("id", id)
        .eq("school_id", teacher.schoolId)
        .in("status", ["draft", "changes_requested", "rejected"]);
      if (error) throw error;
      toast.success("Examination deleted");
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not delete");
    }
  }

  if (tLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!teacher) return <EmptyState title="Teacher profile not found" description="Contact School Admin." />;

  if (builder) {
    const steps = [
      { id: 1, label: "Basic info" },
      { id: 2, label: "Schedule" },
      { id: 3, label: "Security" },
      { id: 4, label: "Review & submit" },
    ];
    const shareMode = resolveScreenShareMode(security);

    return (
      <>
        <PageHeader
          title={editingId ? "Edit examination" : "Create examination"}
          description="Configure paper size, schedule, and proctoring (camera / screen share)."
          actions={
            <Button variant="outline" onClick={() => { setBuilder(false); setEditingId(null); }}>Cancel</Button>
          }
        />
        <nav className="mb-6 flex flex-wrap gap-2">
          {steps.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => s.id < step && setStep(s.id)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-semibold",
                step === s.id
                  ? "border-primary bg-primary text-white"
                  : step > s.id
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-slate-200 bg-white text-slate-500",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <SectionCard>
          {step === 1 && (
            <div className="mx-auto max-w-xl space-y-4">
              <div className="space-y-2">
                <Label className="font-semibold">Assigned course</Label>
                {lockedCourse ? (
                  <p className="rounded-lg border bg-slate-50 px-3 py-2 text-sm font-semibold">{lockedCourse.code} — {lockedCourse.name}</p>
                ) : (
                  <Select value={courseId} onValueChange={(v) => { setCourseId(v); setSelectedQuestionIds([]); }}>
                    <SelectTrigger><SelectValue placeholder="Select course" /></SelectTrigger>
                    <SelectContent>
                      {teacher.courses.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-2">
                <Label className="font-semibold">Type</Label>
                <Select value={assessmentKind} onValueChange={(v) => setAssessmentKind(v as AssessmentKind)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="examination">Examination</SelectItem>
                    <SelectItem value="test">Test</SelectItem>
                    <SelectItem value="assignment">Assignment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(carryoversQ.data?.length ?? 0) > 0 ? (
                <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                  <Label className="font-semibold text-amber-900">Carryover students</Label>
                  <p className="text-xs text-amber-800">
                    Approved carryovers for this course. Tick who should sit this paper. Results still show each student&apos;s current level.
                  </p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto">
                    {(carryoversQ.data ?? []).map((co) => {
                      const st = co.students;
                      const name = (st?.full_name || "Student").trim();
                      const mat = st?.matric_number || st?.student_id || "—";
                      const lvl =
                        st?.levels && !Array.isArray(st.levels) ? st.levels?.name : "";
                      const on = carryoverIds.includes(co.student_id);
                      return (
                        <li key={co.id}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/80">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => {
                                setCarryoverIds((prev) =>
                                  on
                                    ? prev.filter((id) => id !== co.student_id)
                                    : [...prev, co.student_id],
                                );
                              }}
                            />
                            <span>
                              {name} · {mat}
                              {lvl ? ` · ${lvl}` : ""}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : courseId ? (
                <p className="text-xs text-slate-500">
                  No approved carryover students for this course. School Admin / Officer can add them under Carryover Students.
                </p>
              ) : null}

              <div className="space-y-2">
                <Label className="font-semibold">Title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label className="font-semibold">Instructions</Label>
                <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-semibold">Duration (minutes)</Label>
                  <Input type="text" inputMode="numeric" value={durationText} onChange={(e) => onDurationTextChange(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label className="font-semibold">Students must answer</Label>
                  <Input type="text" inputMode="numeric" value={questionsText} onChange={(e) => onQuestionsTextChange(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Bank: <strong>{bankCount}</strong> questions
                {selectedQuestionIds.length > 0 ? (
                  <> · Selected for this paper: <strong>{selectedQuestionIds.length}</strong></>
                ) : null}
              </p>
              {courseId && bankList.length > 0 ? (
                <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label className="font-semibold">Pick questions for this exam (optional)</Label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="text-xs font-semibold text-primary hover:underline"
                        onClick={() => setSelectedQuestionIds(bankList.map((q) => q.id))}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className="text-xs font-semibold text-slate-500 hover:underline"
                        onClick={() => setSelectedQuestionIds([])}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Select which bank items belong to this paper. Then set &quot;Students must answer&quot; to how many each student gets (drawn randomly from your selection). Leave empty to use the full bank.
                  </p>
                  <ul className="max-h-48 space-y-1 overflow-y-auto overscroll-contain pr-1">
                    {bankList.map((q, i) => {
                      const on = selectedQuestionIds.includes(q.id);
                      return (
                        <li key={q.id}>
                          <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 accent-primary"
                              checked={on}
                              onChange={() => {
                                setSelectedQuestionIds((prev) =>
                                  on ? prev.filter((x) => x !== q.id) : [...prev, q.id],
                                );
                              }}
                            />
                            <span className="min-w-0 text-xs text-slate-800">
                              <span className="font-bold text-slate-500">{i + 1}.</span>{" "}
                              <span className="line-clamp-2">{q.question_text || "Question"}</span>
                              <span className="mt-0.5 block text-[10px] font-medium uppercase text-slate-400">
                                {q.question_type || "mcq"} · {q.marks ?? 1} mark(s)
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
          {step === 2 && (
            <div className="mx-auto max-w-md space-y-4">
              <D4DateTimeField label="Start time" value={startAt} onChange={onStartChange} required />
              <D4DateTimeField label="End time" value={endAt} onChange={setEndAt} required />
            </div>
          )}
          {step === 3 && (
            <div className="mx-auto max-w-xl space-y-3">
              <SecToggle label="Fullscreen lockdown" hint="Candidate must stay in fullscreen" checked={security.fullscreen} onChange={(v) => toggleSec("fullscreen", v)} />
              <SecToggle label="Tab & focus monitoring" hint="Detect leaving the exam window" checked={security.tabMonitoring} onChange={(v) => toggleSec("tabMonitoring", v)} />
              <div className="space-y-2 rounded-xl border border-slate-200 px-4 py-3">
                <Label className="font-semibold">Max tab switches</Label>
                <Input type="number" min={1} max={20} value={security.maxTabSwitches} disabled={!security.tabMonitoring} onChange={(e) => toggleSec("maxTabSwitches", Number(e.target.value) || 5)} />
              </div>
              <SecToggle label="Block copy / paste" hint="Disable clipboard" checked={security.blockCopyPaste} onChange={(v) => toggleSec("blockCopyPaste", v)} />
              <SecToggle label="Randomise questions" hint="Random subset per student" checked={security.randomizeQuestions} onChange={(v) => toggleSec("randomizeQuestions", v)} />
              <SecToggle label="Randomise options" hint="MCQ choices shuffled" checked={security.randomizeOptions} onChange={(v) => toggleSec("randomizeOptions", v)} />
              <p className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">Proctoring</p>
              <SecToggle label="Camera monitoring" hint="Require camera during the exam" checked={security.requireCamera} onChange={(v) => toggleSec("requireCamera", v)} />
              <SecToggle label="Face detection" hint="Warn on 0 or 2+ faces (needs camera)" checked={security.faceDetection} onChange={(v) => toggleSec("faceDetection", v)} />
              <div className="space-y-2 rounded-xl border border-slate-200 px-4 py-3">
                <Label className="font-semibold">Maximum face warnings</Label>
                <Input type="number" min={1} max={50} value={security.maxFaceWarnings ?? 5} disabled={!security.faceDetection} onChange={(e) => toggleSec("maxFaceWarnings", Number(e.target.value) || 5)} />
                <p className="text-xs text-slate-500">Face monitoring only warns the student (top banner). Strong consequences use TAB VIOLATION below.</p>
              </div>
              <p className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">TAB VIOLATION</p>
              <div className="space-y-2 rounded-xl border border-slate-200 px-4 py-3">
                <Label className="font-semibold">TAB VIOLATION limit</Label>
                <Input type="number" min={1} max={20} value={security.maxTabSwitches} disabled={!security.tabMonitoring} onChange={(e) => toggleSec("maxTabSwitches", Number(e.target.value) || 5)} />
                <p className="text-xs text-slate-500">Before the limit: warning / flag only. At the limit: the consequence below.</p>
              </div>
              <div className="space-y-2 rounded-xl border border-slate-200 px-4 py-3">
                <Label className="font-semibold">TAB VIOLATION consequence (at limit)</Label>
                <Select value={security.thresholdAction || "flag"} onValueChange={(v) => toggleSec("thresholdAction", v as ExamSecuritySettings["thresholdAction"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="warn">Warning only</SelectItem>
                    <SelectItem value="flag">Flag for review</SelectItem>
                    <SelectItem value="pause">Pause exam</SelectItem>
                    <SelectItem value="auto_submit">Auto-submit exam</SelectItem>
                    <SelectItem value="terminate">Terminate exam</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {security.thresholdAction === "pause" && (
      <div className="space-y-2 rounded-xl border border-slate-200 px-4 py-3">
        <Label className="font-semibold">Pause duration</Label>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-500">Minutes</p>
            <Input
              type="number"
              min={0}
              max={60}
              value={Math.floor((security.pauseDurationSeconds ?? 300) / 60)}
              onChange={(e) => {
                const mins = Math.max(0, Math.min(60, Number(e.target.value) || 0));
                const secs = (security.pauseDurationSeconds ?? 300) % 60;
                toggleSec("pauseDurationSeconds", Math.max(30, mins * 60 + secs));
              }}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-500">Seconds</p>
            <Input
              type="number"
              min={0}
              max={59}
              step={5}
              value={(security.pauseDurationSeconds ?? 300) % 60}
              onChange={(e) => {
                const secs = Math.max(0, Math.min(59, Number(e.target.value) || 0));
                const mins = Math.floor((security.pauseDurationSeconds ?? 300) / 60);
                toggleSec("pauseDurationSeconds", Math.max(30, mins * 60 + secs));
              }}
            />
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Student must wait{" "}
          <strong>
            {Math.floor((security.pauseDurationSeconds ?? 300) / 60)} min{" "}
            {(security.pauseDurationSeconds ?? 300) % 60} sec
          </strong>{" "}
          before continuing (minimum 30 seconds). Set any time, e.g. 2 min 30 sec.
        </p>
      </div>
    )}
              <div className="space-y-2 rounded-xl border border-slate-200 px-4 py-3">
                <Label className="font-semibold">Screen sharing</Label>
                <p className="text-xs text-slate-500">Required blocks mobile/unsupported browsers. Optional allows continue without share.</p>
                <Select value={shareMode} onValueChange={(v) => setScreenMode(v as ScreenShareMode)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disabled">Disabled</SelectItem>
                    <SelectItem value="optional">Optional</SelectItem>
                    <SelectItem value="required">Required (desktop browsers)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <SecToggle label="Require microphone" hint="Optional audio permission" checked={security.requireMicrophone} onChange={(v) => toggleSec("requireMicrophone", v)} />
              <div className="space-y-2 rounded-xl border border-slate-200 px-4 py-3">
                <Label className="font-semibold">When can students see results?</Label>
                <Select value={security.resultVisibility} onValueChange={(v) => toggleSec("resultVisibility", v as ExamSecuritySettings["resultVisibility"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="immediate">Immediately after submit</SelectItem>
                    <SelectItem value="after_officer_release">After officer releases</SelectItem>
                    <SelectItem value="after_marking">After marking</SelectItem>
                    <SelectItem value="after_exam_closes">After exam closes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <SecToggle
                label="Allow calculator during examination"
                hint="Students get a floating calculator button in the CBT session"
                checked={Boolean(security.allowCalculator)}
                onChange={(v) => toggleSec("allowCalculator", v)}
              />
              {security.allowCalculator && (
                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <Label className="font-semibold">Calculator type</Label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
                      <input
                        type="radio"
                        name="calc-type"
                        className="h-4 w-4 accent-primary"
                        checked={security.calculatorType !== "scientific"}
                        onChange={() => toggleSec("calculatorType", "basic")}
                      />
                      Basic Calculator
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
                      <input
                        type="radio"
                        name="calc-type"
                        className="h-4 w-4 accent-primary"
                        checked={security.calculatorType === "scientific"}
                        onChange={() => toggleSec("calculatorType", "scientific")}
                      />
                      Scientific Calculator
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}
          {step === 4 && (
            <div className="mx-auto max-w-xl space-y-3 text-sm">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="font-extrabold text-slate-900">{title || "Untitled"}</p>
                <p className="mt-2 text-xs text-slate-600">{assessmentKindLabel(assessmentKind)} · {questionsToAnswer} questions · {durationMinutes} min</p>
              </div>
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
                <p className="mb-2 flex items-center gap-2 text-sm font-bold"><ShieldCheck className="h-4 w-4 text-primary" />Exam security</p>
                <ul className="space-y-1 text-xs text-slate-700">{securitySummaryLines(security).map((line) => (<li key={line}>• {line}</li>))}</ul>
              </div>
            </div>
          )}
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <Button variant="outline" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Back
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void persist("draft")}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />} Save draft
              </Button>
              {step < 4 ? (
                <Button className="font-semibold" onClick={() => { if (validateStep(step)) setStep((s) => s + 1); }}>
                  Continue <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              ) : (
                <Button className="font-semibold" disabled={busy} onClick={() => void persist("pending_approval")}>
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />} Submit for approval
                </Button>
              )}
            </div>
          </div>
        </SectionCard>
      </>
    );
  }

  const exams = listQ.data ?? [];

  return (
    <>
      <PageHeader
        title={lockedCourse ? `Exams · ${lockedCourse.code}` : "Examinations"}
        description="Create exam → Select questions → security → submit for officer"
        actions={
          <Button className="font-semibold" onClick={openBuilder} disabled={!teacher.courses.length}>
            <Plus className="mr-1.5 h-4 w-4" /> Create examination
          </Button>
        }
      />
      {!teacher.courses.length ? (
        <EmptyState title="No courses assigned" description="School Admin must assign courses first." />
      ) : (
        <SectionCard title="Your examinations">
          {listQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : exams.length === 0 ? (
            <EmptyState title="No examinations yet" description="Create one for this course." actionLabel="Create examination" onAction={openBuilder} />
          ) : (
            <ul className="space-y-3">
              {exams.map((e) => {
                const meta = parseExamMeta(e.description);
                const feedback = extractOfficerFeedback(e.description);
                const canEdit = e.status === "draft" || e.status === "changes_requested";
                const canDelete = ["draft", "changes_requested", "rejected"].includes(e.status);
                const borderTone =
                  e.status === "rejected"
                    ? "border-red-200 bg-red-50/40"
                    : e.status === "changes_requested"
                      ? "border-amber-200 bg-amber-50/40"
                      : "border-slate-100";
                return (
                  <li key={e.id} className={`rounded-xl border p-3 ${borderTone}`}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-900">{e.title}</p>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{assessmentKindLabel(meta.assessmentKind)}</p>
                        <p className="text-xs text-slate-500">
                          {e.courses?.code ?? "—"} · {e.duration_minutes} min
                          {meta.questionsToAnswer ? ` · students answer ${meta.questionsToAnswer}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={String(e.status).replaceAll("_", " ")} />
                        <Button size="sm" variant="outline" className="font-semibold" asChild>
                          <Link to="/teacher/exam-paper/$id" params={{ id: e.id }}>
                            <ListChecks className="mr-1 h-3.5 w-3.5" /> Select questions
                          </Link>
                        </Button>
                        {canEdit && (
                          <Button size="sm" variant="outline" className="font-semibold" onClick={() => openEdit(e)}>
                            <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                          </Button>
                        )}
                        {e.status === "draft" && (
                          <Button size="sm" className="font-semibold" onClick={() => void submitExisting(e.id)}>Submit</Button>
                        )}
                        {(e.status === "pending_approval" || e.status === "changes_requested") && (
                          <Button size="sm" variant="outline" className="font-semibold" onClick={() => void cancelSubmit(e.id)}>
                            <Undo2 className="mr-1 h-3.5 w-3.5" /> Cancel
                          </Button>
                        )}
                        {canDelete && (
                          <Button size="sm" variant="outline" className="font-semibold text-red-600" onClick={() => void deleteExam(e.id)}>
                            <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                          </Button>
                        )}
                      </div>
                    </div>
                    {feedback.message && (
                      <div
                        className={
                          feedback.kind === "rejected"
                            ? "mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
                            : feedback.kind === "changes"
                              ? "mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                              : "mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
                        }
                      >
                        <p className="font-bold">
                          {feedback.kind === "rejected"
                            ? "Officer rejection reason"
                            : feedback.kind === "changes"
                              ? "Officer requested changes"
                              : "Officer note"}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap">{feedback.message}</p>
                        {(e.status === "changes_requested" || e.status === "rejected") && (
                          <p className="mt-1 text-[11px] font-semibold opacity-80">
                            Use Edit to update the exam, then Submit again for approval.
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      )}
    </>
  );
}

function SecToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3">
      <span>
        <span className="block text-sm font-semibold text-slate-800">{label}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{hint}</span>
      </span>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
    </label>
  );
}
