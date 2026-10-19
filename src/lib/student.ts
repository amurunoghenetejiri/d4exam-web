// @ts-nocheck
import { useQuery } from "@tanstack/react-query";
import { useSessionUser } from "@/lib/session";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { withOfflineCache } from "@/lib/offline-query";
import { OfflineKeys } from "@/lib/offline-cache";
import { fetchStudentContextClient } from "@/lib/student-context-fetch";
import { seedLoginSchoolContext } from "@/lib/session";

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

/**
 * Students only see exams the officer has POSTed.
 * approved / scheduled alone must NOT appear on the student list.
 */
export const STUDENT_VISIBLE_EXAM_STATUSES = [
  "published",
  "ongoing",
  "closed",
  "completed",
] as const;

export const STUDENT_STARTABLE_STATUSES = ["published", "ongoing"] as const;

export function useStudentContext() {
  const { data: session } = useSessionUser();

  return useQuery({
    queryKey: ["student-context", session?.profileId, session?.schoolId, session?.userId],
    enabled: Boolean(session?.userId),
    staleTime: 20_000,
    queryFn: async (): Promise<StudentContext | null> => {
      const uid = session?.userId;
      return withOfflineCache(
        uid,
        OfflineKeys.studentContext,
        async () => {
          const ctx = await fetchStudentContextClient(session);
          if (ctx?.schoolId) {
            try {
              seedLoginSchoolContext(ctx.schoolId, null);
            } catch { /* ignore */ }
          }
          // Never permanently cache a null context — allow retry on next visit
          return ctx;
        },
        { schoolId: session?.schoolId, fallback: null },
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
  if (scheduledEnd && new Date(scheduledEnd).getTime() < now) {
    return "missed";
  }
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
