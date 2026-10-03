import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BookOpen, CheckCircle2, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader, SectionCard, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useStudentContext, type StudentCourse } from "@/lib/student";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { withOfflineCache } from "@/lib/offline-query";
import { OfflineKeys } from "@/lib/offline-cache";
import { isOnlineNow } from "@/lib/offline-sync";

export const Route = createFileRoute("/student/courses")({
  head: () => ({
    meta: [
      { title: "My Courses — D4EXAM" },
      { name: "description", content: "Courses for your department and level. Enrol to sit related exams." },
    ],
  }),
  component: Page,
});

function Page() {
  const { data: session } = useSessionUser();
  const { data: student, isLoading } = useStudentContext();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const availableQ = useQuery({
    queryKey: [
      "student-available-courses",
      student?.schoolId,
      student?.departmentId,
      student?.levelId,
    ],
    enabled: Boolean(student?.schoolId && student?.departmentId),
    staleTime: 30_000,
    refetchInterval: isOnlineNow() ? 60_000 : false,
    queryFn: async (): Promise<StudentCourse[]> => {
      if (!student?.schoolId || !student.departmentId) return [];
      const uid = session?.userId ?? student.profileId;
      const cacheKey = `${OfflineKeys.courses}::${student.schoolId}::${student.departmentId}::${student.levelId ?? ""}`;
      return withOfflineCache(
        uid,
        cacheKey,
        async () => {
          const { data, error } = await supabase
            .from("courses")
            .select("id, code, name, level_id")
            .eq("school_id", student.schoolId)
            .eq("department_id", student.departmentId)
            .limit(400);
          if (error) {
            console.warn("[student-courses] available", error.message);
            return [] as StudentCourse[];
          }
          let rows = (data ?? []) as { id: string; code?: string; name?: string; level_id?: string | null }[];
          if (student.levelId) {
            const sameLevel = rows.filter((r) => !r.level_id || String(r.level_id) === String(student.levelId));
            if (sameLevel.length) rows = sameLevel;
          }
          return rows.map((c) => ({
            id: String(c.id),
            code: String(c.code || ""),
            name: String(c.name || ""),
          }));
        },
        { schoolId: student.schoolId, fallback: [] as StudentCourse[] },
      );
    },
  });

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;

  if (!student) {
    return (
      <EmptyState
        title="Student profile not found"
        description="Ask School Admin to add you under Academic Structure (department and level)."
      />
    );
  }

  const enrolled = student.courses ?? [];
  const enrolledIds = new Set(enrolled.map((c) => c.id));
  const available = (availableQ.data ?? []).filter((c) => !enrolledIds.has(c.id));
  const programme = [student.facultyName, student.departmentName, student.levelName]
    .filter(Boolean)
    .join(" · ");

  async function enroll(course: StudentCourse) {
    if (!student?.studentId) return;
    setBusyId(course.id);
    try {
      // Prefer server fn: resolves school_id from profile + service-role insert (RLS-safe)
      const { enrolStudentInCourse } = await import("@/lib/student.server");
      const res = await enrolStudentInCourse({
        data: { courseId: course.id, studentId: student.studentId },
      });
      if (!res?.ok) throw new Error("Could not enrol");
      toast.success(`Enrolled in ${course.code || course.name}`);
      await qc.invalidateQueries({ queryKey: ["student-context"] });
      await qc.invalidateQueries({ queryKey: ["student-available-courses"] });
    } catch (e) {
      const msg = (e as Error).message || "Could not enrol in course";
      // Fallback: client insert with school_id resolved from student context OR session
      if (/not found|Could not enrol|network|fetch/i.test(msg) && !/null value|not-null|RLS|row-level/i.test(msg)) {
        try {
          const schoolId =
            student.schoolId ||
            (session as { schoolId?: string } | undefined)?.schoolId ||
            null;
          if (!schoolId) {
            toast.error(
              "No school linked to your account. Ask School Admin to fix your profile (school_id).",
            );
            return;
          }
          const payload = {
            student_id: student.studentId,
            course_id: course.id,
            school_id: schoolId,
            status: "enrolled",
          };
          const { error: scErr } = await supabase.from("student_courses").insert(payload as never);
          if (scErr && !/duplicate|unique/i.test(scErr.message || "")) {
            throw new Error(scErr.message);
          }
          toast.success(`Enrolled in ${course.code || course.name}`);
          await qc.invalidateQueries({ queryKey: ["student-context"] });
          await qc.invalidateQueries({ queryKey: ["student-available-courses"] });
          return;
        } catch (e2) {
          toast.error((e2 as Error).message || msg);
          return;
        }
      }
      if (/row-level security|RLS|permission denied/i.test(msg)) {
        toast.error(
          "Enrolment blocked by security policy. School Admin can enrol you, or ensure server service role is configured.",
        );
      } else if (/null value.*school_id/i.test(msg)) {
        toast.error(
          "Your profile is missing school_id. Ask School Admin to link your account to the school.",
        );
      } else {
        toast.error(msg);
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="My Courses"
        description={
          [student.matric, programme].filter(Boolean).join(" · ") || "Your programme courses"
        }
      />

      {(student.facultyName || student.departmentName || student.levelName) && (
        <div className="mb-6 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          <p className="font-semibold text-slate-900">Your programme</p>
          <p className="mt-1 text-slate-600">
            {[student.facultyName, student.departmentName, student.levelName]
              .filter(Boolean)
              .join(" → ") || "—"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Courses offered to your department appear below. Enrol in a course to receive its exams
            and related notifications.
          </p>
        </div>
      )}

      <SectionCard title={`Enrolled (${enrolled.length})`}>
        {enrolled.length === 0 ? (
          <EmptyState
            title="Not enrolled in any course yet"
            description="Browse available courses for your department below and enrol to sit exams."
            icon={BookOpen}
          />
        ) : (
          <ul className="space-y-3">
            {enrolled.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white p-3.5 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                    <CheckCircle2 className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-sm font-bold text-slate-900">
                      {c.code} — {c.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {[student.departmentName, student.levelName].filter(Boolean).join(" · ") ||
                        "Enrolled"}
                    </p>
                  </div>
                </div>
                <Badge variant="secondary" className="bg-emerald-50 text-emerald-700">
                  Enrolled
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <div className="mt-6">
        <SectionCard
          title={`Available to enrol (${availableQ.isLoading ? "…" : available.length})`}
          description="Courses assigned to your department (and level when set)"
        >
          {availableQ.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading courses…
            </p>
          ) : available.length === 0 ? (
            <EmptyState
              title="No more courses to enrol"
              description={
                student.departmentId
                  ? enrolled.length
                    ? "You are enrolled in all courses currently offered for your department."
                    : "Admin has not offered any courses for your department/level yet."
                  : "Your account is not linked to a department yet. Ask School Admin to place you under the correct department and level."
              }
              icon={BookOpen}
            />
          ) : (
            <ul className="space-y-3">
              {available.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white p-3.5 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <BookOpen className="h-5 w-5" />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-slate-900">
                        {c.code} — {c.name}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {[student.departmentName, student.levelName].filter(Boolean).join(" · ") ||
                          "Programme course"}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="font-semibold"
                    disabled={busyId === c.id}
                    onClick={() => void enroll(c)}
                  >
                    {busyId === c.id ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : null}
                    Enrol
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}
