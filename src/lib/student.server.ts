import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { StudentContext, StudentCourse } from "@/lib/student";

/**
 * Server-side student context.
 * Prefers service-role admin client; falls back to the authenticated user client
 * so student dashboards still work when SUPABASE_SERVICE_ROLE_KEY is not set.
 */
export const getMyStudentContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StudentContext | null> => {
    const userId = context.userId as string;

    type Db = typeof context.supabase;
    let db: Db = context.supabase;
    try {
      const mod = await import("@/integrations/supabase/client.server");
      if (mod.supabaseAdmin) db = mod.supabaseAdmin as unknown as Db;
    } catch (e) {
      console.warn("[student-context] admin client unavailable, using user client", e);
    }

    const { data: profileByAuth } = await db
      .from("profiles")
      .select("id, full_name, email, status, school_id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    let profile = profileByAuth;
    if (!profile?.id) {
      const { data: profileById } = await db
        .from("profiles")
        .select("id, full_name, email, status, school_id")
        .eq("id", userId)
        .maybeSingle();
      profile = profileById;
    }

    const profileId = (profile?.id as string | undefined) || userId;
    let schoolId = (profile?.school_id as string | undefined) || "";

    const studentSelect =
      "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, full_name, departments(name), faculties(name), levels(name)";

    let student: Record<string, unknown> | null = null;

    // Do NOT require profiles.school_id first — many student rows carry school_id themselves
    const { data: byProfile, error: byProfileErr } = await db
      .from("students")
      .select(studentSelect)
      .eq("profile_id", profileId)
      .maybeSingle();

    if (byProfileErr && /full_name/i.test(byProfileErr.message)) {
      const fb = await db
        .from("students")
        .select(
          "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, departments(name), faculties(name), levels(name)",
        )
        .eq("profile_id", profileId)
        .maybeSingle();
      student = (fb.data as Record<string, unknown> | null) ?? null;
    } else {
      student = (byProfile as Record<string, unknown> | null) ?? null;
    }

    if (!student && profile?.email) {
      const local = String(profile.email).split("@")[0] || "";
      const norm = local.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (norm.length >= 6) {
        let candQ = db.from("students").select(studentSelect).limit(5000);
        if (schoolId) candQ = candQ.eq("school_id", schoolId);
        const { data: candidates } = await candQ;
        const rows = (candidates ?? []) as Record<string, unknown>[];
        student =
          rows.find((r) => {
            const m = String(r.matric_number || r.student_id || "")
              .replace(/[^a-z0-9]/gi, "")
              .toLowerCase();
            return m && (norm.includes(m) || m.includes(norm));
          }) ?? null;
      }
    }

    if (!student) return null;

    schoolId = String(student.school_id || schoolId || "");
    if (!schoolId) return null;

    const departments = student.departments as { name?: string } | null;
    const faculties = student.faculties as { name?: string } | null;
    const levels = student.levels as { name?: string } | null;
    const status = String(student.status || "active");
    const departmentId = (student.department_id as string | null) ?? null;
    const levelId = (student.level_id as string | null) ?? null;

    const { data: school } = await db.from("schools").select("name").eq("id", schoolId).maybeSingle();

    let sessionName: string | null = null;
    let semesterName: string | null = null;
    let semesterId: string | null = null;
    try {
      const { data: activeSession } = await db
        .from("academic_sessions")
        .select("id, name")
        .eq("school_id", schoolId)
        .eq("status", "active")
        .maybeSingle();
      sessionName = (activeSession?.name as string | null) ?? null;
      if (activeSession?.id) {
        const { data: sem } = await db
          .from("semesters")
          .select("id, name")
          .eq("academic_session_id", activeSession.id)
          .eq("status", "active")
          .maybeSingle();
        semesterName = (sem?.name as string | null) ?? null;
        semesterId = (sem?.id as string | null) ?? null;
      }
    } catch {
      /* optional */
    }

    let courses: StudentCourse[] = [];
    const mapCourseRows = (rows: unknown[]): StudentCourse[] =>
      (rows ?? [])
        .map((row) => {
          const c = (row as { courses?: { id?: string; code?: string; name?: string } | null }).courses;
          if (!c?.id) return null;
          return { id: String(c.id), code: String(c.code || ""), name: String(c.name || "") };
        })
        .filter(Boolean) as StudentCourse[];
    try {
      const { data: sc } = await db
        .from("student_courses")
        .select("course_id, courses(id, code, name)")
        .eq("student_id", student.id as string);
      courses = mapCourseRows(sc ?? []);
    } catch {
      courses = [];
    }
    if (!courses.length) {
      try {
        const { data: en } = await db
          .from("course_enrollments")
          .select("course_id, courses(id, code, name)")
          .eq("student_id", student.id as string);
        courses = mapCourseRows(en ?? []);
      } catch {
        /* ignore */
      }
    }
    // Students self-enrol from Courses page — do not auto-map dept courses as enrolled.
    {
      const seen = new Set<string>();
      courses = courses.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
    }

    return {
      studentId: String(student.id),
      matric: (student.matric_number as string | null) ?? (student.student_id as string | null) ?? null,
      schoolId,
      profileId: (student.profile_id as string | null) ?? profileId,
      fullName:
        ((profile.full_name as string | null) || "").trim() ||
        ((student as { full_name?: string | null }).full_name || "").trim() ||
        (student.matric_number as string | null) ||
        "",
      email: (profile.email as string | null) || "",
      schoolName: (school?.name as string | null) ?? null,
      departmentId,
      levelId,
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
  });



/** Reliable school dashboard counts (service role — ignores RLS quirks). */
export const getSchoolDashboardCounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ schoolId: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const schoolId = data.schoolId;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("school_id")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    const { data: isSuper } = await supabaseAdmin.rpc("is_super_admin");
    const allowed =
      isSuper === true ||
      (profile?.school_id && String(profile.school_id) === schoolId);
    if (!allowed) throw new Error("Forbidden");

    const [students, teachers, officers, courses] = await Promise.all([
      supabaseAdmin.from("students").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
      supabaseAdmin.from("teachers").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
      supabaseAdmin.from("examination_officers").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
      supabaseAdmin.from("courses").select("id", { count: "exact", head: true }).eq("school_id", schoolId),
    ]);

    return {
      students: students.count ?? 0,
      teachers: teachers.count ?? 0,
      officers: officers.count ?? 0,
      courses: courses.count ?? 0,
    };
  });

/** Student self-enrol in a department course (bypasses RLS via admin client after ownership checks). */
export const enrolStudentInCourse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        courseId: z.string().uuid(),
        studentId: z.string().uuid().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const userId = context.userId as string;
    let db = context.supabase;
    try {
      const mod = await import("@/integrations/supabase/client.server");
      if (mod.supabaseAdmin) db = mod.supabaseAdmin as unknown as typeof db;
    } catch {
      /* user client */
    }

    const { data: profile } = await db
      .from("profiles")
      .select("id, school_id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!profile?.id || !profile.school_id) {
      throw new Error("Student profile not found.");
    }
    const schoolId = String(profile.school_id);
    const profileId = String(profile.id);

    const { data: student } = await db
      .from("students")
      .select("id, school_id, department_id, level_id, profile_id")
      .eq("profile_id", profileId)
      .eq("school_id", schoolId)
      .maybeSingle();
    if (!student?.id) {
      throw new Error("Student record not found.");
    }
    const studentId = String(student.id);
    if (data.studentId && String(data.studentId) !== studentId) {
      throw new Error("You can only enrol yourself.");
    }

    const { data: course, error: cErr } = await db
      .from("courses")
      .select("id, school_id, department_id, level_id, code, name")
      .eq("id", data.courseId)
      .maybeSingle();
    if (cErr || !course) throw new Error(cErr?.message || "Course not found.");
    if (String(course.school_id) !== schoolId) {
      throw new Error("Course is not in your school.");
    }
    if (
      student.department_id &&
      course.department_id &&
      String(student.department_id) !== String(course.department_id)
    ) {
      throw new Error("Course is not offered to your department.");
    }

    // Prefer student_courses (requires school_id)
    const scPayload = {
      student_id: studentId,
      course_id: data.courseId,
      school_id: schoolId,
      status: "enrolled",
    };
    const { error: scErr } = await db.from("student_courses").insert(scPayload as never);
    if (!scErr) {
      return {
        ok: true as const,
        course: {
          id: String(course.id),
          code: String(course.code || ""),
          name: String(course.name || ""),
        },
      };
    }
    // Unique violation = already enrolled
    if (/duplicate|unique/i.test(scErr.message || "")) {
      return {
        ok: true as const,
        course: {
          id: String(course.id),
          code: String(course.code || ""),
          name: String(course.name || ""),
        },
      };
    }

    // Fallback course_enrollments
    const { error: enErr } = await db.from("course_enrollments").insert({
      student_id: studentId,
      course_id: data.courseId,
      school_id: schoolId,
    } as never);
    if (enErr && !/duplicate|unique/i.test(enErr.message || "")) {
      throw new Error(scErr.message || enErr.message || "Could not enrol");
    }
    return {
      ok: true as const,
      course: {
        id: String(course.id),
        code: String(course.code || ""),
        name: String(course.name || ""),
      },
    };
  });
