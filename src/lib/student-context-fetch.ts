// @ts-nocheck
import type { StudentContext, StudentCourse } from "@/lib/student";

/**
 * Resolve student context: RPC (works on Cap SPA) → server fn → direct client queries.
 */
export async function fetchStudentContextClient(session: {
  userId?: string | null;
  profileId?: string | null;
  schoolId?: string | null;
  schoolName?: string | null;
  email?: string | null;
  fullName?: string | null;
  status?: string | null;
} | null): Promise<StudentContext | null> {
  const uid = session?.userId;
  if (!uid) return null;

  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      "get_my_student_context" as never,
    );
    if (rpcErr) console.warn("[student-context] rpc", rpcErr.message);
    if (rpcData && typeof rpcData === "object") {
      const raw = rpcData as Record<string, unknown>;
      const studentId = String(raw.studentId || raw.student_id || "");
      if (studentId) {
        const coursesRaw = (raw.courses as StudentCourse[] | null) || [];
        const courseIdsRaw =
          (raw.courseIds as string[] | null) ||
          (raw.course_ids as string[] | null) ||
          coursesRaw.map((c) => c.id);
        return {
          studentId,
          matric: (raw.matric as string | null) ?? null,
          schoolId: String(raw.schoolId || raw.school_id || session?.schoolId || ""),
          profileId: String(raw.profileId || raw.profile_id || session?.profileId || ""),
          fullName: String(raw.fullName || raw.full_name || "").trim(),
          email: String(raw.email || session?.email || ""),
          schoolName: (raw.schoolName as string | null) ?? session?.schoolName ?? null,
          departmentId:
            (raw.departmentId as string | null) ?? (raw.department_id as string | null) ?? null,
          levelId: (raw.levelId as string | null) ?? (raw.level_id as string | null) ?? null,
          facultyId: (raw.facultyId as string | null) ?? (raw.faculty_id as string | null) ?? null,
          departmentName: (raw.departmentName as string | null) ?? null,
          facultyName: (raw.facultyName as string | null) ?? null,
          levelName: (raw.levelName as string | null) ?? null,
          status: String(raw.status || "active"),
          isActive: Boolean(
            raw.isActive ?? String(raw.status || "active").toLowerCase() === "active",
          ),
          sessionName: (raw.sessionName as string | null) ?? null,
          semesterName: (raw.semesterName as string | null) ?? null,
          semesterId: (raw.semesterId as string | null) ?? null,
          courses: coursesRaw,
          courseIds: (courseIdsRaw || []).map(String),
        } as StudentContext;
      }
    }
  } catch (e) {
    console.warn("[student-context] rpc failed", e);
  }

  try {
    const { getMyStudentContext } = await import("@/lib/student.server");
    const ctx = (await getMyStudentContext()) as StudentContext | { error?: string } | null;
    if (ctx && (ctx as StudentContext).studentId) return ctx as StudentContext;
  } catch (e) {
    console.warn("[student-context] server fn failed", e);
  }

  try {
    const { supabase } = await import("@/integrations/supabase/client");
    let profileQ = await supabase
      .from("profiles")
      .select("id, full_name, email, status, school_id")
      .eq("auth_user_id", uid)
      .maybeSingle();
    let profile = profileQ.data;
    if (!profile && session?.profileId) {
      const byId = await supabase
        .from("profiles")
        .select("id, full_name, email, status, school_id")
        .eq("id", session.profileId)
        .maybeSingle();
      profile = byId.data;
    }
    if (!profile) {
      profile = {
        id: session?.profileId || uid,
        full_name: session?.fullName || null,
        email: session?.email || null,
        status: session?.status || "active",
        school_id: session?.schoolId || null,
      } as typeof profile;
    }
    const schoolId = (profile.school_id as string) || session?.schoolId || "";
    let studentQ = await supabase
      .from("students")
      .select(
        "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, full_name, departments(name), faculties(name), levels(name)",
      )
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (studentQ.error && /full_name/i.test(studentQ.error.message || "")) {
      studentQ = await supabase
        .from("students")
        .select(
          "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, departments(name), faculties(name), levels(name)",
        )
        .eq("profile_id", profile.id)
        .maybeSingle();
    }
    let student = studentQ.data as Record<string, unknown> | null;
    if (!student) {
      // profile_id may equal auth uid on legacy rows
      const byAuth = await supabase
        .from("students")
        .select(
          "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, full_name, departments(name), faculties(name), levels(name)",
        )
        .eq("profile_id", uid)
        .maybeSingle();
      if (byAuth.data) student = byAuth.data as Record<string, unknown>;
    }
    if (!student && schoolId) {
      const alt = await supabase
        .from("students")
        .select(
          "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, full_name, departments(name), faculties(name), levels(name)",
        )
        .eq("school_id", schoolId)
        .limit(800);
      const rows = (alt.data ?? []) as Record<string, unknown>[];
      student =
        rows.find((r) => String(r.profile_id || "") === String(profile!.id)) ||
        rows.find((r) => String(r.profile_id || "") === String(uid)) ||
        null;
    }
    // Last resort: any student row linked to this profile id without school filter (RLS still applies)
    if (!student) {
      const any = await supabase
        .from("students")
        .select(
          "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, full_name, departments(name), faculties(name), levels(name)",
        )
        .or(`profile_id.eq.${profile.id},profile_id.eq.${uid}`)
        .limit(5);
      if (any.data?.[0]) student = any.data[0] as Record<string, unknown>;
    }
    if (!student) return null;
    const departments = student.departments as { name?: string } | null;
    const faculties = student.faculties as { name?: string } | null;
    const levels = student.levels as { name?: string } | null;
    
    // Hydrate semester/session for dashboard display
    let sessionName: string | null = null;
    let semesterName: string | null = null;
    let semesterId: string | null = null;
    try {
      const sid = String(student.school_id || schoolId || "");
      if (sid) {
        const { data: asess } = await supabase
          .from("academic_sessions")
          .select("id, name")
          .eq("school_id", sid)
          .eq("status", "active")
          .maybeSingle();
        sessionName = (asess?.name as string) || null;
        let semQ = await supabase
          .from("semesters")
          .select("id, name")
          .eq("school_id", sid)
          .eq("status", "active")
          .limit(1)
          .maybeSingle();
        if (!semQ.data) {
          semQ = await supabase.from("semesters").select("id, name").eq("school_id", sid).limit(1).maybeSingle();
        }
        semesterName = (semQ.data?.name as string) || sessionName;
        semesterId = (semQ.data?.id as string) || null;
      }
    } catch { /* ignore */ }

    const status = String(student.status || "active");
    const studentId = String(student.id);
    let courses: StudentCourse[] = [];
    const mapRows = (rows: unknown[]): StudentCourse[] =>
      (rows ?? [])
        .map((row) => {
          const c = (row as { courses?: { id?: string; code?: string; name?: string } | null }).courses;
          if (!c?.id) return null;
          return { id: String(c.id), code: String(c.code || ""), name: String(c.name || "") };
        })
        .filter(Boolean) as StudentCourse[];
    try {
      const { data: sc } = await supabase
        .from("student_courses")
        .select("course_id, courses(id, code, name)")
        .eq("student_id", studentId)
        .limit(300);
      courses = mapRows(sc ?? []);
    } catch {
      courses = [];
    }
    if (!courses.length) {
      try {
        const { data: en } = await supabase
          .from("course_enrollments")
          .select("course_id, courses(id, code, name)")
          .eq("student_id", studentId)
          .limit(300);
        courses = mapRows(en ?? []);
      } catch {
        /* ignore */
      }
    }
    const seen = new Set<string>();
    courses = courses.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    return {
      studentId,
      matric:
        (student.matric_number as string | null) ?? (student.student_id as string | null) ?? null,
      schoolId: String(student.school_id || schoolId),
      profileId: String(profile.id),
      fullName:
        (profile.full_name || "").trim() ||
        String((student as { full_name?: string | null }).full_name || "").trim() ||
        String(student.matric_number || ""),
      email: (profile.email as string) || "",
      schoolName: session?.schoolName ?? null,
      departmentId: (student.department_id as string | null) ?? null,
      levelId: (student.level_id as string | null) ?? null,
      facultyId: (student.faculty_id as string | null) ?? null,
      departmentName: departments?.name ?? null,
      facultyName: faculties?.name ?? null,
      levelName: levels?.name ?? null,
      status,
      isActive: status.toLowerCase() === "active",
      sessionName,
      semesterName,
      semesterId,
      courses,
      courseIds: courses.map((c) => c.id),
    };
  } catch (e) {
    console.warn("[student-context] client fallback failed", e);
    return null;
  }
}
