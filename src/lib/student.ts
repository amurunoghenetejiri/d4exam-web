import { useQuery } from "@tanstack/react-query";
import { useSessionUser } from "@/lib/session";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { withOfflineCache } from "@/lib/offline-query";
import { OfflineKeys } from "@/lib/offline-cache";

export type StudentCourse = {
  id: string;
  code: string;
  name: string;
};

export type StudentContext = {
  studentId: string;
  matric: string | null;
  schoolId: string;
  profileId: string;
  fullName: string;
  email: string;
  schoolName: string | null;
  departmentId: string | null;
  levelId: string | null;
  facultyId: string | null;
  departmentName: string | null;
  facultyName: string | null;
  levelName: string | null;
  status: string;
  isActive: boolean;
  sessionName: string | null;
  semesterName: string | null;
  semesterId: string | null;
  courses: StudentCourse[];
  courseIds: string[];
};

export const STUDENT_VISIBLE_EXAM_STATUSES = [
  "published",
  "ongoing",
  "closed",
  "completed",
] as const;

export const STUDENT_STARTABLE_STATUSES = ["published", "ongoing"] as const;

function isCapSpa(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if ((window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA) return true;
    const host = (window.location.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
  } catch {
    /* ignore */
  }
  return false;
}

function isValidStudentContext(ctx: unknown): ctx is StudentContext {
  if (!ctx || typeof ctx !== "object") return false;
  const c = ctx as Partial<StudentContext>;
  return Boolean(c.studentId && c.profileId);
}

function parseRpcStudentContext(raw: unknown, sessionSchoolName?: string | null): StudentContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.studentId || !r.profileId) return null;
  const coursesRaw = Array.isArray(r.courses) ? r.courses : [];
  const courses: StudentCourse[] = coursesRaw
    .map((c) => {
      const row = c as { id?: string; code?: string; name?: string };
      if (!row?.id) return null;
      return { id: String(row.id), code: String(row.code || ""), name: String(row.name || "") };
    })
    .filter(Boolean) as StudentCourse[];
  const courseIds = Array.isArray(r.courseIds)
    ? (r.courseIds as unknown[]).map(String)
    : courses.map((c) => c.id);
  return {
    studentId: String(r.studentId),
    matric: r.matric != null ? String(r.matric) : null,
    schoolId: String(r.schoolId || ""),
    profileId: String(r.profileId),
    fullName: String(r.fullName || ""),
    email: String(r.email || ""),
    schoolName: (r.schoolName as string | null) ?? sessionSchoolName ?? null,
    departmentId: r.departmentId ? String(r.departmentId) : null,
    levelId: r.levelId ? String(r.levelId) : null,
    facultyId: r.facultyId ? String(r.facultyId) : null,
    departmentName: (r.departmentName as string | null) ?? null,
    facultyName: (r.facultyName as string | null) ?? null,
    levelName: (r.levelName as string | null) ?? null,
    status: String(r.status || "active"),
    isActive: Boolean(r.isActive ?? true),
    sessionName: (r.sessionName as string | null) ?? null,
    semesterName: (r.semesterName as string | null) ?? null,
    semesterId: r.semesterId ? String(r.semesterId) : null,
    courses,
    courseIds,
  };
}

async function loadStudentContextViaRpc(
  sessionSchoolName?: string | null,
): Promise<StudentContext | null> {
  const { supabase } = await import("@/integrations/supabase/client");
  // Ensure JWT is active for auth.uid() inside SECURITY DEFINER RPC
  try {
    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session?.access_token) {
      await supabase.auth.getUser();
    }
  } catch {
    /* continue */
  }
  const { data, error } = await supabase.rpc("get_my_student_context" as never);
  if (error) {
    console.warn("[student-context] rpc", error.message);
    return null;
  }
  return parseRpcStudentContext(data, sessionSchoolName);
}

async function loadStudentContextClient(
  uid: string,
  session: {
    profileId?: string;
    fullName?: string;
    email?: string;
    status?: string;
    schoolId?: string | null;
    schoolName?: string | null;
  } | null,
): Promise<StudentContext | null> {
  const { supabase } = await import("@/integrations/supabase/client");

  let profile: {
    id: string;
    full_name?: string | null;
    email?: string | null;
    status?: string | null;
    school_id?: string | null;
  } | null = null;

  try {
    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, email, status, school_id")
      .eq("auth_user_id", uid)
      .maybeSingle();
    profile = data;
  } catch {
    /* ignore */
  }

  if (!profile && session?.profileId) {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, email, status, school_id")
        .eq("id", session.profileId)
        .maybeSingle();
      profile = data;
    } catch {
      /* ignore */
    }
  }

  if (!profile) {
    profile = {
      id: session?.profileId || uid,
      full_name: session?.fullName || null,
      email: session?.email || null,
      status: session?.status || "active",
      school_id: session?.schoolId || null,
    };
  }

  const schoolId = (profile.school_id as string) || session?.schoolId || "";

  let student: Record<string, unknown> | null = null;

  try {
    const { data, error } = await supabase
      .from("students")
      .select(
        "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, full_name",
      )
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (!error && data) student = data as Record<string, unknown>;
  } catch {
    /* ignore */
  }

  if (!student) {
    try {
      const { data: p2 } = await supabase
        .from("profiles")
        .select("id")
        .eq("auth_user_id", uid)
        .maybeSingle();
      if (p2?.id) {
        const { data } = await supabase
          .from("students")
          .select(
            "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, full_name",
          )
          .eq("profile_id", p2.id)
          .maybeSingle();
        if (data) {
          student = data as Record<string, unknown>;
          profile = { ...profile, id: p2.id };
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!student && schoolId) {
    try {
      const { data: rows } = await supabase
        .from("students")
        .select(
          "id, matric_number, student_id, school_id, profile_id, department_id, level_id, faculty_id, status, full_name",
        )
        .eq("school_id", schoolId)
        .limit(500);
      student =
        ((rows ?? []) as Record<string, unknown>[]).find(
          (r) => String(r.profile_id || "") === String(profile!.id),
        ) ?? null;
    } catch {
      /* ignore */
    }
  }

  if (!student) return null;

  let departmentName: string | null = null;
  let facultyName: string | null = null;
  let levelName: string | null = null;
  const departmentId = (student.department_id as string | null) ?? null;
  const levelId = (student.level_id as string | null) ?? null;
  const facultyId = (student.faculty_id as string | null) ?? null;

  try {
    if (departmentId) {
      const { data } = await supabase.from("departments").select("name").eq("id", departmentId).maybeSingle();
      departmentName = data?.name ?? null;
    }
    if (facultyId) {
      const { data } = await supabase.from("faculties").select("name").eq("id", facultyId).maybeSingle();
      facultyName = data?.name ?? null;
    }
    if (levelId) {
      const { data } = await supabase.from("levels").select("name").eq("id", levelId).maybeSingle();
      levelName = data?.name ?? null;
    }
  } catch {
    /* optional */
  }

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
    departmentId,
    levelId,
    facultyId,
    departmentName,
    facultyName,
    levelName,
    status,
    isActive: status.toLowerCase() === "active",
    sessionName: null,
    semesterName: null,
    semesterId: null,
    courses,
    courseIds: courses.map((c) => c.id),
  };
}

export function useStudentContext() {
  const { data: session } = useSessionUser();

  return useQuery({
    queryKey: ["student-context", session?.profileId, session?.schoolId, session?.userId],
    enabled: Boolean(session?.userId),
    staleTime: 20_000,
    queryFn: async (): Promise<StudentContext | null> => {
      const uid = session?.userId;
      if (!uid) return null;

      return withOfflineCache(
        uid,
        OfflineKeys.studentContext,
        async () => {
          // 1) SECURITY DEFINER RPC — works on APK even when table RLS is picky
          try {
            const viaRpc = await loadStudentContextViaRpc(session?.schoolName);
            if (viaRpc) return viaRpc;
          } catch (e) {
            console.warn("[student-context] rpc path failed", e);
          }

          // 2) Website only: TanStack server fn
          if (!isCapSpa()) {
            try {
              const { getMyStudentContext } = await import("@/lib/student.server");
              const ctx = await getMyStudentContext();
              if (isValidStudentContext(ctx)) return ctx;
            } catch (e) {
              console.warn("[student-context] server fn failed", e);
            }
          }

          // 3) Direct client table reads
          return loadStudentContextClient(uid, session);
        },
        { schoolId: session?.schoolId, fallback: null, localFirst: false },
      );
    },
  });
}

export function useStudentRealtimeSync(enabled = true) {
  useRealtimeInvalidate(
    "student-context-sync",
    [{ table: "student_courses" }],
    [["student-context"]],
    enabled,
    2500,
  );
}

export type ExamCourseRef = {
  code?: string | null;
  name?: string | null;
  department_id?: string | null;
  level_id?: string | null;
} | null;

export function isStudentEligibleForExam(
  student: Pick<StudentContext, "schoolId" | "departmentId" | "levelId" | "courseIds"> | null | undefined,
  exam: {
    school_id?: string | null;
    course_id?: string | null;
    courses?: ExamCourseRef;
  } | null | undefined,
): boolean {
  if (!student || !exam) return false;
  if (exam.school_id && student.schoolId && String(exam.school_id) !== String(student.schoolId)) {
    return false;
  }
  if (student.schoolId && exam.school_id && String(student.schoolId) === String(exam.school_id)) {
    return true;
  }
  if (student.schoolId && !exam.school_id) return true;
  return false;
}

export function filterExamsForStudent<
  T extends {
    school_id?: string | null;
    course_id?: string | null;
    courses?: ExamCourseRef;
  },
>(
  student: Pick<StudentContext, "schoolId" | "departmentId" | "levelId" | "courseIds"> | null | undefined,
  exams: T[],
): T[] {
  if (!student) return [];
  return exams.filter((e) => isStudentEligibleForExam(student, e));
}

export function canStartExam(
  status: string,
  scheduledStart: string | null,
  scheduledEnd?: string | null,
): boolean {
  const s = status.toLowerCase();
  if (s === "ongoing") return true;
  if (s === "closed" || s === "completed" || s === "cancelled") return false;
  if (s !== "published") return false;
  const now = Date.now();
  if (scheduledEnd && new Date(scheduledEnd).getTime() < now) return false;
  if (!scheduledStart) return true;
  return new Date(scheduledStart).getTime() <= now;
}

export function examAvailability(
  status: string,
  scheduledStart: string | null,
  scheduledEnd: string | null,
): "available" | "upcoming" | "ended" | "missed" | "blocked" {
  const s = status.toLowerCase();
  if (s === "closed" || s === "completed" || s === "cancelled") return "ended";
  if (s === "ongoing") return "available";
  if (s !== "published") return "blocked";
  const now = Date.now();
  if (scheduledEnd && new Date(scheduledEnd).getTime() < now) return "missed";
  if (scheduledStart && new Date(scheduledStart).getTime() > now) return "upcoming";
  return "available";
}

export function isExamAttemptFinished(
  attemptStatus: string | null | undefined,
  hasResult?: boolean,
): boolean {
  if (hasResult) return true;
  const st = String(attemptStatus || "").toLowerCase();
  return st === "submitted" || st === "terminated" || st === "flagged";
}

export function formatExamWindow(start: string | null, end: string | null): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  if (start && end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return `From ${fmt(start)}`;
  return `Until ${fmt(end!)}`;
}
