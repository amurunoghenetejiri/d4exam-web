/**
 * Role-scoped result records for D4EXAM.
 * Loads exams + student scores with separate queries (avoids fragile nested joins).
 */
import { supabase } from "@/integrations/supabase/client";
import { parseExamMeta, assessmentKindLabel, type AssessmentKind } from "@/lib/exam-meta";
import { gradeFromPercentage } from "@/lib/cbt-security";
import type { AppRole, SessionUser } from "@/lib/session";
import { resolveStudentDetails } from "@/lib/resolve-student-details";

export type ResultsScope = "super_admin" | "school_admin" | "examination_officer" | "teacher";

export type ResultFilters = {
  schoolId?: string | null;
  sessionId?: string | null;
  semesterId?: string | null;
  departmentId?: string | null;
  levelId?: string | null;
  courseId?: string | null;
  assessment?: "all" | "test" | "examination";
  examId?: string | null;
};

export type ExamRecordHeader = {
  examId: string;
  title: string;
  courseCode: string;
  courseName: string;
  departmentName: string;
  levelName: string;
  semesterName: string;
  sessionName: string;
  assessment: AssessmentKind;
  assessmentLabel: string;
  dateLabel: string;
  maxScore: number | null;
  schoolName: string | null;
  schoolLogoUrl: string | null;
};

export type ResultStudentRow = {
  resultId: string;
  studentId: string;
  fullName: string;
  matric: string;
  departmentName: string;
  levelName: string;
  score: number | null;
  maxScore: number | null;
  grade: string | null;
  isCarryover: boolean;
  percentage: number | null;
};

export type NamedOption = { id: string; name: string; extra?: string };

export type ExamListItem = {
  id: string;
  title: string;
  status: string;
  course_id: string | null;
  scheduled_start: string | null;
  description: string | null;
  school_id: string;
  courses: {
    code: string;
    name: string;
    department_id: string | null;
    level_id: string | null;
    semester_id: string | null;
  } | null;
};

function scopeFromRole(role: AppRole | null | undefined): ResultsScope | null {
  if (role === "super_admin") return "super_admin";
  if (role === "school_admin") return "school_admin";
  if (role === "examination_officer") return "examination_officer";
  if (role === "teacher") return "teacher";
  return null;
}

export async function resolveOfficerDepartmentId(
  schoolId: string,
  profileId: string | null,
): Promise<string | null> {
  if (!profileId) return null;
  try {
    const { data } = await supabase
      .from("examination_officers")
      .select("department_id")
      .eq("school_id", schoolId)
      .eq("profile_id", profileId)
      .maybeSingle();
    return (data as { department_id?: string | null } | null)?.department_id ?? null;
  } catch {
    return null;
  }
}

export async function resolveTeacherCourseIds(
  schoolId: string,
  profileId: string | null,
): Promise<string[]> {
  if (!profileId) return [];
  try {
    const { data: teacher } = await supabase
      .from("teachers")
      .select("id")
      .eq("school_id", schoolId)
      .eq("profile_id", profileId)
      .maybeSingle();
    if (!teacher?.id) return [];
    const { data: links } = await supabase
      .from("teacher_courses")
      .select("course_id")
      .eq("teacher_id", teacher.id);
    return (links ?? []).map((l) => String(l.course_id)).filter(Boolean);
  } catch {
    return [];
  }
}

/** List exams the current user may see. */
export async function loadScopedExams(
  user: SessionUser,
  filters: ResultFilters,
): Promise<ExamListItem[]> {
  const scope = scopeFromRole(user.role);
  if (!scope) return [];

  const schoolId = filters.schoolId || user.schoolId;
  if (scope !== "super_admin" && !schoolId) return [];

  // Plain exam query first (no nested join that can empty the list under RLS)
  let q = supabase
    .from("examinations")
    .select("id, title, status, course_id, scheduled_start, scheduled_end, description, school_id, created_at")
    .order("created_at", { ascending: false })
    .limit(500);

  if (schoolId) q = q.eq("school_id", schoolId);

  const { data, error } = await q;
  if (error) {
    console.warn("[results] loadScopedExams", error.message);
    return [];
  }

  let rows = (data ?? []) as Array<{
    id: string;
    title: string;
    status: string;
    course_id: string | null;
    scheduled_start: string | null;
    scheduled_end?: string | null;
    description: string | null;
    school_id: string;
    created_at?: string;
  }>;

  // Attach courses in batch
  const courseIds = [...new Set(rows.map((r) => r.course_id).filter(Boolean))] as string[];
  const courseMap = new Map<
    string,
    {
      code: string;
      name: string;
      department_id: string | null;
      level_id: string | null;
      semester_id: string | null;
    }
  >();
  if (courseIds.length) {
    const { data: courses } = await supabase
      .from("courses")
      .select("id, code, name, department_id, level_id, semester_id")
      .in("id", courseIds.slice(0, 200));
    for (const c of courses ?? []) {
      courseMap.set(c.id, {
        code: c.code,
        name: c.name,
        department_id: c.department_id,
        level_id: c.level_id,
        semester_id: c.semester_id,
      });
    }
  }

  let items: ExamListItem[] = rows.map((e) => ({
    id: e.id,
    title: e.title,
    status: e.status,
    course_id: e.course_id,
    scheduled_start: e.scheduled_start,
    description: e.description,
    school_id: e.school_id,
    courses: e.course_id ? courseMap.get(e.course_id) ?? null : null,
  }));

  // Teacher filter after courses attached
  if (scope === "teacher") {
    const courseIdsT = await resolveTeacherCourseIds(schoolId!, user.profileId);
    const set = new Set(courseIdsT);
    // Re-query created_by
    const { data: mine } = await supabase
      .from("examinations")
      .select("id")
      .eq("school_id", schoolId!)
      .eq("created_by", user.userId)
      .limit(300);
    const mineSet = new Set((mine ?? []).map((m) => m.id));
    items = items.filter((e) => mineSet.has(e.id) || (e.course_id && set.has(e.course_id)));
  }

  // Officer: department of course
  if (scope === "examination_officer") {
    const deptId = await resolveOfficerDepartmentId(schoolId!, user.profileId);
    if (deptId) {
      items = items.filter((e) => !e.courses?.department_id || e.courses.department_id === deptId);
    }
  }

  if (filters.courseId) items = items.filter((e) => e.course_id === filters.courseId);
  if (filters.departmentId) {
    items = items.filter((e) => e.courses?.department_id === filters.departmentId);
  }
  if (filters.levelId) {
    items = items.filter((e) => e.courses?.level_id === filters.levelId);
  }
  if (filters.semesterId) {
    items = items.filter((e) => e.courses?.semester_id === filters.semesterId);
  }
  if (filters.assessment && filters.assessment !== "all") {
    items = items.filter((e) => {
      const kind = parseExamMeta(e.description).assessmentKind || "examination";
      if (filters.assessment === "test") return kind === "test";
      return kind === "examination" || kind === "assignment";
    });
  }
  if (filters.examId) items = items.filter((e) => e.id === filters.examId);

  if (filters.sessionId && schoolId) {
    try {
      const { data: sems } = await supabase
        .from("semesters")
        .select("id")
        .eq("school_id", schoolId)
        .eq("academic_session_id", filters.sessionId);
      const semIds = new Set((sems ?? []).map((s) => s.id));
      if (semIds.size) {
        // Only apply if courses have semester_id; keep exams without course
        items = items.filter(
          (e) => !e.courses?.semester_id || semIds.has(e.courses.semester_id),
        );
      }
    } catch {
      /* ignore */
    }
  }

  return items;
}

export async function loadExamResultRecord(
  user: SessionUser,
  examId: string,
): Promise<{ header: ExamRecordHeader; rows: ResultStudentRow[]; assessment: AssessmentKind } | null> {
  const scope = scopeFromRole(user.role);
  if (!scope) return null;

  const { data: exam, error } = await supabase
    .from("examinations")
    .select("id, title, description, school_id, course_id, scheduled_start, scheduled_end")
    .eq("id", examId)
    .maybeSingle();

  if (error || !exam) {
    console.warn("[results] exam load", error?.message);
    return null;
  }

  const schoolId = String(exam.school_id);
  if (scope !== "super_admin" && user.schoolId && user.schoolId !== schoolId) return null;

  let course: {
    code: string;
    name: string;
    department_id: string | null;
    level_id: string | null;
    semester_id: string | null;
  } | null = null;

  if (exam.course_id) {
    const { data: c } = await supabase
      .from("courses")
      .select("code, name, department_id, level_id, semester_id")
      .eq("id", exam.course_id)
      .maybeSingle();
    course = c;
  }

  if (scope === "teacher") {
    const courseIds = await resolveTeacherCourseIds(schoolId, user.profileId);
    if (exam.course_id && !courseIds.includes(exam.course_id)) {
      const { data: mine } = await supabase
        .from("examinations")
        .select("id")
        .eq("id", examId)
        .eq("created_by", user.userId)
        .maybeSingle();
      if (!mine) return null;
    }
  }
  if (scope === "examination_officer") {
    const deptId = await resolveOfficerDepartmentId(schoolId, user.profileId);
    if (deptId && course?.department_id && course.department_id !== deptId) return null;
  }

  const meta = parseExamMeta(exam.description);
  const assessment = (meta.assessmentKind || "examination") as AssessmentKind;

  let deptName = "—";
  let levelName = "—";
  let semName = "—";
  let sessName = "—";
  try {
    if (course?.department_id) {
      const { data: d } = await supabase.from("departments").select("name").eq("id", course.department_id).maybeSingle();
      if (d?.name) deptName = d.name;
    }
    if (course?.level_id) {
      const { data: l } = await supabase.from("levels").select("name").eq("id", course.level_id).maybeSingle();
      if (l?.name) levelName = l.name;
    }
    if (course?.semester_id) {
      const { data: s } = await supabase
        .from("semesters")
        .select("name, academic_session_id")
        .eq("id", course.semester_id)
        .maybeSingle();
      if (s?.name) semName = s.name;
      if (s?.academic_session_id) {
        const { data: sess } = await supabase
          .from("academic_sessions")
          .select("name")
          .eq("id", s.academic_session_id)
          .maybeSingle();
        if (sess?.name) sessName = sess.name;
      }
    }
  } catch {
    /* ignore */
  }

  let schoolName: string | null = user.schoolName;
  let schoolLogoUrl: string | null = user.schoolLogoUrl ?? null;
  try {
    const { data: sch } = await supabase.from("schools").select("name, logo_url").eq("id", schoolId).maybeSingle();
    if (sch?.name) schoolName = sch.name;
    if (sch?.logo_url) schoolLogoUrl = sch.logo_url as string;
  } catch {
    /* ignore */
  }

  // Date of the examination = when it was scheduled to start / posted (not end time)
  const dateIso = exam.scheduled_start || exam.scheduled_end || null;
  let dateLabel = "—";
  if (dateIso) {
    try {
      dateLabel = new Date(dateIso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    } catch {
      dateLabel = String(dateIso);
    }
  }

  // Results — simple select (no nested students join). Always scope by school when known.
  let resultRows: Array<{
    id: string;
    student_id: string;
    total_score: number | null;
    max_score: number | null;
    percentage: number | null;
    grade: string | null;
    status?: string | null;
  }> = [];

  {
    let q = supabase
      .from("results")
      .select("id, student_id, total_score, max_score, percentage, grade, status, created_at")
      .eq("exam_id", examId)
      .order("created_at", { ascending: true })
      .limit(2000);
    if (schoolId) q = q.eq("school_id", schoolId);
    const { data, error: rErr } = await q;
    if (rErr) {
      console.warn("[results] results query", rErr.message);
      const { data: d2 } = await supabase
        .from("results")
        .select("id, student_id, total_score, max_score, percentage, grade, status")
        .eq("exam_id", examId)
        .limit(2000);
      resultRows = (d2 ?? []) as typeof resultRows;
    } else {
      resultRows = (data ?? []) as typeof resultRows;
    }
  }

  const studentIds = [...new Set(resultRows.map((r) => r.student_id).filter(Boolean))];
  const details = await resolveStudentDetails(schoolId, studentIds);

  let carryoverStudentIds = new Set<string>();
  if (exam.course_id) {
    try {
      const { data: cos } = await supabase
        .from("course_carryovers")
        .select("student_id")
        .eq("school_id", schoolId)
        .eq("course_id", exam.course_id)
        .eq("status", "active");
      carryoverStudentIds = new Set((cos ?? []).map((c) => String(c.student_id)));
    } catch {
      /* ignore */
    }
  }

  let maxScore: number | null = null;
  const rows: ResultStudentRow[] = [];
  for (const r of resultRows) {
    const st = details[r.student_id];
    const score = r.total_score != null ? Number(r.total_score) : null;
    const max = r.max_score != null ? Number(r.max_score) : null;
    if (max != null && (maxScore == null || max > maxScore)) maxScore = max;
    let grade = r.grade;
    if (!grade && assessment !== "test" && r.percentage != null) {
      grade = gradeFromPercentage(Number(r.percentage));
    }
    rows.push({
      resultId: r.id,
      studentId: r.student_id,
      fullName: (st?.fullName && st.fullName !== "Student" ? st.fullName : st?.fullName) || "Student",
      matric: st?.matric || "—",
      departmentName: st?.departmentName || "—",
      levelName: st?.levelName || "—",
      score,
      maxScore: max,
      grade: grade || null,
      isCarryover: carryoverStudentIds.has(r.student_id),
      percentage: r.percentage != null ? Number(r.percentage) : null,
    });
  }
    rows.sort((a, b) => a.fullName.localeCompare(b.fullName));

  const header: ExamRecordHeader = {
    examId: exam.id,
    title: exam.title || "Examination",
    courseCode: course?.code || "—",
    courseName: course?.name || "—",
    departmentName: deptName,
    levelName: levelName,
    semesterName: semName,
    sessionName: sessName,
    assessment,
    assessmentLabel: assessmentKindLabel(assessment),
    dateLabel,
    maxScore,
    schoolName,
    schoolLogoUrl,
  };

  return { header, rows, assessment };
}

export async function loadFilterOptions(schoolId: string | null): Promise<{
  sessions: NamedOption[];
  semesters: NamedOption[];
  departments: NamedOption[];
  levels: NamedOption[];
  courses: NamedOption[];
}> {
  if (!schoolId) {
    return { sessions: [], semesters: [], departments: [], levels: [], courses: [] };
  }
  const [sessions, semesters, departments, levels, courses] = await Promise.all([
    supabase.from("academic_sessions").select("id, name").eq("school_id", schoolId).order("name"),
    supabase.from("semesters").select("id, name, academic_session_id").eq("school_id", schoolId).order("name"),
    supabase.from("departments").select("id, name").eq("school_id", schoolId).order("name"),
    supabase.from("levels").select("id, name").eq("school_id", schoolId).order("name"),
    supabase.from("courses").select("id, code, name").eq("school_id", schoolId).order("code"),
  ]);
  return {
    sessions: (sessions.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    semesters: (semesters.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      extra: s.academic_session_id || undefined,
    })),
    departments: (departments.data ?? []).map((d) => ({ id: d.id, name: d.name })),
    levels: (levels.data ?? []).map((l) => ({ id: l.id, name: l.name })),
    courses: (courses.data ?? []).map((c) => ({
      id: c.id,
      name: `${c.code} — ${c.name}`,
      extra: c.code,
    })),
  };
}

export function resultsToCsv(
  header: ExamRecordHeader,
  rows: ResultStudentRow[],
  isTest: boolean,
): string {
  const lines: string[] = [];
  lines.push(`D4EXAM`);
  lines.push(isTest ? `TEST RESULT` : `EXAMINATION RESULT`);
  lines.push(`Course Code,${header.courseCode}`);
  lines.push(`Course,${header.courseName}`);
  lines.push(`Department,${header.departmentName}`);
  lines.push(`Level,${header.levelName}`);
  lines.push(`Semester,${header.semesterName}`);
  lines.push(`Academic Session,${header.sessionName}`);
  lines.push(`Assessment,${header.assessmentLabel}`);
  lines.push(`Date,${header.dateLabel}`);
  lines.push("");
  if (isTest) {
    lines.push(`Student Full Name,Matric Number,Department,Level,Score`);
    for (const r of rows) {
      const sc =
        r.score != null && r.maxScore != null
          ? `${r.score}/${r.maxScore}`
          : r.score != null
            ? String(r.score)
            : "—";
      lines.push(
        `"${r.fullName.replace(/"/g, '""')}",${r.matric},"${r.departmentName.replace(/"/g, '""')}","${r.levelName.replace(/"/g, '""')}",${sc}`,
      );
    }
  } else {
    lines.push(`Student Full Name,Matric Number,Department,Level,Score,Grade`);
    for (const r of rows) {
      const sc =
        r.score != null && r.maxScore != null
          ? `${r.score}/${r.maxScore}`
          : r.score != null
            ? String(r.score)
            : "—";
      lines.push(
        `"${r.fullName.replace(/"/g, '""')}",${r.matric},"${r.departmentName.replace(/"/g, '""')}","${r.levelName.replace(/"/g, '""')}",${sc},${r.grade || "—"}`,
      );
    }
  }
  return lines.join("\n");
}

/** Simple analytics for teacher analysis tab */
export function computeResultAnalytics(rows: ResultStudentRow[]) {
  const n = rows.length;
  if (!n) {
    return {
      count: 0,
      averagePct: null as number | null,
      passRate: null as number | null,
      failRate: null as number | null,
      highest: null as number | null,
      lowest: null as number | null,
      gradeDist: {} as Record<string, number>,
    };
  }
  const pcts = rows.map((r) => r.percentage).filter((p): p is number => p != null);
  const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  const pass = rows.filter((r) => (r.percentage ?? 0) >= 40 || (r.grade && r.grade !== "F")).length;
  const gradeDist: Record<string, number> = {};
  for (const r of rows) {
    const g = r.grade || "—";
    gradeDist[g] = (gradeDist[g] || 0) + 1;
  }
  return {
    count: n,
    averagePct: avg,
    passRate: (pass / n) * 100,
    failRate: ((n - pass) / n) * 100,
    highest: pcts.length ? Math.max(...pcts) : null,
    lowest: pcts.length ? Math.min(...pcts) : null,
    gradeDist,
  };
}
