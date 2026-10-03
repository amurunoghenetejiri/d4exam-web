import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, Loader2, Mail, User } from "lucide-react";
import { StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/student/$id")({
  head: () => ({ meta: [{ title: "Student Profile — D4EXAM" }] }),
  component: Page,
});

function Page() {
  const { id } = Route.useParams();
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;

  useRealtimeInvalidate(
    "admin-student-detail",
    [{ table: "students" }, { table: "student_courses" }, { table: "courses" }, { table: "exam_attempts" }],
    [["admin-student", id], ["admin-student-courses", id], ["admin-student-eligible", id]],
    Boolean(id && schoolId),
  );

  const studentQ = useQuery({
    queryKey: ["admin-student", id, schoolId],
    enabled: Boolean(id && schoolId),
    queryFn: async () => {
      // Production: no students.full_name / admission_number — names on profiles only
      const selectFull =
        "id, student_id, matric_number, status, faculty_id, department_id, level_id, academic_session_id, school_id, profile_id, created_at, profiles(full_name, email, phone), departments(name, code), faculties(name, code), levels(name, code)";
      const selectBasic =
        "id, student_id, matric_number, status, faculty_id, department_id, level_id, school_id, profile_id, created_at, profiles(full_name, email)";
      const res = await supabase
        .from("students")
        .select(selectFull)
        .eq("id", id)
        .eq("school_id", schoolId!)
        .maybeSingle();
      if (!res.error) return res.data;
      const res2 = await supabase
        .from("students")
        .select(selectBasic)
        .eq("id", id)
        .eq("school_id", schoolId!)
        .maybeSingle();
      if (res2.error) throw res2.error;
      return res2.data;
    },
  });

  const activeSemQ = useQuery({
    queryKey: ["admin-student-active-semester", schoolId],
    enabled: Boolean(schoolId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data: sessions } = await supabase
        .from("academic_sessions")
        .select("id, name, status")
        .eq("school_id", schoolId!)
        .order("created_at", { ascending: false })
        .limit(20);
      const activeSession =
        (sessions ?? []).find((s) => String(s.status).toLowerCase() === "active") ??
        (sessions ?? [])[0] ??
        null;
      let semester: { id: string; name: string } | null = null;
      if (activeSession?.id) {
        const { data: semesters } = await supabase
          .from("semesters")
          .select("id, name, status")
          .eq("school_id", schoolId!)
          .eq("academic_session_id", activeSession.id)
          .order("created_at", { ascending: false })
          .limit(10);
        const activeSem =
          (semesters ?? []).find((s) => String(s.status).toLowerCase() === "active") ??
          (semesters ?? [])[0] ??
          null;
        if (activeSem) semester = { id: activeSem.id as string, name: activeSem.name as string };
      }
      if (!semester) {
        const { data: anySem } = await supabase
          .from("semesters")
          .select("id, name, status")
          .eq("school_id", schoolId!)
          .order("created_at", { ascending: false })
          .limit(10);
        const activeSem =
          (anySem ?? []).find((s) => String(s.status).toLowerCase() === "active") ??
          (anySem ?? [])[0] ??
          null;
        if (activeSem) semester = { id: activeSem.id as string, name: activeSem.name as string };
      }
      return {
        sessionName: (activeSession?.name as string | null) ?? null,
        semester,
      };
    },
  });

  const enrolledQ = useQuery({
    queryKey: ["admin-student-courses", id, schoolId],
    enabled: Boolean(id && schoolId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("student_courses")
        .select("id, status, semester_id, courses(id, code, name, credit_units, semester_id)")
        .eq("student_id", id)
        .eq("school_id", schoolId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  const eligibleQ = useQuery({
    queryKey: [
      "admin-student-eligible",
      id,
      schoolId,
      studentQ.data?.department_id,
      studentQ.data?.level_id,
      activeSemQ.data?.semester?.id,
    ],
    enabled: Boolean(schoolId && (studentQ.data?.department_id || studentQ.data?.level_id)),
    queryFn: async () => {
      const semesterId = activeSemQ.data?.semester?.id ?? null;
      let q = supabase
        .from("courses")
        .select("id, code, name, credit_units, status, department_id, level_id, semester_id, semesters(name)")
        .eq("school_id", schoolId!)
        .eq("status", "active")
        .order("code")
        .limit(150);
      if (studentQ.data?.department_id) {
        q = q.or(`department_id.eq.${studentQ.data.department_id},department_id.is.null`);
      }
      if (studentQ.data?.level_id) {
        q = q.or(`level_id.eq.${studentQ.data.level_id},level_id.is.null`);
      }
      if (semesterId) q = q.or(`semester_id.eq.${semesterId},semester_id.is.null`);
      const { data, error } = await q;
      if (error) {
        let q2 = supabase
          .from("courses")
          .select("id, code, name, credit_units, status, department_id, level_id")
          .eq("school_id", schoolId!)
          .eq("status", "active")
          .order("code")
          .limit(150);
        if (studentQ.data?.department_id) {
          q2 = q2.or(`department_id.eq.${studentQ.data.department_id},department_id.is.null`);
        }
        if (studentQ.data?.level_id) {
          q2 = q2.or(`level_id.eq.${studentQ.data.level_id},level_id.is.null`);
        }
        const { data: d2, error: e2 } = await q2;
        if (e2) throw e2;
        return d2 ?? [];
      }
      return data ?? [];
    },
  });

  const attemptsQ = useQuery({
    queryKey: ["admin-student-attempts", id, schoolId],
    enabled: Boolean(id && schoolId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exam_attempts")
        .select("id, status, started_at, submitted_at, exam_id, examinations(title, courses(code, name))")
        .eq("student_id", id)
        .eq("school_id", schoolId!)
        .order("started_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const s = studentQ.data;
  const name =
    ((s?.profiles as { full_name?: string } | null)?.full_name as string | null)?.trim() ||
    (s?.matric_number as string | null) ||
    (s?.student_id as string | null) ||
    "Student";
  const matric = (s?.matric_number as string | null) || (s?.student_id as string | null) || "—";
  const email = (s?.profiles as { email?: string } | null)?.email ?? "—";
  const department = (s?.departments as { name?: string } | null)?.name || "—";
  const faculty = (s?.faculties as { name?: string } | null)?.name || "—";
  const level = (s?.levels as { name?: string } | null)?.name || "—";

  const enrolled = enrolledQ.data ?? [];
  const eligible = eligibleQ.data ?? [];
  const enrolledIds = useMemo(
    () => new Set(enrolled.map((c) => String((c as { courses?: { id?: string } }).courses?.id ?? ""))),
    [enrolled],
  );

  const courseList =
    enrolled.length > 0
      ? enrolled.map((c) => {
          const course = (c as { courses?: { id?: string; code?: string; name?: string; credit_units?: number } | null }).courses;
          return {
            id: String(course?.id ?? (c as { id: string }).id),
            code: course?.code ?? "—",
            name: course?.name ?? "",
            units: course?.credit_units,
            source: "enrolled" as const,
            rowId: (c as { id: string }).id,
          };
        })
      : eligible.map((c) => ({
          id: String((c as { id: string }).id),
          code: String((c as { code?: string }).code ?? "—"),
          name: String((c as { name?: string }).name ?? ""),
          units: (c as { credit_units?: number }).credit_units,
          source: "eligible" as const,
          rowId: null as string | null,
        }));

  async function enrollCourse(courseId: string) {
    if (!schoolId || !s) return;
    try {
      const { error } = await supabase.from("student_courses").insert({
        school_id: schoolId,
        student_id: id,
        course_id: courseId,
        semester_id: activeSemQ.data?.semester?.id ?? null,
        status: "active",
      } as never);
      if (error) throw error;
      toast.success("Course enrolled");
      await enrolledQ.refetch();
      await eligibleQ.refetch();
    } catch (e) {
      toast.error((e as Error).message || "Could not enroll");
    }
  }

  async function unenrollCourse(rowId: string) {
    if (!schoolId) return;
    try {
      const { error } = await supabase
        .from("student_courses")
        .delete()
        .eq("id", rowId)
        .eq("school_id", schoolId);
      if (error) throw error;
      toast.success("Course removed");
      await enrolledQ.refetch();
    } catch (e) {
      toast.error((e as Error).message || "Could not remove");
    }
  }

  if (studentQ.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading student…
        </p>
      </div>
    );
  }

  if (!s) {
    return (
      <div className="p-6 text-center">
        <p className="font-bold">Student not found</p>
        <Button className="mt-4" asChild>
          <Link to="/admin/students">Back</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/admin/students">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Link>
        </Button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-extrabold text-slate-900 sm:text-2xl">{name}</h1>
            <p className="mt-1 text-sm text-slate-500">
              <span className="font-semibold text-slate-700">{matric}</span>
              {email && email !== "—" ? ` · ${email}` : ""}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-slate-600">
              <User className="h-4 w-4" /> {faculty} · {department} · {level}
            </p>
          </div>
          <StatusBadge status={String(s.status || "active")} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Info label="Faculty / College" value={faculty} />
          <Info label="Department" value={department} />
          <Info label="Level" value={level} />
          <Info
            label="Semester"
            value={
              [activeSemQ.data?.semester?.name, activeSemQ.data?.sessionName].filter(Boolean).join(" · ") ||
              "—"
            }
          />
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
          <BookOpen className="h-4 w-4 text-primary" /> Courses
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          {department} · {level}
          {!s.department_id
            ? " — Assign department and level so eligibility can be resolved."
            : ""}
        </p>
        {courseList.length === 0 ? (
          <EmptyState
            title="No courses"
            description={
              !s.department_id
                ? "Assign department and level so eligibility can be resolved."
                : "No courses match department, level and active semester. Tag courses under Courses."
            }
          />
        ) : (
          <ul className="mt-3 space-y-2">
            {courseList.map((c) => (
              <li
                key={c.id + (c.rowId || "")}
                className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {c.code} {c.name ? `· ${c.name}` : ""}
                  </p>
                  <p className="text-xs text-slate-500">
                    {c.units != null ? `${c.units} units` : ""}
                    {c.source === "enrolled" ? " · enrolled" : " · eligible"}
                  </p>
                </div>
                {c.source === "eligible" ? (
                  <Button size="sm" variant="outline" onClick={() => enrollCourse(c.id)}>
                    Enroll
                  </Button>
                ) : c.rowId ? (
                  <Button size="sm" variant="ghost" onClick={() => unenrollCourse(c.rowId!)}>
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 className="text-base font-bold text-slate-900">Exam activity</h2>
        {(attemptsQ.data ?? []).length === 0 ? (
          <EmptyState title="No attempts yet" description="Exam attempts for this student will appear here." />
        ) : (
          <ul className="mt-3 space-y-2">
            {(attemptsQ.data ?? []).map((a) => {
              const exam = (a as { examinations?: { title?: string; courses?: { code?: string; name?: string } | null } | null }).examinations;
              const title = exam?.title || "Exam";
              const course = exam?.courses;
              return (
                <li key={(a as { id: string }).id} className="flex items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
                    <p className="text-xs text-slate-500">
                      {course?.code ? `${course.code} · ` : ""}
                      {(a as { started_at?: string }).started_at
                        ? new Date((a as { started_at: string }).started_at).toLocaleString()
                        : ""}
                    </p>
                  </div>
                  <StatusBadge status={String((a as { status?: string }).status || "")} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 truncate text-sm font-bold text-slate-900">{value}</p>
    </div>
  );
}
