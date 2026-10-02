import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Columns3,
  Download,
  FileSpreadsheet,
  GripVertical,
  Loader2,
  Pencil,
  Printer,
  RotateCcw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, EmptyState, SectionCard } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionUser, type SessionUser } from "@/lib/session";
import {
  loadFilterOptions,
  loadScopedExams,
  loadExamResultRecord,
  resultsToCsv,
  computeResultAnalytics,
  updateResultScore,
  type ResultFilters,
  type ResultStudentRow,
} from "@/lib/results-records";
import { gradeColorClass } from "@/lib/resolve-student-details";
import { cn } from "@/lib/utils";

type Props = {
  forcedSchoolId?: string | null;
  title?: string;
  description?: string;
  showAnalysisTab?: boolean;
};

type ColKey = "fullName" | "matric" | "department" | "level" | "score" | "grade" | "percentage";

type ColDef = { key: ColKey; label: string; defaultOn: boolean };

const ALL_COLUMNS: ColDef[] = [
  { key: "fullName", label: "Full Name", defaultOn: true },
  { key: "matric", label: "Matric Number", defaultOn: true },
  { key: "department", label: "Department", defaultOn: true },
  { key: "level", label: "Level", defaultOn: true },
  { key: "score", label: "Score", defaultOn: true },
  { key: "grade", label: "Grade", defaultOn: true },
  { key: "percentage", label: "Percentage", defaultOn: false },
];

function defaultLayout(isTest: boolean): ColKey[] {
  const keys = ALL_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);
  if (isTest) return keys.filter((k) => k !== "grade");
  return keys;
}

function layoutStorageKey(userId: string, schoolId: string | null) {
  return `d4_results_cols:${userId}:${schoolId || "all"}`;
}

function loadSavedLayout(userId: string, schoolId: string | null, isTest: boolean): ColKey[] {
  try {
    const raw = localStorage.getItem(layoutStorageKey(userId, schoolId));
    if (!raw) return defaultLayout(isTest);
    const parsed = JSON.parse(raw) as ColKey[];
    if (!Array.isArray(parsed) || !parsed.length) return defaultLayout(isTest);
    const allowed = new Set(ALL_COLUMNS.map((c) => c.key));
    const cleaned = parsed.filter((k) => allowed.has(k));
    return cleaned.length ? cleaned : defaultLayout(isTest);
  } catch {
    return defaultLayout(isTest);
  }
}

function cellValue(row: ResultStudentRow, key: ColKey): string {
  switch (key) {
    case "fullName":
      return row.fullName || "—";
    case "matric":
      return row.matric || "—";
    case "department":
      return row.departmentName || "—";
    case "level":
      return row.levelName || "—";
    case "score":
      if (row.score != null && row.maxScore != null) return `${row.score}/${row.maxScore}`;
      if (row.score != null) return String(row.score);
      return "—";
    case "grade":
      return row.grade || "—";
    case "percentage":
      return row.percentage != null ? `${Number(row.percentage).toFixed(1)}%` : "—";
    default:
      return "—";
  }
}


export function ResultsRecordsPage({
  forcedSchoolId,
  title = "Result Records",
  description = "Select an examination or test, then view, print or export official scores.",
  showAnalysisTab = false,
}: Props) {
  const { data: user } = useSessionUser();
  const printRef = useRef<HTMLDivElement>(null);
  const schoolId = forcedSchoolId || user?.schoolId || null;
  const role = user?.role;

  const [sessionId, setSessionId] = useState("");
  const [semesterId, setSemesterId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [levelId, setLevelId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [assessment, setAssessment] = useState<"all" | "test" | "examination">("all");
  const [examId, setExamId] = useState<string>("");
  const [examPickerOpen, setExamPickerOpen] = useState(false);
  const [examPickerSearch, setExamPickerSearch] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"results" | "analysis">("results");
  const [officerDeptLocked, setOfficerDeptLocked] = useState(false);
  const [editTable, setEditTable] = useState(false);
  const [colOrder, setColOrder] = useState<ColKey[]>([]);
  const [draftOrder, setDraftOrder] = useState<ColKey[]>([]);
  const [dragKey, setDragKey] = useState<ColKey | null>(null);
  const [editRecordId, setEditRecordId] = useState<string | null>(null);
  const [editScore, setEditScore] = useState("");
  const [editGrade, setEditGrade] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const filters: ResultFilters = useMemo(
    () => ({
      schoolId,
      sessionId: sessionId || null,
      semesterId: semesterId || null,
      departmentId: departmentId || null,
      levelId: levelId || null,
      courseId: courseId || null,
      assessment,
    }),
    [schoolId, sessionId, semesterId, departmentId, levelId, courseId, assessment],
  );

  const optsQ = useQuery({
    queryKey: ["result-filter-opts", schoolId],
    enabled: Boolean(schoolId) || user?.role === "super_admin",
    staleTime: 60_000,
    queryFn: async () => {
      try {
        return await loadFilterOptions(schoolId);
      } catch (e) {
        console.warn("[results] filter options", e);
        return { sessions: [], semesters: [], departments: [], levels: [], courses: [] };
      }
    },
  });

  const examsQ = useQuery({
    queryKey: ["result-scoped-exams", user?.userId, user?.role, filters],
    enabled: Boolean(user),
    staleTime: 15_000,
    queryFn: async () => {
      try {
        if (!user) return [];
        return await loadScopedExams(user as SessionUser, filters);
      } catch (e) {
        console.warn("[results] scoped exams", e);
        return [];
      }
    },
  });

  const recordQ = useQuery({
    queryKey: ["result-record", examId, user?.userId],
    enabled: Boolean(user && examId),
    staleTime: 10_000,
    queryFn: async () => {
      try {
        if (!user || !examId) return null;
        return await loadExamResultRecord(user as SessionUser, examId);
      } catch (e) {
        console.warn("[results] record", e);
        return null;
      }
    },
  });

  const exams = examsQ.data ?? [];
  const record = recordQ.data;
  const isTest = record?.assessment === "test";
  const analytics = useMemo(() => computeResultAnalytics(record?.rows ?? []), [record?.rows]);

  const filteredRows = useMemo(() => {
    let rows = record?.rows ?? [];
    const deptOpts = optsQ.data?.departments ?? [];
    const levelOpts = optsQ.data?.levels ?? [];
    // Live filters on student rows (department / level from filter bar)
    if (departmentId) {
      const deptName = deptOpts.find((d) => d.id === departmentId)?.name?.toLowerCase();
      if (deptName) {
        rows = rows.filter((r) => String(r.departmentName || "").toLowerCase() === deptName);
      }
    }
    if (levelId) {
      const lvlName = levelOpts.find((l) => l.id === levelId)?.name?.toLowerCase();
      if (lvlName) {
        rows = rows.filter((r) => String(r.levelName || "").toLowerCase() === lvlName);
      }
    }
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) =>
          String(r.fullName || "").toLowerCase().includes(q) ||
          String(r.matric || "").toLowerCase().includes(q) ||
          String(r.departmentName || "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [record?.rows, search, departmentId, levelId, optsQ.data?.departments, optsQ.data?.levels]);

  // Load per-user column layout when exam/assessment type is known
  useEffect(() => {
    if (!user?.userId) return;
    const isT = record?.assessment === "test";
    const saved = loadSavedLayout(user.userId, schoolId, Boolean(isT));
    setColOrder(saved);
    if (!editTable) setDraftOrder(saved);
  }, [user?.userId, schoolId, record?.assessment, examId]);

  const visibleCols = editTable ? draftOrder : colOrder.length ? colOrder : defaultLayout(Boolean(isTest));

  function saveLayout() {
    if (!user?.userId) return;
    setColOrder(draftOrder);
    try {
      localStorage.setItem(layoutStorageKey(user.userId, schoolId), JSON.stringify(draftOrder));
    } catch { /* ignore */ }
    setEditTable(false);
    toast.success("Table layout saved");
  }

  function cancelLayout() {
    setDraftOrder(colOrder.length ? colOrder : defaultLayout(Boolean(isTest)));
    setEditTable(false);
  }

  function resetLayout() {
    const d = defaultLayout(Boolean(isTest));
    setDraftOrder(d);
    toast.message("Reset to default — Save to apply");
  }

  function toggleCol(key: ColKey) {
    setDraftOrder((prev) => {
      if (prev.includes(key)) {
        if (prev.length <= 1) return prev;
        return prev.filter((k) => k !== key);
      }
      return [...prev, key];
    });
  }

  function moveCol(key: ColKey, dir: -1 | 1) {
    setDraftOrder((prev) => {
      const i = prev.indexOf(key);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function onDropCol(target: ColKey) {
    if (!dragKey || dragKey === target) {
      setDragKey(null);
      return;
    }
    setDraftOrder((prev) => {
      const without = prev.filter((k) => k !== dragKey);
      const idx = without.indexOf(target);
      if (idx < 0) return [...without, dragKey];
      without.splice(idx, 0, dragKey);
      return without;
    });
    setDragKey(null);
  }

  /** Reliable print — avoids blank page from window.open + noopener */
  function printRecord(onlyRowId?: string | null) {
    if (!record) {
      toast.error("Select an examination first");
      return;
    }
    const rows = onlyRowId
      ? filteredRows.filter((r) => r.resultId === onlyRowId)
      : filteredRows;
    if (!rows.length) {
      toast.error("No rows to print");
      return;
    }
    const h = record.header;
    const cols = visibleCols;
    const colLabels = cols.map((k) => ALL_COLUMNS.find((c) => c.key === k)?.label || k);
    const tableRows = rows
      .map(
        (r) =>
          "<tr>" +
          cols
            .map((k) => {
              const v = cellValue(r, k);
              const cls = k === "grade" && r.grade ? ` class="grade-${r.grade}"` : "";
              return `<td${cls}>${escapeHtml(v)}</td>`;
            })
            .join("") +
          "</tr>",
      )
      .join("");
    const logo = h.schoolLogoUrl
      ? `<img src="${escapeHtml(h.schoolLogoUrl)}" alt="" style="height:56px;width:auto;object-fit:contain" />`
      : "";
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(h.courseCode)} Result</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;margin:0;padding:24px}
  .hdr{display:flex;align-items:center;gap:14px;border-bottom:3px solid #0b1b3a;padding-bottom:12px;margin-bottom:16px}
  .hdr h1{margin:0;font-size:18px}
  .hdr p{margin:2px 0;font-size:12px;color:#475569}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;font-size:12px;margin-bottom:16px}
  .meta b{color:#0b1b3a}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th,td{border:1px solid #cbd5e1;padding:7px 9px;text-align:left}
  th{background:#0b1b3a;color:#fff}
  .grade-A,.grade-B{color:#059669;font-weight:800}
  .grade-C{color:#d97706;font-weight:800}
  .grade-F{color:#dc2626;font-weight:800}
  .foot{margin-top:18px;font-size:10px;color:#64748b;text-align:center}
  @media print{body{padding:12px} .no-print{display:none!important}}
</style></head><body>
<div class="hdr">${logo}<div>
  <h1>${escapeHtml(h.schoolName || "School")}</h1>
  <p>D4EXAM · Official ${escapeHtml(h.assessmentLabel || "Result")}</p>
</div></div>
<div class="meta">
  <div><b>Course:</b> ${escapeHtml(h.courseCode)} — ${escapeHtml(h.courseName)}</div>
  <div><b>Department:</b> ${escapeHtml(h.departmentName)}</div>
  <div><b>Level:</b> ${escapeHtml(h.levelName)}</div>
  <div><b>Semester:</b> ${escapeHtml(h.semesterName)}</div>
  <div><b>Session:</b> ${escapeHtml(h.sessionName)}</div>
  <div><b>Date:</b> ${escapeHtml(h.dateLabel)}</div>
</div>
<table><thead><tr>${colLabels.map((l) => "<th>" + escapeHtml(l) + "</th>").join("")}</tr></thead>
<tbody>${tableRows}</tbody></table>
<p class="foot">Generated by D4EXAM · ${rows.length} record(s) · ${new Date().toLocaleString()}</p>
</body></html>`;

    // iframe print — works when window.open is blocked or blank
    const iframe = document.createElement("iframe");
    iframe.setAttribute("title", "Print results");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      document.body.removeChild(iframe);
      toast.error("Could not open print view");
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();
    const doPrint = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        toast.error("Print failed");
      }
      setTimeout(() => {
        try {
          document.body.removeChild(iframe);
        } catch { /* ignore */ }
      }, 1000);
    };
    // Wait for images
    setTimeout(doPrint, 400);
  }

  function escapeHtml(s: string) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function exportCsv(allCols = false) {
    if (!record) return;
    const rows = filteredRows;
    if (allCols) {
      const csv = resultsToCsv(record.header, rows, isTest);
      downloadBlob(csv, `${record.header.courseCode || "result"}-${record.header.assessmentLabel}.csv`, "text/csv;charset=utf-8");
      return;
    }
    // Current view columns only
    const cols = visibleCols;
    const labels = cols.map((k) => ALL_COLUMNS.find((c) => c.key === k)?.label || k);
    const lines = [labels.join(",")];
    for (const r of rows) {
      lines.push(cols.map((k) => `"${cellValue(r, k).replace(/"/g, '""')}"`).join(","));
    }
    downloadBlob(lines.join("\n"), `${record.header.courseCode || "result"}-view.csv`, "text/csv;charset=utf-8");
  }

  function exportXlsxLike() {
    // SpreadsheetML-compatible HTML table (opens in Excel)
    if (!record) return;
    const cols = visibleCols;
    const labels = cols.map((k) => ALL_COLUMNS.find((c) => c.key === k)?.label || k);
    const h = record.header;
    let xml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>`;
    xml += `<h3>${escapeHtml(h.schoolName || "")} — ${escapeHtml(h.courseCode)} ${escapeHtml(h.courseName)}</h3>`;
    xml += `<table border="1"><tr>${labels.map((l) => `<th>${escapeHtml(l)}</th>`).join("")}</tr>`;
    for (const r of filteredRows) {
      xml += `<tr>${cols.map((k) => `<td>${escapeHtml(cellValue(r, k))}</td>`).join("")}</tr>`;
    }
    xml += `</table></body></html>`;
    downloadBlob(xml, `${h.courseCode || "result"}.xls`, "application/vnd.ms-excel");
  }

  function downloadBlob(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveEditedRecord() {
    if (!editRecordId) return;
    setEditSaving(true);
    try {
      const scoreNum = editScore.trim() === "" ? null : Number(editScore);
      if (editScore.trim() && Number.isNaN(scoreNum)) {
        toast.error("Score must be a number");
        return;
      }
      const row = filteredRows.find((r) => r.resultId === editRecordId);
      let percentage: number | null = null;
      if (scoreNum != null && row?.maxScore) {
        percentage = (scoreNum / row.maxScore) * 100;
      }
      const res = await updateResultScore({
        resultId: editRecordId,
        score: scoreNum,
        grade: editGrade.trim() || null,
        percentage,
      });
      if (!res.ok) {
        toast.error(res.error || "Could not save");
        return;
      }
      toast.success("Result updated");
      setEditRecordId(null);
      void recordQ.refetch();
    } finally {
      setEditSaving(false);
    }
  }

  const opts = optsQ.data;
  const semestersFiltered = (opts?.semesters ?? []).filter((s) => !sessionId || s.extra === sessionId);

  // Role-scoped filter lists
  const departmentsForUi = useMemo(() => {
    const all = opts?.departments ?? [];
    if (role === "examination_officer" && departmentId) {
      return all.filter((d) => d.id === departmentId);
    }
    return all;
  }, [opts?.departments, role, departmentId]);

  const coursesForUi = useMemo(() => {
    const all = opts?.courses ?? [];
    // When a department is selected, still show all courses in opts (courses not always tagged in NamedOption)
    return all;
  }, [opts?.courses]);

  // Lock departmental officer to their department once
  useEffect(() => {
    if (!user || role !== "examination_officer" || !schoolId || officerDeptLocked) return;
    let cancelled = false;
    (async () => {
      try {
        const { resolveOfficerDepartmentId } = await import("@/lib/results-records");
        const deptId = await resolveOfficerDepartmentId(schoolId, user.profileId);
        if (!cancelled && deptId) {
          setDepartmentId(deptId);
          setOfficerDeptLocked(true);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, role, schoolId, officerDeptLocked]);

  if (!user) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (user.role !== "super_admin" && !schoolId) {
    return (
      <>
        <PageHeader title={title} description={description} />
        <EmptyState title="No school linked" description="Sign in with a school account to view results." />
      </>
    );
  }



  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader title={title} description={description} />

      {showAnalysisTab ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setTab("results")}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-semibold transition",
              tab === "results" ? "bg-primary text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
            )}
          >
            Results
          </button>
          <button
            type="button"
            onClick={() => setTab("analysis")}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-semibold transition",
              tab === "analysis" ? "bg-primary text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
            )}
          >
            <BarChart3 className="mr-1 inline h-3.5 w-3.5" />
            Analysis
          </button>
        </div>
      ) : null}

      <SectionCard title="Filters" className="mt-2">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <FilterSelect label="Academic Session" value={sessionId} onChange={(v) => { setSessionId(v); setSemesterId(""); setExamId(""); }} options={opts?.sessions ?? []} />
          <FilterSelect label="Semester" value={semesterId} onChange={(v) => { setSemesterId(v); setExamId(""); }} options={semestersFiltered} />
          {role === "examination_officer" ? (
            <FilterSelect
              label="Department"
              value={departmentId}
              onChange={(v) => { setDepartmentId(v); setExamId(""); }}
              options={departmentsForUi}
              disabled={officerDeptLocked && Boolean(departmentId)}
            />
          ) : role === "teacher" ? null : (
            <FilterSelect label="Department" value={departmentId} onChange={(v) => { setDepartmentId(v); setExamId(""); }} options={departmentsForUi} />
          )}
          <FilterSelect label="Level" value={levelId} onChange={(v) => { setLevelId(v); setExamId(""); }} options={opts?.levels ?? []} />
          <FilterSelect label="Course" value={courseId} onChange={(v) => { setCourseId(v); setExamId(""); }} options={coursesForUi} />
          <div className="space-y-1">
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">Assessment</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={assessment}
              onChange={(e) => { setAssessment(e.target.value as "all" | "test" | "examination"); setExamId(""); }}
            >
              <option value="all">All</option>
              <option value="test">Test</option>
              <option value="examination">Exam</option>
            </select>
          </div>
        </div>

        {/* Branded exam picker (modal list, not native grey select) */}
        <div className="mt-4 space-y-1">
          <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
            Select examination / test
          </label>
          {examsQ.isLoading ? (
            <p className="text-sm text-slate-500">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
              Loading assessments…
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setExamPickerOpen(true)}
                className="flex h-11 w-full items-center justify-between rounded-xl border-2 border-primary/30 bg-primary/5 px-3 text-left text-sm font-semibold text-slate-900 transition hover:border-primary hover:bg-primary/10"
              >
                <span className="truncate">
                  {examId
                    ? (() => {
                        const e = exams.find((x) => x.id === examId);
                        if (!e) return "Selected assessment";
                        const code = e.courses?.code;
                        return code ? `${code} · ${e.title}` : e.title;
                      })()
                    : "Tap to select examination or test"}
                </span>
                <span className="ml-2 shrink-0 text-xs font-bold uppercase text-primary">Select</span>
              </button>
              {examPickerOpen ? (
                <div
                  className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
                  onClick={() => setExamPickerOpen(false)}
                >
                  <div
                    className="flex max-h-[min(80vh,32rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="border-b border-slate-100 bg-[#0b1b3a] px-4 py-3 text-white">
                      <p className="text-sm font-bold">Select results</p>
                      <p className="text-[11px] text-white/80">Scroll and tap an examination or test</p>
                      <div className="relative mt-2">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/50" />
                        <input
                          value={examPickerSearch}
                          onChange={(e) => setExamPickerSearch(e.target.value)}
                          placeholder="Search by title or course…"
                          className="h-9 w-full rounded-lg border border-white/20 bg-white/10 pl-8 pr-3 text-sm text-white placeholder:text-white/50 outline-none focus:border-white/40"
                        />
                      </div>
                    </div>
                    <ul className="flex-1 overflow-y-auto p-2">
                      {exams.filter((e) => {
                        const q = examPickerSearch.trim().toLowerCase();
                        if (!q) return true;
                        const code = (e.courses?.code || "").toLowerCase();
                        const name = (e.courses?.name || "").toLowerCase();
                        return e.title.toLowerCase().includes(q) || code.includes(q) || name.includes(q);
                      }).length === 0 ? (
                        <li className="px-3 py-6 text-center text-sm text-slate-500">No assessments match filters.</li>
                      ) : (
                        exams.filter((e) => {
                        const q = examPickerSearch.trim().toLowerCase();
                        if (!q) return true;
                        const code = (e.courses?.code || "").toLowerCase();
                        const name = (e.courses?.name || "").toLowerCase();
                        return e.title.toLowerCase().includes(q) || code.includes(q) || name.includes(q);
                      }).map((e) => {
                          const code = e.courses?.code || "";
                          const active = examId === e.id;
                          return (
                            <li key={e.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setExamId(e.id);
                                  setExamPickerOpen(false);
                                  setTab("results");
                                }}
                                className={cn(
                                  "mb-1 w-full rounded-xl border px-3 py-2.5 text-left transition",
                                  active
                                    ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                                    : "border-slate-100 bg-white hover:border-primary/40 hover:bg-primary/5",
                                )}
                              >
                                {code ? (
                                  <p className="text-xs font-bold text-primary">{code}</p>
                                ) : null}
                                <p className="text-sm font-semibold text-slate-900">{e.title}</p>
                                <p className="text-[10px] uppercase tracking-wide text-slate-400">{e.status}</p>
                              </button>
                            </li>
                          );
                        })
                      )}
                    </ul>
                    <div className="border-t border-slate-100 p-2">
                      <button
                        type="button"
                        className="w-full rounded-xl py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                        onClick={() => setExamPickerOpen(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </SectionCard>

      <div className="mt-4 min-w-0">
        {!examId ? (
          <SectionCard title="Result record">
            <EmptyState
              title="Select an examination or test"
              description="Use the dropdown above to open official scores for that assessment."
            />
          </SectionCard>
        ) : recordQ.isLoading ? (
          <SectionCard title="Loading…">
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          </SectionCard>
        ) : !record ? (
          <SectionCard title="Result record">
            <EmptyState title="Could not load this result" description="You may not have access, or no data exists yet." />
          </SectionCard>
        ) : showAnalysisTab && tab === "analysis" ? (
          <SectionCard title={`Analysis — ${record.header.title}`}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="Students" value={String(analytics.count)} />
              <Stat label="Average score" value={analytics.averagePct != null ? `${analytics.averagePct.toFixed(1)}%` : "—"} />
              <Stat label="Pass rate" value={analytics.passRate != null ? `${analytics.passRate.toFixed(1)}%` : "—"} />
              <Stat label="Fail rate" value={analytics.failRate != null ? `${analytics.failRate.toFixed(1)}%` : "—"} />
              <Stat label="Highest" value={analytics.highest != null ? `${analytics.highest.toFixed(1)}%` : "—"} />
              <Stat label="Lowest" value={analytics.lowest != null ? `${analytics.lowest.toFixed(1)}%` : "—"} />
            </div>
            <div className="mt-4">
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Grade distribution</p>
              <div className="flex flex-wrap gap-2">
                {Object.keys(analytics.gradeDist).length === 0 ? (
                  <p className="text-sm text-slate-500">No grades yet.</p>
                ) : (
                  Object.entries(analytics.gradeDist)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([g, n]) => (
                      <span key={g} className={cn("rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm", gradeColorClass(g))}>
                        {g}: {n}
                      </span>
                    ))
                )}
              </div>
            </div>
          </SectionCard>
        ) : (
          <SectionCard title="Result record">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {!editTable ? (
                <>
                  <Button type="button" size="sm" variant="outline" onClick={() => { setDraftOrder(visibleCols); setEditTable(true); }}>
                    <Columns3 className="mr-1.5 h-3.5 w-3.5" />
                    Edit table
                  </Button>
                  {(role === "school_admin" || role === "examination_officer" || role === "super_admin" || role === "teacher") ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (!selectedRowId) {
                          toast.message("Select a student row first");
                          return;
                        }
                        const row = filteredRows.find((r) => r.resultId === selectedRowId);
                        if (!row) return;
                        setEditRecordId(row.resultId);
                        setEditScore(row.score != null ? String(row.score) : "");
                        setEditGrade(row.grade || "");
                      }}
                    >
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      Edit record
                    </Button>
                  ) : null}
                  <Button type="button" size="sm" variant="outline" onClick={() => printRecord()}>
                    <Printer className="mr-1.5 h-3.5 w-3.5" />
                    Print
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => printRecord(selectedRowId)}>
                    Print selected
                  </Button>
                  <div className="relative">
                    <Button type="button" size="sm" variant="outline" onClick={() => setExportOpen((v) => !v)}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      Export
                    </Button>
                    {exportOpen ? (
                      <div className="absolute left-0 z-20 mt-1 min-w-[12rem] rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                        <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { exportCsv(false); setExportOpen(false); }}>CSV (current view)</button>
                        <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { exportCsv(true); setExportOpen(false); }}>CSV (all columns)</button>
                        <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { exportXlsxLike(); setExportOpen(false); }}>Excel (.xls)</button>
                        <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { printRecord(); setExportOpen(false); }}>PDF / Print</button>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">Editing table layout</span>
                  <Button type="button" size="sm" onClick={saveLayout}>Save layout</Button>
                  <Button type="button" size="sm" variant="outline" onClick={cancelLayout}>Cancel</Button>
                  <Button type="button" size="sm" variant="outline" onClick={resetLayout}>
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    Reset
                  </Button>
                </>
              )}
            </div>

            {editTable ? (
              <div className="mb-3 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-3">
                <p className="mb-2 text-xs font-semibold text-slate-600">Show / hide &amp; drag to reorder columns (does not change result data)</p>
                <div className="flex flex-wrap gap-2">
                  {ALL_COLUMNS.filter((c) => !(isTest && c.key === "grade")).map((c) => {
                    const on = draftOrder.includes(c.key);
                    return (
                      <button
                        key={c.key}
                        type="button"
                        draggable={on}
                        onDragStart={() => setDragKey(c.key)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => onDropCol(c.key)}
                        onClick={() => toggleCol(c.key)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold",
                          on ? "border-primary bg-white text-primary" : "border-slate-200 bg-slate-100 text-slate-500",
                        )}
                      >
                        {on ? <GripVertical className="h-3 w-3" /> : null}
                        {c.label}
                        {on ? (
                          <span className="ml-1 flex gap-0.5">
                            <span role="button" className="rounded px-1 hover:bg-slate-100" onClick={(e) => { e.stopPropagation(); moveCol(c.key, -1); }}>←</span>
                            <span role="button" className="rounded px-1 hover:bg-slate-100" onClick={(e) => { e.stopPropagation(); moveCol(c.key, 1); }}>→</span>
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="mb-3 flex items-center gap-2">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <Input
                placeholder="Search student name or matric…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-sm"
              />
            </div>

            <div ref={printRef} className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
              {/* Header: school logo left, title center — no D4EXAM brand mark */}
              <div className="mb-4 flex items-start gap-4 border-b border-slate-200 pb-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50 sm:h-20 sm:w-20">
                  {record.header.schoolLogoUrl ? (
                    <img
                      src={record.header.schoolLogoUrl}
                      alt={record.header.schoolName || "School"}
                      className="h-full w-full object-contain p-1"
                    />
                  ) : (
                    <span className="text-[10px] font-bold uppercase text-slate-400">Logo</span>
                  )}
                </div>
                <div className="min-w-0 flex-1 text-center sm:pr-16">
                  <h1 className="text-lg font-extrabold text-slate-900 sm:text-xl">
                    {isTest ? "TEST RESULT" : "EXAMINATION RESULT"}
                  </h1>
                  {record.header.schoolName ? (
                    <p className="mt-1 text-sm font-semibold text-slate-600">{record.header.schoolName}</p>
                  ) : null}
                </div>
              </div>

              <div className="mb-5 grid gap-2 text-sm sm:grid-cols-2">
                <Meta label="Course Code" value={record.header.courseCode} />
                <Meta label="Course" value={record.header.courseName} />
                {departmentId ? (
                  <Meta
                    label="Department"
                    value={
                      (opts?.departments ?? []).find((d) => d.id === departmentId)?.name ||
                      record.header.departmentName
                    }
                  />
                ) : null}
                {levelId ? (
                  <Meta
                    label="Level"
                    value={
                      (opts?.levels ?? []).find((l) => l.id === levelId)?.name ||
                      record.header.levelName
                    }
                  />
                ) : (
                  <Meta label="Level" value={record.header.levelName} />
                )}
                <Meta label="Semester" value={record.header.semesterName} />
                <Meta label="Academic Session" value={record.header.sessionName} />
                <Meta label="Assessment" value={record.header.assessmentLabel} />
                <Meta label="Date" value={record.header.dateLabel} />
              </div>

              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="bg-[#0b1b3a] text-left text-white">
                    {visibleCols.map((k) => (
                      <th key={k} className="px-3 py-2.5 font-semibold">
                        {ALL_COLUMNS.find((c) => c.key === k)?.label || k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={Math.max(visibleCols.length, 1)} className="px-3 py-8 text-center text-slate-500">
                        No student results found for this assessment yet.
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((r) => (
                      <tr
                        key={r.resultId}
                        onClick={() => setSelectedRowId(r.resultId)}
                        className={cn(
                          "cursor-pointer border-b border-slate-100 odd:bg-slate-50/80",
                          selectedRowId === r.resultId && "bg-primary/10 ring-1 ring-inset ring-primary/30",
                        )}
                      >
                        {visibleCols.map((k) => (
                          <td
                            key={k}
                            className={cn(
                              "px-3 py-2",
                              k === "fullName" && "font-medium text-slate-900",
                              k === "matric" && "font-mono text-xs text-slate-700",
                              k === "score" && "font-semibold tabular-nums text-slate-900",
                              k === "grade" && gradeColorClass(r.grade),
                            )}
                          >
                            {k === "fullName" ? (
                              <>
                                {r.fullName}
                                {r.isCarryover ? (
                                  <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800">
                                    CO
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              cellValue(r, k)
                            )}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-slate-400">
                {filteredRows.length} student{filteredRows.length === 1 ? "" : "s"}
                {selectedRowId ? " · 1 selected" : ""}
              </p>
            </div>

            {/* Edit record modal */}
            {editRecordId ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditRecordId(null)}>
                <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-base font-bold text-slate-900">Edit result record</h3>
                    <button type="button" onClick={() => setEditRecordId(null)} className="rounded-full p-1 hover:bg-slate-100">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="mb-3 text-xs text-slate-500">
                    Changes update the official score in the database. Table layout is separate.
                  </p>
                  <label className="mb-1 block text-xs font-semibold text-slate-600">Score</label>
                  <Input value={editScore} onChange={(e) => setEditScore(e.target.value)} className="mb-3" inputMode="decimal" />
                  {!isTest ? (
                    <>
                      <label className="mb-1 block text-xs font-semibold text-slate-600">Grade</label>
                      <Input value={editGrade} onChange={(e) => setEditGrade(e.target.value)} className="mb-3" placeholder="A / B / C / F" />
                    </>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditRecordId(null)}>Cancel</Button>
                    <Button type="button" size="sm" disabled={editSaving} onClick={() => void saveEditedRecord()}>
                      {editSaving ? "Saving…" : "Save changes"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </SectionCard>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-slate-600">
      <span className="font-semibold text-slate-800">{label}:</span> {value}
    </p>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-extrabold text-slate-900">{value}</p>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</label>
      <select
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-70"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}
