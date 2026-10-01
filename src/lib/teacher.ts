import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSessionUser } from "@/lib/session";
import { withOfflineCache } from "@/lib/offline-query";
import { OfflineKeys } from "@/lib/offline-cache";

export type TeacherCourse = {
  id: string;
  code: string;
  name: string;
  credit_units: number;
  status: string;
};

export type TeacherContext = {
  teacherId: string;
  staffId: string;
  schoolId: string;
  profileId: string;
  fullName: string;
  email: string;
  schoolName: string | null;
  courses: TeacherCourse[];
  courseIds: string[];
};

type TeacherRow = {
  id: string;
  staff_id: string;
  school_id: string;
  profile_id: string | null;
};

function parseRpcTeacherContext(raw: unknown, session?: { fullName?: string; email?: string; schoolName?: string | null }): TeacherContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.teacherId || !r.profileId) return null;
  const coursesRaw = Array.isArray(r.courses) ? r.courses : [];
  const courses: TeacherCourse[] = coursesRaw
    .map((c) => {
      const row = c as { id?: string; code?: string; name?: string; credit_units?: number; status?: string };
      if (!row?.id) return null;
      return {
        id: String(row.id),
        code: String(row.code || ""),
        name: String(row.name || ""),
        credit_units: Number(row.credit_units ?? 0),
        status: String(row.status || "active"),
      };
    })
    .filter(Boolean) as TeacherCourse[];
  const courseIds = Array.isArray(r.courseIds)
    ? (r.courseIds as unknown[]).map(String)
    : courses.map((c) => c.id);
  return {
    teacherId: String(r.teacherId),
    staffId: String(r.staffId || ""),
    schoolId: String(r.schoolId || ""),
    profileId: String(r.profileId),
    fullName: String(r.fullName || session?.fullName || ""),
    email: String(r.email || session?.email || ""),
    schoolName: (r.schoolName as string | null) ?? session?.schoolName ?? null,
    courses,
    courseIds,
  };
}

async function loadTeacherContextViaRpc(
  session?: { fullName?: string; email?: string; schoolName?: string | null },
): Promise<TeacherContext | null> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session?.access_token) {
      await supabase.auth.getUser();
    }
  } catch {
    /* continue */
  }
  const { data, error } = await supabase.rpc("get_my_teacher_context" as never);
  if (error) {
    console.warn("[teacher-context] rpc", error.message);
    return null;
  }
  return parseRpcTeacherContext(data, session);
}

async function resolveTeacherRow(
  profileId: string,
  schoolId: string | null,
  authUserId: string,
): Promise<TeacherRow | null> {
  if (profileId && schoolId) {
    const { data, error } = await supabase
      .from("teachers")
      .select("id, staff_id, school_id, profile_id")
      .eq("profile_id", profileId)
      .eq("school_id", schoolId)
      .maybeSingle();
    if (!error && data) return data as TeacherRow;
  }

  if (profileId) {
    const { data, error } = await supabase
      .from("teachers")
      .select("id, staff_id, school_id, profile_id")
      .eq("profile_id", profileId)
      .maybeSingle();
    if (!error && data) return data as TeacherRow;
  }

  if (authUserId) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("id, school_id")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (prof?.id && prof.id !== profileId) {
      let q = supabase
        .from("teachers")
        .select("id, staff_id, school_id, profile_id")
        .eq("profile_id", prof.id);
      if (schoolId) q = q.eq("school_id", schoolId);
      const { data, error } = await q.maybeSingle();
      if (!error && data) return data as TeacherRow;
      if (schoolId) {
        const { data: anySchool } = await supabase
          .from("teachers")
          .select("id, staff_id, school_id, profile_id")
          .eq("profile_id", prof.id)
          .maybeSingle();
        if (anySchool) return anySchool as TeacherRow;
      }
    }
  }

  return null;
}

/**
 * Loads the signed-in teacher record and only courses assigned by admin
 * via teacher_courses. Local-first offline reads.
 */
export function useTeacherContext() {
  const { data: session } = useSessionUser();

  const isTeacher =
    session?.role === "teacher" ||
    (Array.isArray(session?.roles) && session.roles.includes("teacher"));

  return useQuery({
    queryKey: ["teacher-context", session?.profileId, session?.schoolId, session?.userId],
    enabled: Boolean(session?.userId && (session?.profileId || isTeacher)),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: true,
    networkMode: "offlineFirst",
    retry: 1,
    queryFn: async (): Promise<TeacherContext | null> => {
      if (!session?.userId) return null;
      const uid = session.userId;
      const profileId: string = session.profileId || uid;
      const schoolId: string | null = session.schoolId;

      return withOfflineCache(
        uid,
        OfflineKeys.teacherContext,
        async () => {
          // 1) SECURITY DEFINER RPC (APK-safe)
          try {
            const viaRpc = await loadTeacherContextViaRpc(session);
            if (viaRpc) return viaRpc;
          } catch (e) {
            console.warn("[teacher-context] rpc failed", e);
          }

          // 2) Direct table reads
          const teacher = await resolveTeacherRow(profileId, schoolId, uid);
          if (!teacher) return null;

          const effectiveSchoolId = teacher.school_id || schoolId;
          if (!effectiveSchoolId) return null;

          const { data: links, error: lErr } = await supabase
            .from("teacher_courses")
            .select("course_id, courses(id, code, name, credit_units, status)")
            .eq("teacher_id", teacher.id)
            .eq("school_id", effectiveSchoolId);

          if (lErr) throw lErr;

          const courses: TeacherCourse[] = [];
          for (const row of links ?? []) {
            const c = row.courses as
              | { id: string; code: string; name: string; credit_units: number; status: string }
              | null
              | undefined;
            if (c?.id) {
              courses.push({
                id: c.id,
                code: c.code,
                name: c.name,
                credit_units: c.credit_units ?? 0,
                status: c.status ?? "active",
              });
            }
          }

          courses.sort((a, b) => a.code.localeCompare(b.code));

          return {
            teacherId: teacher.id,
            staffId: teacher.staff_id,
            schoolId: effectiveSchoolId,
            profileId: teacher.profile_id ?? profileId,
            fullName: session.fullName,
            email: session.email,
            schoolName: session.schoolName,
            courses,
            courseIds: courses.map((c) => c.id),
          };
        },
        { schoolId: schoolId ?? undefined, fallback: null, localFirst: false },
      );
    },
  });
}
