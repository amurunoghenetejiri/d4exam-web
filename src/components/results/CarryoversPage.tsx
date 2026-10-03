import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, UserRound } from "lucide-react";
import { PageHeader, SectionCard, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Student = {
  id: string;
  full_name: string | null;
  matric_number: string | null;
  student_id: string;
  level_id: string | null;
  department_id: string | null;
  levels?: { name?: string } | null;
  departments?: { name?: string } | null;
};

type Course = { id: string; code: string; name: string; level_id: string | null };
type Level = { id: string; name: string };
type Carry = {
  id: string;
  student_id: string;
  course_id: string;
  original_level_id: string | null;
  reason: string | null;
  status: string;
  students?: Student | null;
  courses?: Course | null;
  levels?: Level | null;
};

export function CarryoversPage() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const qc = useQueryClient();
  const [studentId, setStudentId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [levelId, setLevelId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [studentSearch, setStudentSearch] = useState("");

  const studentsQ = useQuery({
    queryKey: ["carry-students", schoolId],
    enabled: Boolean(schoolId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("students")
        .select("id, matric_number, student_id, level_id, department_id, profile_id, levels(name), departments(name), profiles(full_name)")
        .eq("school_id", schoolId!)
        .order("full_name")
        .limit(800);
      if (error) throw error;
      return (data ?? []) as Student[];
    },
  });

  const coursesQ = useQuery({
    queryKey: ["carry-courses", schoolId],
    enabled: Boolean(schoolId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courses")
        .select("id, code, name, level_id")
        .eq("school_id", schoolId!)
        .order("code")
        .limit(500);
      if (error) throw error;
      return (data ?? []) as Course[];
    },
  });

  const levelsQ = useQuery({
    queryKey: ["carry-levels", schoolId],
    enabled: Boolean(schoolId),
    queryFn: async () => {
      const { data } = await supabase.from("levels").select("id, name").eq("school_id", schoolId!).order("name");
      return (data ?? []) as Level[];
    },
  });

  const listQ = useQuery({
    queryKey: ["course-carryovers", schoolId],
    enabled: Boolean(schoolId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("course_carryovers")
        .select(
          "id, student_id, course_id, original_level_id, reason, status, students(id, matric_number, student_id, profiles(full_name), levels(name)), courses(id, code, name), levels:original_level_id(name)",
        )
        .eq("school_id", schoolId!)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) {
        if (/relation|does not exist|schema cache/i.test(error.message)) {
          return [] as Carry[];
        }
        throw error;
      }
      return (data ?? []) as unknown as Carry[];
    },
  });

  const students = studentsQ.data ?? [];
  const courses = coursesQ.data ?? [];
  const levels = levelsQ.data ?? [];
  const rows = listQ.data ?? [];

  const filteredStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    if (!q) return students.slice(0, 80);
    return students
      .filter(
        (s) =>
          (s.profiles?.full_name || s.matric_number || "").toLowerCase().includes(q) ||
          (s.matric_number || "").toLowerCase().includes(q) ||
          (s.student_id || "").toLowerCase().includes(q),
      )
      .slice(0, 80);
  }, [students, studentSearch]);

  async function addCarry(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId || !studentId || !courseId) {
      toast.error("Select student and course.");
      return;
    }
    setBusy(true);
    try {
      const course = courses.find((c) => c.id === courseId);
      const { error } = await supabase.from("course_carryovers").insert({
        school_id: schoolId,
        student_id: studentId,
        course_id: courseId,
        original_level_id: levelId || course?.level_id || null,
        reason: reason.trim() || null,
        status: "active",
        created_by: user?.userId || null,
      } as never);
      if (error) throw error;
      toast.success("Carryover student registered");
      setStudentId("");
      setCourseId("");
      setLevelId("");
      setReason("");
      await qc.invalidateQueries({ queryKey: ["course-carryovers"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save";
      if (/relation|does not exist|schema cache/i.test(msg)) {
        toast.error("Run the course_carryovers SQL migration in Supabase first.");
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(id: string) {
    if (!confirm("Deactivate this carryover registration?")) return;
    try {
      const { error } = await supabase
        .from("course_carryovers")
        .update({ status: "inactive", updated_at: new Date().toISOString() } as never)
        .eq("id", id);
      if (error) throw error;
      toast.success("Carryover deactivated");
      await qc.invalidateQueries({ queryKey: ["course-carryovers"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update");
    }
  }

  if (!schoolId) {
    return (
      <>
        <PageHeader title="Carryover Students" description="Register students retaking a lower-level course." />
        <EmptyState title="No school linked" description="Sign in as school admin or departmental officer." />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Carryover Students"
        description="Register a higher-level student to retake a previous-level course (e.g. 200 Level student rewriting CSC101)."
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard title="Add carryover">
          <form className="space-y-3" onSubmit={addCarry}>
            <div className="space-y-1.5">
              <Label>Search student</Label>
              <Input
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                placeholder="Name or matric…"
              />
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                required
              >
                <option value="">Select student…</option>
                {filteredStudents.map((s) => (
                  <option key={s.id} value={s.id}>
                    {(s.profiles?.full_name || "Student").trim()} · {s.matric_number || s.student_id}
                    {s.levels && !Array.isArray(s.levels) && s.levels.name ? ` · ${s.levels.name}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Course to retake</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={courseId}
                onChange={(e) => {
                  setCourseId(e.target.value);
                  const c = courses.find((x) => x.id === e.target.value);
                  if (c?.level_id) setLevelId(c.level_id);
                }}
                required
              >
                <option value="">Select course…</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Original course level</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={levelId}
                onChange={(e) => setLevelId(e.target.value)}
              >
                <option value="">Select level…</option>
                {levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Reason (optional)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Failed / incomplete / rewrite" />
            </div>
            <Button type="submit" disabled={busy} className="font-semibold">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Register carryover
            </Button>
          </form>
        </SectionCard>

        <SectionCard title="How it works">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
            <li>School Admin or Departmental Officer registers the student for a specific course.</li>
            <li>When a teacher creates an exam for that course, approved carryovers appear for selection.</li>
            <li>Result records still show the student’s <strong>current</strong> level (e.g. 200 Level), not the course’s original level.</li>
            <li>No duplicate student account is created — this links the existing student to the course.</li>
          </ol>
        </SectionCard>
      </div>

      <div className="mt-6">
        <SectionCard title="Active carryover registrations">
          {listQ.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No carryovers yet"
              description="Register students above. If save fails, run the course_carryovers SQL migration in Supabase."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.map((r) => {
                const st = r.students as Student | null;
                const course = r.courses as Course | null;
                return (
                  <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-900">
                        <UserRound className="mr-1 inline h-4 w-4 text-primary" />
                        {(st?.full_name || "Student").trim()}
                      </p>
                      <p className="text-xs text-slate-500">
                        {st?.matric_number || st?.student_id || "—"}
                        {course ? ` · ${course.code} ${course.name}` : ""}
                      </p>
                      <p className="text-xs text-slate-500">
                        Status: <span className="font-semibold">{r.status}</span>
                        {r.reason ? ` · ${r.reason}` : ""}
                      </p>
                    </div>
                    {r.status === "active" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-red-200 text-red-600"
                        onClick={() => void deactivate(r.id)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Deactivate
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}
