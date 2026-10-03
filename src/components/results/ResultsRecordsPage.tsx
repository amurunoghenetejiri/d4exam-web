import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  FileSpreadsheet,
  Loader2,
  Printer,
  Search,
} from "lucide-react";
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
  type ResultFilters,
} from "@/lib/results-records";
import { gradeColorClass } from "@/lib/resolve-student-details";
import { cn } from "@/lib/utils";

type Props = {
  forcedSchoolId?: string | null;
  title?: string;
  description?: string;
  showAnalysisTab?: boolean;
};

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


  function printRecord() {
    if (!printRef.current) return;
    const html = printRef.current.innerHTML;
    const w = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head><title>Examination Result</title>
      <style>
        body{font-family:system-ui,-apple-system,sans-serif;color:#0f172a;padding:24px}
        table{width:100%;border-collapse:collapse;font-size:12px}
        th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left}
        th{background:#0b1b3a;color:#fff}
        .grade-A,.grade-B{color:#059669;font-weight:800}
        .grade-C{color:#d97706;font-weight:800}
        .grade-F{color:#dc2626;font-weight:800}
        @media print{body{padding:12px}}
      </style></head><body>${html}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  }

  function exportCsv() {
    if (!record) return;
    const csv = resultsToCsv(record.header, filteredRows, isTest);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${record.header.courseCode || "result"}-${record.header.assessmentLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
            <div className="mb-3 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => printRecord()}>
                <Printer className="mr-1.5 h-3.5 w-3.5" />
                Print
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => printRecord()}>
                Print preview
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => exportCsv()}>
                <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />
                Export CSV
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => printRecord()}>
                Export PDF
              </Button>
            </div>

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
                    <th className="px-3 py-2.5 font-semibold">Student Full Name</th>
                    <th className="px-3 py-2.5 font-semibold">Matric Number</th>
                    <th className="px-3 py-2.5 font-semibold">Department</th>
                    <th className="px-3 py-2.5 font-semibold">Level</th>
                    <th className="px-3 py-2.5 font-semibold">Score</th>
                    {!isTest ? <th className="px-3 py-2.5 font-semibold">Grade</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={isTest ? 5 : 6} className="px-3 py-8 text-center text-slate-500">
                        No student results found for this assessment yet.
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((r) => {
                      const sc =
                        r.score != null && r.maxScore != null
                          ? `${r.score}/${r.maxScore}`
                          : r.score != null
                            ? String(r.score)
                            : "—";
                      return (
                        <tr key={r.resultId} className="border-b border-slate-100 odd:bg-slate-50/80">
                          <td className="px-3 py-2 font-medium text-slate-900">
                            {r.fullName}
                            {r.isCarryover ? (
                              <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800">
                                CO
                              </span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.matric}</td>
                          <td className="px-3 py-2 text-slate-700">{r.departmentName}</td>
                          <td className="px-3 py-2 text-slate-700">{r.levelName}</td>
                          <td className="px-3 py-2 font-semibold tabular-nums text-slate-900">{sc}</td>
                          {!isTest ? (
                            <td className={cn("px-3 py-2", gradeColorClass(r.grade))}>{r.grade || "—"}</td>
                          ) : null}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-slate-400">
                {filteredRows.length} student{filteredRows.length === 1 ? "" : "s"}
              </p>
            </div>
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
