import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, BookOpen } from "lucide-react";
import { PageHeader, SectionCard, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useSessionUser } from "@/lib/session";
import { useRows } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export const Route = createFileRoute("/admin/courses")({
  head: () => ({ meta: [{ title: "Courses — D4EXAM" }] }),
  component: Page,
});

type Course = {
  id: string;
  code: string;
  name: string;
  credit_units: number | null;
  status: string;
  department_id: string | null;
  level_id: string | null;
  semester_id: string | null;
  departments: { name: string; code: string | null } | null;
  levels: { name: string } | null;
  semesters: { name: string } | null;
};

type Teacher = {
  id: string;
  staff_id: string;
  profiles: { full_name: string; email?: string } | null;
};

type TeacherCourse = { id: string; teacher_id: string; course_id: string };
type Dept = { id: string; name: string; code: string | null; faculty_id?: string | null };
type Faculty = { id: string; name: string };
type Level = { id: string; name: string };
type Semester = { id: string; name: string; status: string };
type Offering = { id: string; course_id: string; department_id: string };

/** Compact multi-select for departments */
function DeptPicker({
  depts,
  selected,
  allDepartments,
  onChange,
  onAllChange,
}: {
  depts: Dept[];
  selected: Set<string>;
  allDepartments: boolean;
  onChange: (next: Set<string>) => void;
  onAllChange: (all: boolean) => void;
}) {
  function toggle(id: string) {
    onAllChange(false);
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function selectAllListed() {
    onAllChange(false);
    onChange(new Set(depts.map((d) => d.id)));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className={cn(
            "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold",
            allDepartments ? "border-primary bg-primary/10 text-primary" : "border-slate-200 text-slate-700",
          )}
        >
          <Checkbox
            checked={allDepartments}
            onCheckedChange={(v) => {
              onAllChange(v === true);
              if (v === true) onChange(new Set());
            }}
          />
          All departments
        </label>
        {!allDepartments && depts.length > 0 && (
          <button
            type="button"
            className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
            onClick={selectAllListed}
          >
            Select all listed
          </button>
        )}
      </div>

      {!allDepartments && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {depts.length === 0 ? (
            <p className="px-1 py-2 text-xs text-slate-500">No departments yet.</p>
          ) : (
            depts.map((d) => {
              const checked = selected.has(d.id);
              return (
                <label
                  key={d.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    checked ? "bg-primary/5" : "hover:bg-slate-50",
                  )}
                >
                  <Checkbox checked={checked} onCheckedChange={() => toggle(d.id)} />
                  <span className="min-w-0 truncate">
                    {d.code ? `${d.code} — ` : ""}
                    {d.name}
                  </span>
                </label>
              );
            })
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-500">
        {allDepartments
          ? "Visible to students in every department."
          : selected.size === 0
            ? "Pick one or more departments."
            : `${selected.size} department${selected.size === 1 ? "" : "s"} selected.`}
      </p>
    </div>
  );
}

function Page() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const qc = useQueryClient();
  const enabled = Boolean(schoolId);

  const coursesQ = useQuery({
    queryKey: ["admin-courses-live", schoolId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("courses")
        .select(
          "id, code, name, credit_units, status, department_id, level_id, semester_id, departments(name, code), levels(name), semesters(name)",
        )
        .eq("school_id", schoolId!)
        .order("code")
        .limit(300);
      if (error) {
        const { data: d2, error: e2 } = await supabase
          .from("courses")
          .select("id, code, name, credit_units, status, department_id, departments(name, code)")
          .eq("school_id", schoolId!)
          .order("code")
          .limit(300);
        if (e2) throw e2;
        return ((d2 ?? []) as Course[]).map((c) => ({
          ...c,
          level_id: null,
          semester_id: null,
          levels: null,
          semesters: null,
        }));
      }
      return (data ?? []) as Course[];
    },
  });

  const offeringsQ = useQuery({
    queryKey: ["admin-course-offerings", schoolId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("course_offerings")
        .select("id, course_id, department_id")
        .eq("school_id", schoolId!)
        .limit(2000);
      if (error) return [] as Offering[];
      return (data ?? []) as Offering[];
    },
  });

  const deptsQ = useQuery({
    queryKey: ["admin-courses-depts", schoolId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("departments")
        .select("id, name, code, faculty_id")
        .eq("school_id", schoolId!)
        .order("name");
      if (error) {
        const { data: d2, error: e2 } = await supabase
          .from("departments")
          .select("id, name, code")
          .eq("school_id", schoolId!)
          .order("name");
        if (e2) throw e2;
        return (d2 ?? []) as Dept[];
      }
      return (data ?? []) as Dept[];
    },
  });

  const facultiesQ = useQuery({
    queryKey: ["admin-courses-faculties", schoolId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("faculties")
        .select("id, name")
        .eq("school_id", schoolId!)
        .order("name");
      if (error) return [] as Faculty[];
      return (data ?? []) as Faculty[];
    },
  });

  const levelsQ = useQuery({
    queryKey: ["admin-courses-levels", schoolId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("levels")
        .select("id, name")
        .eq("school_id", schoolId!)
        .order("name");
      if (error) return [] as Level[];
      return (data ?? []) as Level[];
    },
  });

  const semestersQ = useQuery({
    queryKey: ["admin-courses-semesters", schoolId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("semesters")
        .select("id, name, status")
        .eq("school_id", schoolId!)
        .order("created_at", { ascending: false });
      if (error) return [] as Semester[];
      return (data ?? []) as Semester[];
    },
  });

  const teachersQ = useRows<Teacher>({
    table: "teachers",
    select: "id, staff_id, profiles(full_name, email)",
    filters: schoolId ? [{ column: "school_id", value: schoolId }] : [],
    order: { column: "created_at", ascending: false },
    limit: 200,
    enabled,
  });

  const linksQ = useRows<TeacherCourse>({
    table: "teacher_courses",
    select: "id, teacher_id, course_id",
    filters: schoolId ? [{ column: "school_id", value: schoolId }] : [],
    limit: 1000,
    enabled,
  });

  const courses = coursesQ.data ?? [];
  const offerings = offeringsQ.data ?? [];
  const teachers = teachersQ.data ?? [];
  const links = linksQ.data ?? [];
  const depts = deptsQ.data ?? [];
  const faculties = facultiesQ.data ?? [];
  const levels = levelsQ.data ?? [];
  const semesters = semestersQ.data ?? [];
  const activeSemester = semesters.find((s) => String(s.status).toLowerCase() === "active");
  const deptName = useMemo(() => new Map(depts.map((d) => [d.id, d.name])), [depts]);

  function deptIdsForCourse(c: Course): string[] {
    const ids = new Set<string>();
    if (c.department_id) ids.add(c.department_id);
    for (const o of offerings) {
      if (o.course_id === c.id) ids.add(o.department_id);
    }
    return [...ids];
  }

  function deptLabel(c: Course): string {
    if (!c.department_id && deptIdsForCourse(c).length === 0) return "All departments";
    const ids = deptIdsForCourse(c);
    if (ids.length === 0) return "All departments";
    if (ids.length === 1) return deptName.get(ids[0]) ?? c.departments?.name ?? "Department";
    return `${ids.length} departments`;
  }

  const [filterSem, setFilterSem] = useState("all");
  const [filterDept, setFilterDept] = useState("all");

  const filtered = useMemo(() => {
    return courses.filter((c) => {
      if (filterSem === "active" && activeSemester && c.semester_id !== activeSemester.id) return false;
      if (filterSem !== "all" && filterSem !== "active" && c.semester_id !== filterSem) return false;
      if (filterDept !== "all") {
        const ids = deptIdsForCourse(c);
        if (ids.length === 0) return true;
        if (!ids.includes(filterDept)) return false;
      }
      return true;
    });
  }, [courses, filterSem, filterDept, activeSemester, offerings]);

  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [deleteCourseOpen, setDeleteCourseOpen] = useState(false);
  const [editCode, setEditCode] = useState("");
  const [editName, setEditName] = useState("");
  const [editUnits, setEditUnits] = useState("3");
  const selectedCourse = courses.find((c) => c.id === selectedCourseId) ?? null;

  const assignedTeacherIds = useMemo(() => {
    if (!selectedCourse) return new Set<string>();
    return new Set(links.filter((l) => l.course_id === selectedCourse.id).map((l) => l.teacher_id));
  }, [links, selectedCourse]);

  const [pendingTeachers, setPendingTeachers] = useState<Set<string> | null>(null);
  const effectiveAssigned = pendingTeachers ?? assignedTeacherIds;

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [units, setUnits] = useState("3");
  const [collegeId, setCollegeId] = useState("");
  const [deptSelected, setDeptSelected] = useState<Set<string>>(new Set());
  const [allDepts, setAllDepts] = useState(false);
  const [levelId, setLevelId] = useState("");
  const [semesterId, setSemesterId] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [showMore, setShowMore] = useState(false);

  const [editDeptSelected, setEditDeptSelected] = useState<Set<string>>(new Set());
  const [editAllDepts, setEditAllDepts] = useState(false);
  const [editBusy, setEditBusy] = useState(false);

  useEffect(() => {
    if (!selectedCourse) return;
    const ids = deptIdsForCourse(selectedCourse);
    if (ids.length === 0) {
      setEditAllDepts(true);
      setEditDeptSelected(new Set());
    } else {
      setEditAllDepts(false);
      setEditDeptSelected(new Set(ids));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCourse?.id, offerings]);

  const deptsForForm = useMemo(() => {
    if (!collegeId) return depts;
    return depts.filter((d) => d.faculty_id === collegeId);
  }, [depts, collegeId]);

  async function syncOfferings(
    courseId: string,
    departmentIds: string[],
    levelIdForOffer: string | null,
    semesterIdForOffer: string | null,
  ) {
    if (!schoolId) return;
    await supabase.from("course_offerings").delete().eq("course_id", courseId).eq("school_id", schoolId);

    const level = levelIdForOffer || levels[0]?.id || null;
    if (!level || departmentIds.length <= 1) return;

    const rows = departmentIds.map((department_id) => ({
      school_id: schoolId,
      course_id: courseId,
      department_id,
      level_id: level,
      semester_id: semesterIdForOffer,
      status: "active",
    }));
    let { error } = await supabase.from("course_offerings").insert(rows as never);
    if (error && /semester_id|schema cache/i.test(String(error.message || ""))) {
      const slim = rows.map(({ semester_id: _s, ...r }) => r);
      const res2 = await supabase.from("course_offerings").insert(slim as never);
      error = res2.error;
    }
    if (error) console.warn("course_offerings", error);
  }

  async function createCourse(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId) {
      toast.error("Your account is not linked to a school.");
      return;
    }
    if (!code.trim() || !name.trim()) {
      toast.error("Course code and title are required");
      return;
    }
    if (!allDepts && deptSelected.size === 0) {
      toast.error("Select All departments or at least one department");
      return;
    }
    setBusy(true);
    try {
      const ids = allDepts ? [] : [...deptSelected];
      const primary = ids[0] ?? null;
      const sem = semesterId || activeSemester?.id || null;
      const payload: Record<string, unknown> = {
        school_id: schoolId,
        code: code.trim().toUpperCase(),
        name: name.trim(),
        credit_units: Number(units) || 0,
        department_id: primary,
        status: "active",
      };
      if (levelId) payload.level_id = levelId;
      if (sem) payload.semester_id = sem;

      let data: { id: string } | null = null;
      let error: { message?: string; code?: string } | null = null;
      {
        const res = await supabase.from("courses").insert(payload as never).select("id").single();
        data = res.data as { id: string } | null;
        error = res.error as { message?: string; code?: string } | null;
      }
      if (error && /semester_id|level_id|schema cache/i.test(String(error.message || ""))) {
        const slim = { ...payload };
        delete slim.semester_id;
        delete slim.level_id;
        const res2 = await supabase.from("courses").insert(slim as never).select("id").single();
        if (res2.error) throw res2.error;
        data = res2.data as { id: string };
        error = null;
        toast.message("Course saved. Run semester_id migration in Supabase for full semester support.");
      }
      if (error) throw error;
      if (!data?.id) throw new Error("Could not create course");
      const courseId = String(data.id);
      if (ids.length > 1) {
        await syncOfferings(courseId, ids, levelId || null, sem);
      }
      toast.success(`${code.trim().toUpperCase()} created`);
      setCode("");
      setName("");
      setUnits("3");
      setDeptSelected(new Set());
      setAllDepts(false);
      await coursesQ.refetch();
      await offeringsQ.refetch();
      await qc.invalidateQueries({ queryKey: ["student-context"] });
      setSelectedCourseId(courseId);
      setPendingTeachers(new Set());
    } catch (err) {
      toast.error((err as Error).message || "Could not create course");
    } finally {
      setBusy(false);
    }
  }

  async function saveCourseDepts() {
    if (!schoolId || !selectedCourse) return;
    if (!editAllDepts && editDeptSelected.size === 0) {
      toast.error("Select All departments or at least one department");
      return;
    }
    setEditBusy(true);
    try {
      const ids = editAllDepts ? [] : [...editDeptSelected];
      const primary = ids[0] ?? null;
      const { error } = await supabase
        .from("courses")
        .update({
          department_id: primary,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", selectedCourse.id)
        .eq("school_id", schoolId);
      if (error) throw error;
      await syncOfferings(
        selectedCourse.id,
        ids,
        selectedCourse.level_id,
        selectedCourse.semester_id,
      );
      if (ids.length <= 1) {
        await supabase
          .from("course_offerings")
          .delete()
          .eq("course_id", selectedCourse.id)
          .eq("school_id", schoolId);
      }
      toast.success("Departments saved");
      await coursesQ.refetch();
      await offeringsQ.refetch();
      await qc.invalidateQueries({ queryKey: ["student-context"] });
    } catch (err) {
      toast.error((err as Error).message || "Could not update departments");
    } finally {
      setEditBusy(false);
    }
  }

  async function patchSemester(courseId: string, semester_id: string | null) {
    if (!schoolId) return;
    try {
      const { error } = await supabase
        .from("courses")
        .update({ semester_id, updated_at: new Date().toISOString() } as never)
        .eq("id", courseId)
        .eq("school_id", schoolId);
      if (error) {
        if (/semester_id|schema cache/i.test(String(error.message || ""))) {
          toast.error("Semester column missing in database. Run the semester_id SQL in Supabase (SQL Editor).");
          return;
        }
        throw error;
      }
      toast.success("Semester updated");
      await coursesQ.refetch();
      await qc.invalidateQueries({ queryKey: ["student-context"] });
    } catch (err) {
      toast.error((err as Error).message || "Could not update semester");
    }
  }

  function selectCourse(id: string) {
    const c = (coursesQ.data ?? []).find((x) => x.id === id);
    if (c) {
      setEditCode(c.code || "");
      setEditName(c.name || "");
      setEditUnits(String(c.credit_units ?? 3));
    }
    setSelectedCourseId(id);
    setPendingTeachers(null);
  }

  function toggleTeacher(teacherId: string) {
    setPendingTeachers((prev) => {
      const base = prev ?? new Set(assignedTeacherIds);
      const next = new Set(base);
      if (next.has(teacherId)) next.delete(teacherId);
      else next.add(teacherId);
      return next;
    });
  }

  async function saveTeachers() {
    if (!schoolId || !selectedCourse) return;
    setAssignBusy(true);
    try {
      const desired = pendingTeachers ?? assignedTeacherIds;
      const current = links.filter((l) => l.course_id === selectedCourse.id);
      const toRemove = current.filter((l) => !desired.has(l.teacher_id));
      if (toRemove.length) {
        const { error } = await supabase
          .from("teacher_courses")
          .delete()
          .in(
            "id",
            toRemove.map((l) => l.id),
          );
        if (error) throw error;
      }
      const existing = new Set(current.map((l) => l.teacher_id));
      const toAdd = [...desired].filter((id) => !existing.has(id));
      if (toAdd.length) {
        const { error } = await supabase.from("teacher_courses").insert(
          toAdd.map((teacher_id) => ({
            school_id: schoolId,
            teacher_id,
            course_id: selectedCourse.id,
          })) as never,
        );
        if (error) throw error;
      }
      toast.success("Teachers saved");
      setPendingTeachers(null);
      await linksQ.refetch();
    } catch (err) {
      toast.error((err as Error).message || "Could not save teachers");
    } finally {
      setAssignBusy(false);
    }
  }

  function teacherNames(courseId: string) {
    const ids = new Set(links.filter((l) => l.course_id === courseId).map((l) => l.teacher_id));
    return teachers
      .filter((t) => ids.has(t.id))
      .map((t) => t.profiles?.full_name ?? t.staff_id)
      .join(", ");
  }


  async function saveCourseMeta() {
    if (!schoolId || !selectedCourse) return;
    if (!editCode.trim() || !editName.trim()) {
      toast.error("Code and title are required");
      return;
    }
    setEditBusy(true);
    try {
      const { error } = await supabase
        .from("courses")
        .update({
          code: editCode.trim().toUpperCase(),
          name: editName.trim(),
          credit_units: Number(editUnits) || 0,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", selectedCourse.id)
        .eq("school_id", schoolId);
      if (error) throw error;
      toast.success("Course updated");
      await coursesQ.refetch();
    } catch (e) {
      toast.error((e as Error).message || "Could not update course");
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteCourse() {
    if (!schoolId || !selectedCourse) return;
    setEditBusy(true);
    try {
      await supabase.from("teacher_courses").delete().eq("course_id", selectedCourse.id);
      await supabase.from("course_offerings").delete().eq("course_id", selectedCourse.id).eq("school_id", schoolId);
      const { error } = await supabase.from("courses").delete().eq("id", selectedCourse.id).eq("school_id", schoolId);
      if (error) throw error;
      toast.success("Course deleted");
      setSelectedCourseId(null);
      setDeleteCourseOpen(false);
      await coursesQ.refetch();
      await offeringsQ.refetch();
      await linksQ.refetch();
    } catch (e) {
      toast.error((e as Error).message || "Could not delete course");
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Courses"
        description="Add a course, assign one or more departments (or all), and a semester."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/semesters">Semesters</Link>
          </Button>
        }
      />

      <SectionCard title="Add course">
        <form className="space-y-3" onSubmit={(e) => void createCourse(e)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CPE101" required />
            </div>
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Course title" required />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Departments</Label>
            <DeptPicker
              depts={deptsForForm}
              selected={deptSelected}
              allDepartments={allDepts}
              onChange={setDeptSelected}
              onAllChange={setAllDepts}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Semester</Label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={semesterId || (activeSemester ? "auto" : "")}
              onChange={(e) => {
                const v = e.target.value;
                setSemesterId(v === "auto" ? "" : v);
              }}
            >
              <option value="auto">
                {activeSemester ? `Current: ${activeSemester.name}` : "All year"}
              </option>
              <option value="">All year</option>
              {semesters.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {showMore && (
            <div className="grid gap-3 sm:grid-cols-3">
              {faculties.length > 0 && (
                <div className="space-y-1.5">
                  <Label>College filter</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={collegeId}
                    onChange={(e) => {
                      setCollegeId(e.target.value);
                      setDeptSelected(new Set());
                    }}
                  >
                    <option value="">All colleges</option>
                    {faculties.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label>Level</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={levelId}
                  onChange={(e) => setLevelId(e.target.value)}
                >
                  <option value="">Any level</option>
                  {levels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Units</Label>
                <Input type="number" min={0} value={units} onChange={(e) => setUnits(e.target.value)} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !schoolId} className="font-semibold">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save course
            </Button>
            <button
              type="button"
              className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
              onClick={() => setShowMore((v) => !v)}
            >
              {showMore ? "Hide options" : "More options"}
            </button>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        className="mt-6"
        title={`Courses (${filtered.length})`}
        description="Tap a course to edit departments, semester, or teachers"
      >
        <div className="mb-3 flex flex-wrap gap-2">
          <select
            className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm"
            value={filterSem}
            onChange={(e) => setFilterSem(e.target.value)}
          >
            <option value="all">All semesters</option>
            <option value="active">Active semester</option>
            {semesters.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm"
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
          >
            <option value="all">All departments</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        {coursesQ.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : filtered.length === 0 ? (
          <EmptyState title="No courses" description="Add a course above, or clear filters." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtered.map((c) => {
              const active = selectedCourse?.id === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => selectCourse(c.id)}
                    className={cn(
                      "flex w-full items-start justify-between gap-3 px-1 py-3 text-left",
                      active && "bg-primary/5",
                    )}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900">
                        {c.code} — {c.name}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{deptLabel(c)}</span>{" "}
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">
                          {c.semesters?.name ?? "All year"}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {teacherNames(c.id) || "No teachers yet"}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {selectedCourse && (
        <SectionCard
          className="mt-6"
          title={`${selectedCourse.code} — assign`}
          description="Update departments and teachers for this course"
        >
          <div className="mb-4 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Departments</Label>
              <DeptPicker
                depts={depts}
                selected={editDeptSelected}
                allDepartments={editAllDepts}
                onChange={setEditDeptSelected}
                onAllChange={setEditAllDepts}
              />
              <Button
                size="sm"
                className="mt-1 font-semibold"
                disabled={editBusy}
                onClick={() => void saveCourseDepts()}
              >
                {editBusy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Save departments
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Semester</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={selectedCourse.semester_id || ""}
                onChange={(e) => void patchSemester(selectedCourse.id, e.target.value || null)}
              >
                <option value="">All year</option>
                {semesters.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mb-4 grid gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-1">
              <Label className="text-xs">Code</Label>
              <Input value={editCode} onChange={(e) => setEditCode(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1 sm:col-span-1">
              <Label className="text-xs">Title</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1 sm:col-span-1">
              <Label className="text-xs">Credit units</Label>
              <Input value={editUnits} onChange={(e) => setEditUnits(e.target.value)} className="h-9" type="number" min={0} />
            </div>
            <div className="flex flex-wrap gap-2 sm:col-span-3">
              <Button size="sm" className="font-semibold" disabled={editBusy} onClick={() => void saveCourseMeta()}>
                Save course details
              </Button>
              <Button size="sm" variant="outline" className="font-semibold text-red-600" disabled={editBusy} onClick={() => setDeleteCourseOpen(true)}>
                Delete course
              </Button>
            </div>
          </div>

          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
            <BookOpen className="h-4 w-4 text-primary" />
            Teachers ({effectiveAssigned.size})
          </p>

          {teachers.length === 0 ? (
            <p className="text-sm text-slate-500">No teachers yet.</p>
          ) : (
            <>
              <div className="grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">
                {teachers.map((t) => {
                  const checked = effectiveAssigned.has(t.id);
                  return (
                    <label
                      key={t.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                        checked ? "border-primary/40 bg-primary/5" : "border-slate-200",
                      )}
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleTeacher(t.id)} />
                      <span className="min-w-0 truncate font-medium">
                        {t.profiles?.full_name ?? t.staff_id}
                      </span>
                      {checked && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />}
                    </label>
                  );
                })}
              </div>
              <Button className="mt-3 font-semibold" disabled={assignBusy} onClick={() => void saveTeachers()}>
                {assignBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save teachers
              </Button>
            </>
          )}
        </SectionCard>
      )}
      <ConfirmDialog
        open={deleteCourseOpen}
        onOpenChange={setDeleteCourseOpen}
        title="Delete this course?"
        description={`${selectedCourse?.code || ""} — ${selectedCourse?.name || ""}. Teachers assigned to it will be unlinked.`}
        confirmLabel="Delete"
        destructive
        busy={editBusy}
        onConfirm={() => void deleteCourse()}
      />
    </>
  );
}
