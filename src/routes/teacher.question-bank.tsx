import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Upload,
  Download,
  Search,
  Loader2,
  Trash2,
  Pencil,
  FileQuestion,
  X,
  Save,
} from "lucide-react";
import {
  PageHeader,
  SectionCard,
  EmptyState,
  StatusBadge,
  StatCard,
} from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useTeacherContext } from "@/lib/teacher";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  downloadCsvTemplate,
  parseImportFile,
  type DraftQuestion,
  validateAll,
} from "@/lib/question-import";
import { ImportFooter } from "@/components/question-bank/ImportFooter";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/teacher/question-bank")({
  validateSearch: (search: Record<string, unknown>) => ({
    course: typeof search.course === "string" ? search.course : undefined,
  } as { course?: string }),
  head: () => ({
    meta: [
      { title: "Question Bank — D4EXAM" },
      {
        name: "description",
        content: "Create, import, edit and manage questions for your assigned courses.",
      },
    ],
  }),
  component: QuestionBankPage,
});

type QuestionRow = {
  id: string;
  question_text: string;
  question_type: string;
  marks: number;
  status: string;
  course_id: string | null;
  correct_answer: string | null;
  explanation?: string | null;
  options?: unknown;
  created_at: string;
  courses: { code: string; name: string } | null;
};

type Mode = "list" | "form" | "import";

function decodeOptionsFromJson(options: unknown): {
  a: string; b: string; c: string; d: string; note: string;
} | null {
  if (!options) return null;
  let arr: unknown = options;
  if (typeof options === "string") {
    try { arr = JSON.parse(options); } catch { return null; }
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  const map: Record<string, string> = { A: "", B: "", C: "", D: "" };
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = String(o.key ?? o.option_key ?? "").trim().toUpperCase();
    const text = String(o.text ?? o.option_text ?? "").trim();
    if (key in map && text) map[key] = text;
  }
  if (!map.A && !map.B) return null;
  return { a: map.A, b: map.B, c: map.C, d: map.D, note: "" };
}

function decodeOptions(
  explanation: string | null | undefined,
  options?: unknown,
): { a: string; b: string; c: string; d: string; note: string } {
  const fromJson = decodeOptionsFromJson(options);
  if (fromJson) return fromJson;
  if (!explanation) return { a: "", b: "", c: "", d: "", note: "" };
  const lines = explanation.split("\n");
  const optLine = lines.find((l) => l.startsWith("OPTIONS::"));
  const note = lines.filter((l) => !l.startsWith("OPTIONS::")).join("\n").trim();
  if (!optLine) return { a: "", b: "", c: "", d: "", note: explanation };
  const body = optLine.slice("OPTIONS::".length);
  const map: Record<string, string> = { A: "", B: "", C: "", D: "" };
  for (const part of body.split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const k = part.slice(0, eq).trim().toUpperCase();
      const v = part.slice(eq + 1);
      if (k in map) map[k] = v;
    }
  }
  return { a: map.A, b: map.B, c: map.C, d: map.D, note };
}

function buildOptionsJson(
  a: string, b: string, c: string, d: string, correct: string,
): { key: string; text: string; is_correct: boolean }[] {
  const ck = correct.trim().toUpperCase();
  return ([
    ["A", a], ["B", b], ["C", c], ["D", d],
  ] as [string, string][])
    .filter(([, t]) => t.trim())
    .map(([key, text]) => ({ key, text: text.trim(), is_correct: key === ck }));
}

function QuestionBankPage() {
  const { course: courseFromUrl } = Route.useSearch();
  const { data: teacher, isLoading: tLoading } = useTeacherContext();
  const { data: session } = useSessionUser();
  const qc = useQueryClient();

  const lockedCourseId =
    courseFromUrl && teacher?.courseIds.includes(courseFromUrl) ? courseFromUrl : null;
  const lockedCourse = teacher?.courses.find((c) => c.id === lockedCourseId) ?? null;

  const [mode, setMode] = useState<Mode>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterCourse, setFilterCourse] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const [courseId, setCourseId] = useState("");
  const [qText, setQText] = useState("");
  const [qType, setQType] = useState("mcq");
  const [marks, setMarks] = useState(1);
  const [optionA, setOptionA] = useState("");
  const [optionB, setOptionB] = useState("");
  const [optionC, setOptionC] = useState("");
  const [optionD, setOptionD] = useState("");
  const [correct, setCorrect] = useState("A");
  const [explanation, setExplanation] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const [importCourseId, setImportCourseId] = useState("");
  const [drafts, setDrafts] = useState<DraftQuestion[]>([]);
  const [importBusy, setImportBusy] = useState(false);

  const listQ = useQuery({
    queryKey: ["teacher-questions", teacher?.schoolId, teacher?.courseIds, lockedCourseId],
    enabled: Boolean(teacher?.schoolId && teacher.courseIds.length),
    queryFn: async () => {
      if (!teacher) return [] as QuestionRow[];
      const ids = lockedCourseId ? [lockedCourseId] : teacher.courseIds;
      const { data, error } = await supabase
        .from("questions")
        .select(
          "id, question_text, question_type, marks, status, course_id, correct_answer, options, created_at, courses(code, name)",
        )
        .eq("school_id", teacher.schoolId)
        .in("course_id", ids)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as QuestionRow[];
    },
  });

  const questions = listQ.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return questions.filter((row) => {
      if (filterCourse !== "all" && row.course_id !== filterCourse) return false;
      if (filterType !== "all" && row.question_type !== filterType) return false;
      if (!q) return true;
      return (
        row.question_text.toLowerCase().includes(q) ||
        (row.courses?.code ?? "").toLowerCase().includes(q)
      );
    });
  }, [questions, search, filterCourse, filterType]);

  const stats = useMemo(() => {
    const total = questions.length;
    const mcq = questions.filter((x) => x.question_type === "mcq").length;
    const active = questions.filter((x) => x.status === "active").length;
    return { total, mcq, active };
  }, [questions]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllFiltered() {
    setSelectedIds(new Set(filtered.map((q) => q.id)));
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function bulkDelete() {
    if (!teacher || selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} selected question(s)? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const { error } = await supabase.from("questions").delete().in("id", ids).eq("school_id", teacher.schoolId);
      if (error) throw error;
      toast.success(`Deleted ${ids.length} question(s)`);
      clearSelection();
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not delete");
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkSetStatus(status: string) {
    if (!teacher || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const { error } = await supabase.from("questions").update({ status } as never).in("id", ids).eq("school_id", teacher.schoolId);
      if (error) throw error;
      toast.success(`Updated ${ids.length} question(s) to ${status}`);
      clearSelection();
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not update");
    } finally {
      setBulkBusy(false);
    }
  }

  function resetForm() {
    setEditingId(null);
    setCourseId(lockedCourseId ?? teacher?.courses[0]?.id ?? "");
    setQText(""); setQType("mcq"); setMarks(1);
    setOptionA(""); setOptionB(""); setOptionC(""); setOptionD("");
    setCorrect("A"); setExplanation("");
  }

  function openCreate() {
    if (!teacher?.courses.length) { toast.error("No courses assigned"); return; }
    resetForm();
    setCourseId(lockedCourseId ?? teacher.courses[0].id);
    setMode("form");
  }

  function openEdit(q: QuestionRow) {
    const opts = decodeOptions(q.explanation, q.options);
    setEditingId(q.id);
    setCourseId(q.course_id ?? lockedCourseId ?? teacher?.courses[0]?.id ?? "");
    setQText(q.question_text);
    setQType(q.question_type || "mcq");
    setMarks(q.marks || 1);
    setOptionA(opts.a); setOptionB(opts.b); setOptionC(opts.c); setOptionD(opts.d);
    setCorrect(q.correct_answer || "A");
    setExplanation(opts.note);
    setMode("form");
  }

  function openImport() {
    if (!teacher?.courses.length) { toast.error("No courses assigned"); return; }
    setImportCourseId(lockedCourseId ?? teacher.courses[0].id);
    setDrafts([]);
    setMode("import");
  }

  async function saveQuestion() {
    if (!teacher || !session) return;
    if (!courseId || !teacher.courseIds.includes(courseId)) { toast.error("Select an assigned course"); return; }
    if (!qText.trim()) { toast.error("Question text is required"); return; }
    if (marks < 1) { toast.error("Marks must be at least 1"); return; }
    const needsOpts = qType === "mcq" || qType === "true_false";
    if (needsOpts) {
      const a = qType === "true_false" ? optionA || "True" : optionA;
      const b = qType === "true_false" ? optionB || "False" : optionB;
      if (!a.trim() || !b.trim()) { toast.error("Provide at least Option A and B"); return; }
      if (!["A", "B", "C", "D"].includes(correct.toUpperCase())) { toast.error("Correct answer must be A, B, C or D"); return; }
    }
    setBusy(true);
    try {
      const optsJson =
        qType === "true_false"
          ? buildOptionsJson(optionA || "True", optionB || "False", "", "", correct)
          : buildOptionsJson(optionA, optionB, optionC, optionD, correct);
      const payload = {
        course_id: courseId,
        question_text: qText.trim(),
        question_type: qType,
        marks,
        status: "active",
        correct_answer: correct.trim() || null,
        options: optsJson,
      };
      if (editingId) {
        const { error } = await supabase.from("questions").update(payload as never).eq("id", editingId).eq("school_id", teacher.schoolId);
        if (error) throw error;
        toast.success("Question updated");
      } else {
        const { error } = await supabase.from("questions").insert({ ...payload, school_id: teacher.schoolId, created_by: session.userId } as never);
        if (error) throw error;
        toast.success("Question saved");
      }
      setMode("list");
      resetForm();
      await qc.invalidateQueries({ queryKey: ["teacher-questions"] });
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not save question");
    } finally {
      setBusy(false);
    }
  }

  async function deleteQuestion(id: string) {
    if (!teacher) return;
    if (!confirm("Delete this question? This cannot be undone.")) return;
    try {
      const { error } = await supabase.from("questions").delete().eq("id", id).eq("school_id", teacher.schoolId);
      if (error) throw error;
      toast.success("Question deleted");
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not delete");
    }
  }

  async function onPickFile(file: File | null) {
    if (!file) return;
    setImportBusy(true);
    try {
      const rows = await parseImportFile(file);
      setDrafts(validateAll(rows));
      toast.success(`Parsed ${rows.length} question(s)`);
    } catch (err) {
      toast.error((err as Error).message || "Import failed");
      setDrafts([]);
    } finally {
      setImportBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveImport() {
    if (!teacher || !session) return;
    if (!importCourseId || !teacher.courseIds.includes(importCourseId)) { toast.error("Select an assigned course"); return; }
    const selected = drafts.filter((d) => d.selected && d.errors.length === 0);
    if (!selected.length) { toast.error("Select at least one valid question"); return; }
    setImportBusy(true);
    try {
      const rows = selected.map((d) => ({
        school_id: teacher.schoolId,
        course_id: importCourseId,
        created_by: session.userId,
        question_text: d.question_text.trim(),
        question_type: d.question_type,
        marks: d.marks,
        status: "active",
        correct_answer: d.correct_answer.trim() || null,
        options: buildOptionsJson(d.option_a, d.option_b, d.option_c, d.option_d, d.correct_answer),
      }));
      const { error } = await supabase.from("questions").insert(rows as never);
      if (error) throw error;
      toast.success(`Imported ${rows.length} question(s)`);
      setMode("list");
      setDrafts([]);
      await qc.invalidateQueries({ queryKey: ["teacher-questions"] });
      await listQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not import");
    } finally {
      setImportBusy(false);
    }
  }

  const importSelectedCount = drafts.filter((d) => d.selected).length;

  if (tLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!teacher) {
    return <EmptyState title="Teacher profile not found" description="Contact School Admin." />;
  }

  if (mode === "form") {
    return (
      <>
        <PageHeader
          title={editingId ? "Edit question" : "Add question"}
          description={lockedCourse ? `For ${lockedCourse.code} — ${lockedCourse.name}` : editingId ? "Update this question and save your changes" : "Add a single question to your bank"}
          actions={
            <Button variant="outline" onClick={() => { resetForm(); setMode("list"); }}>
              <X className="mr-1.5 h-4 w-4" /> Cancel
            </Button>
          }
        />
        <SectionCard>
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="space-y-2">
              <Label className="font-semibold">Course</Label>
              {lockedCourse ? (
                <p className="rounded-lg border bg-slate-50 px-3 py-2 text-sm font-semibold">{lockedCourse.code} — {lockedCourse.name}</p>
              ) : (
                <Select value={courseId} onValueChange={setCourseId}>
                  <SelectTrigger><SelectValue placeholder="Select course" /></SelectTrigger>
                  <SelectContent>
                    {teacher.courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="font-semibold">Type</Label>
                <Select value={qType} onValueChange={setQType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mcq">MCQ</SelectItem>
                    <SelectItem value="true_false">True / False</SelectItem>
                    <SelectItem value="short_answer">Short answer</SelectItem>
                    <SelectItem value="essay">Essay</SelectItem>
                    <SelectItem value="numerical">Numerical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="font-semibold">Marks</Label>
                <Input type="number" min={1} value={marks} onChange={(e) => setMarks(Number(e.target.value) || 1)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="font-semibold">Question</Label>
              <Textarea rows={3} value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Enter the question text…" />
            </div>
            {(qType === "mcq" || qType === "true_false") && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-semibold">Option A</Label>
                  <Input value={optionA} onChange={(e) => setOptionA(e.target.value)} placeholder={qType === "true_false" ? "True" : "Option A"} />
                </div>
                <div className="space-y-2">
                  <Label className="font-semibold">Option B</Label>
                  <Input value={optionB} onChange={(e) => setOptionB(e.target.value)} placeholder={qType === "true_false" ? "False" : "Option B"} />
                </div>
                {qType === "mcq" && (
                  <>
                    <div className="space-y-2"><Label className="font-semibold">Option C</Label><Input value={optionC} onChange={(e) => setOptionC(e.target.value)} /></div>
                    <div className="space-y-2"><Label className="font-semibold">Option D</Label><Input value={optionD} onChange={(e) => setOptionD(e.target.value)} /></div>
                  </>
                )}
                <div className="space-y-2 sm:col-span-2">
                  <Label className="font-semibold">Correct answer</Label>
                  <Select value={correct} onValueChange={setCorrect}>
                    <SelectTrigger className="max-w-[160px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["A", "B", "C", "D"].map((l) => (<SelectItem key={l} value={l}>{l}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {(qType === "short_answer" || qType === "numerical" || qType === "essay") && (
              <div className="space-y-2">
                <Label className="font-semibold">Model / correct answer</Label>
                <Input value={correct} onChange={(e) => setCorrect(e.target.value)} />
              </div>
            )}
            <div className="space-y-2">
              <Label className="font-semibold">Explanation (optional)</Label>
              <Textarea rows={2} value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="Shown after marking / review" />
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
              <Button variant="outline" onClick={() => { resetForm(); setMode("list"); }}>Cancel</Button>
              <Button className="font-semibold" disabled={busy} onClick={() => void saveQuestion()}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : editingId ? <Save className="mr-1.5 h-4 w-4" /> : <Plus className="mr-1.5 h-4 w-4" />}
                {editingId ? "Save changes" : "Save question"}
              </Button>
            </div>
          </div>
        </SectionCard>
      </>
    );
  }

  if (mode === "import") {
    return (
      <div className="flex min-h-[70vh] flex-col">
        <PageHeader
          title="Import questions"
          description="Upload CSV, Excel, Word (.docx) or text PDF. No AI — text is extracted as written."
          actions={<Button variant="outline" onClick={() => setMode("list")} disabled={importBusy}>Back to bank</Button>}
        />
        <SectionCard className="mb-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label className="font-semibold">Target course</Label>
              {lockedCourse ? (
                <p className="rounded-lg border bg-slate-50 px-3 py-2 text-sm font-semibold">{lockedCourse.code} — {lockedCourse.name}</p>
              ) : (
                <Select value={importCourseId} onValueChange={setImportCourseId}>
                  <SelectTrigger><SelectValue placeholder="Select course" /></SelectTrigger>
                  <SelectContent>
                    {teacher.courses.map((c) => (<SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Button type="button" variant="outline" className="font-semibold" onClick={() => downloadCsvTemplate()}>
                <Download className="mr-1.5 h-4 w-4" /> CSV template
              </Button>
              <Button type="button" className="font-semibold" disabled={importBusy} onClick={() => fileRef.current?.click()}>
                {importBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
                Choose file
              </Button>
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.docx,.pdf,text/csv,application/pdf" className="hidden" onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)} />
            </div>
          </div>
        </SectionCard>
        {drafts.length === 0 ? (
          <EmptyState title="No file loaded yet" description="Download the template or upload a file with numbered questions (1. … A. B. C. D.)." icon={FileQuestion} />
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <p className="text-slate-600">
                <strong>{drafts.length}</strong> parsed · <strong>{importSelectedCount}</strong> selected ·{" "}
                <strong className="text-destructive">{drafts.filter((d) => d.errors.length).length}</strong> with errors
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setDrafts((rows) => rows.map((r) => ({ ...r, selected: r.errors.length === 0 })))}>Select valid</Button>
                <Button size="sm" variant="outline" onClick={() => setDrafts((rows) => rows.map((r) => ({ ...r, selected: true })))}>Select all</Button>
              </div>
            </div>
            <ul className="mb-20 space-y-3 sm:mb-4">
              {drafts.map((d, idx) => (
                <li key={d.localId} className={cn("rounded-xl border p-3", d.errors.length ? "border-destructive/40 bg-destructive/5" : "border-slate-200 bg-white")}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" className="mt-1" checked={d.selected} onChange={(e) => setDrafts((rows) => rows.map((r) => r.localId === d.localId ? { ...r, selected: e.target.checked } : r))} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold uppercase text-slate-500">#{idx + 1} · {d.question_type} · {d.marks} mark(s)</p>
                      <p className="mt-1 text-sm font-medium text-slate-900">{d.question_text}</p>
                      {(d.option_a || d.option_b) && (
                        <ul className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                          {d.option_a && <li>A. {d.option_a}</li>}
                          {d.option_b && <li>B. {d.option_b}</li>}
                          {d.option_c && <li>C. {d.option_c}</li>}
                          {d.option_d && <li>D. {d.option_d}</li>}
                        </ul>
                      )}
                      {d.correct_answer && <p className="mt-1 text-xs font-semibold text-primary">Answer: {d.correct_answer}</p>}
                      {d.errors.length > 0 && <p className="mt-2 text-xs text-destructive">{d.errors.join(" · ")}</p>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <ImportFooter importBusy={importBusy} importSelectedCount={importSelectedCount} onCancel={() => { setDrafts([]); setMode("list"); }} onSave={() => void saveImport()} />
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={lockedCourse ? `Question Bank · ${lockedCourse.code}` : "Question Bank"}
        description={lockedCourse ? `Questions for ${lockedCourse.code} — ${lockedCourse.name}` : `Manage questions for your assigned courses · ${teacher.fullName}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="font-semibold" onClick={openImport}><Upload className="mr-1.5 h-4 w-4" /> Import</Button>
            <Button className="font-semibold" onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" /> Add question</Button>
          </div>
        }
      />
      {!teacher.courses.length ? (
        <EmptyState title="No courses assigned" description="School Admin must assign courses before you can manage questions." />
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <StatCard label="Total questions" value={stats.total} icon={FileQuestion} />
            <StatCard label="MCQ" value={stats.mcq} tone="info" />
            <StatCard label="Active" value={stats.active} tone="primary" />
          </div>
          <SectionCard
            title="Your questions"
            description="Filter by course or type. Select multiple for bulk actions."
            action={
              <div className="flex flex-wrap gap-2">
                {!lockedCourse && (
                  <Select value={filterCourse} onValueChange={setFilterCourse}>
                    <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Course" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All courses</SelectItem>
                      {teacher.courses.map((c) => (<SelectItem key={c.id} value={c.id}>{c.code}</SelectItem>))}
                    </SelectContent>
                  </Select>
                )}
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger className="h-9 w-[130px]"><SelectValue placeholder="Type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="mcq">MCQ</SelectItem>
                    <SelectItem value="true_false">True/False</SelectItem>
                    <SelectItem value="short_answer">Short</SelectItem>
                    <SelectItem value="essay">Essay</SelectItem>
                    <SelectItem value="numerical">Numerical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            }
          >
            <div className="relative mb-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input className="pl-9" placeholder="Search questions…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {listQ.isLoading ? (
              <p className="text-sm text-slate-500">Loading questions…</p>
            ) : filtered.length === 0 ? (
              <EmptyState title="No questions yet" description="Add one manually or import from CSV, Excel, Word or PDF." actionLabel="Add question" onAction={openCreate} icon={FileQuestion} />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <Checkbox
                    checked={filtered.length > 0 && filtered.every((q) => selectedIds.has(q.id))}
                    onCheckedChange={(v) => { if (v === true) selectAllFiltered(); else clearSelection(); }}
                    aria-label="Select all"
                  />
                  <span className="text-xs font-semibold text-slate-600">
                    {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select questions"}
                  </span>
                  {selectedIds.size > 0 && (
                    <>
                      <Button size="sm" variant="outline" className="h-8 text-xs font-semibold" disabled={bulkBusy} onClick={() => void bulkSetStatus("active")}>Set active</Button>
                      <Button size="sm" variant="outline" className="h-8 text-xs font-semibold" disabled={bulkBusy} onClick={() => void bulkSetStatus("pending")}>Set pending</Button>
                      <Button size="sm" variant="outline" className="h-8 text-xs font-semibold text-destructive" disabled={bulkBusy} onClick={() => void bulkDelete()}>
                        {bulkBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1 h-3.5 w-3.5" />}
                        Delete selected
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={clearSelection}>Clear</Button>
                    </>
                  )}
                </div>
                <ul className="space-y-3">
                  {filtered.map((q) => {
                    const opts = decodeOptions(q.explanation, q.options);
                    const checked = selectedIds.has(q.id);
                    return (
                      <li key={q.id} className={cn("rounded-xl border bg-white p-3 shadow-sm", checked ? "border-primary/40 bg-primary/5" : "border-slate-100")}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            <Checkbox className="mt-1" checked={checked} onCheckedChange={() => toggleSelect(q.id)} aria-label="Select question" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-bold uppercase tracking-wide text-primary">{q.courses?.code ?? "—"}</span>
                                <StatusBadge status={q.question_type.replaceAll("_", " ")} />
                                <StatusBadge status={q.status} />
                                <span className="text-xs text-slate-500">{q.marks} mark(s)</span>
                              </div>
                              <p className="mt-2 text-sm font-semibold text-slate-900">{q.question_text}</p>
                              {(opts.a || opts.b) && (
                                <ul className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                                  {opts.a && <li>A. {opts.a}</li>}
                                  {opts.b && <li>B. {opts.b}</li>}
                                  {opts.c && <li>C. {opts.c}</li>}
                                  {opts.d && <li>D. {opts.d}</li>}
                                </ul>
                              )}
                              {q.correct_answer && <p className="mt-1.5 text-xs font-semibold text-primary">Answer: {q.correct_answer}</p>}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button size="icon" variant="ghost" onClick={() => openEdit(q)} aria-label="Edit question"><Pencil className="h-4 w-4" /></Button>
                            <Button size="icon" variant="ghost" className="text-destructive" onClick={() => void deleteQuestion(q.id)} aria-label="Delete question"><Trash2 className="h-4 w-4" /></Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </SectionCard>
        </>
      )}
    </>
  );
}
