import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Loader2,
  MoreVertical,
  UserPlus,
  Upload,
  Trash2,
  UserX,
  Check,
} from "lucide-react";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { createSchoolUser } from "@/lib/auth.school-admin.functions";
import { useSessionUser } from "@/lib/session";
import { useRows } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { notifyTeacherCoursesAssigned } from "@/lib/email-notify.functions";

function friendlyErr(err: unknown, fallback = "Something went wrong"): string {
  const m = err instanceof Error ? err.message : String(err || "");
  if (/profiles_auth_user_id_key|duplicate key.*auth_user/i.test(m)) {
    return "This person already has an account. Open the list below or use a different email.";
  }
  if (/duplicate key|unique constraint|23505/i.test(m)) {
    return "This person or ID already exists in this school.";
  }
  if (/row-level security|42501/i.test(m)) {
    return "Permission denied. Sign out and sign in again as school admin.";
  }
  return m || fallback;
}


export const Route = createFileRoute("/admin/teachers")({
  head: () => ({
    meta: [{ title: "Teachers — D4EXAM" }],
  }),
  component: Page,
});

type Teacher = {
  id: string;
  staff_id: string;
  employment_status: string;
  profile_id?: string | null;
  profiles: { full_name: string; email?: string } | null;
};

type Course = {
  id: string;
  code: string;
  name: string;
  credit_units: number | null;
};

type TeacherCourse = {
  id: string;
  teacher_id: string;
  course_id: string;
};

function parseCsv(text: string): string[][] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === "," && !inQ) {
        cells.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
}

function Page() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const schoolCode = user?.schoolCode ?? "";
  const createOne = useServerFn(createSchoolUser);
  const qc = useQueryClient();
  const enabled = Boolean(schoolId);
  const fileRef = useRef<HTMLInputElement>(null);

  const teachersQ = useRows<Teacher>({
    table: "teachers",
    select: "id, staff_id, employment_status, profile_id, profiles(full_name, email)",
    filters: schoolId ? [{ column: "school_id", value: schoolId }] : [],
    order: { column: "created_at", ascending: false },
    limit: 300,
    enabled,
  });

  const coursesQ = useRows<Course>({
    table: "courses",
    select: "id, code, name, credit_units",
    filters: schoolId ? [{ column: "school_id", value: schoolId }] : [],
    order: { column: "code", ascending: true },
    limit: 300,
    enabled,
  });

  const linksQ = useRows<TeacherCourse>({
    table: "teacher_courses",
    select: "id, teacher_id, course_id",
    filters: schoolId ? [{ column: "school_id", value: schoolId }] : [],
    limit: 2000,
    enabled,
  });

  const teachers = teachersQ.data ?? [];
  const courses = coursesQ.data ?? [];
  const links = linksQ.data ?? [];

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [staffId, setStaffId] = useState("");
  const [createCourses, setCreateCourses] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [courseOpen, setCourseOpen] = useState<string | null>(null);
  const [courseSearch, setCourseSearch] = useState("");
  const [actionTeacher, setActionTeacher] = useState<Teacher | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const coursesByTeacher = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of links) {
      if (!m.has(l.teacher_id)) m.set(l.teacher_id, new Set());
      m.get(l.teacher_id)!.add(l.course_id);
    }
    return m;
  }, [links]);

  async function addTeacher(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId) {
      toast.error("Your account is not linked to a school.");
      return;
    }
    setBusy(true);
    try {
      const result = await createOne({
        data: {
          role: "teacher",
          firstName: firstName.trim(),
          lastName: lastName.trim() || "Teacher",
          email: email.trim().toLowerCase(),
          identifier: staffId.trim(),
        },
      });
      const teacherRowId = String((result as { id?: string })?.id || "");
      if (teacherRowId && createCourses.size) {
        const { error: linkErr } = await supabase.from("teacher_courses").insert(
          [...createCourses].map((course_id) => ({
            school_id: schoolId,
            teacher_id: teacherRowId,
            course_id,
          })) as never,
        );
        if (linkErr) toast.warning(`Teacher created but courses not linked: ${linkErr.message}`);
      }
      const names = courses.filter((c) => createCourses.has(c.id)).map((c) => c.code).join(", ");
      toast.success(
        names
          ? `Teacher created · courses: ${names}`
          : `Teacher created. Password = Staff ID (${staffId.trim()}).`,
      );
      setFirstName("");
      setLastName("");
      setEmail("");
      setStaffId("");
      setCreateCourses(new Set());
      await qc.invalidateQueries({ queryKey: ["rows"] });
      await teachersQ.refetch();
      await linksQ.refetch();
    } catch (err) {
      toast.error(friendlyErr(err, "Could not create teacher"));
    } finally {
      setBusy(false);
    }
  }

  async function setTeacherCourses(teacherId: string, desired: Set<string>) {
    if (!schoolId) return;
    setActionBusy(teacherId);
    try {
      const current = links.filter((l) => l.teacher_id === teacherId);
      const toRemove = current.filter((l) => !desired.has(l.course_id));
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
      const existing = new Set(current.map((l) => l.course_id));
      const toAdd = [...desired].filter((id) => !existing.has(id));
      if (toAdd.length) {
        const { error } = await supabase.from("teacher_courses").insert(
          toAdd.map((course_id) => ({
            school_id: schoolId,
            teacher_id: teacherId,
            course_id,
          })) as never,
        );
        if (error) throw error;
      }
      const t = teachers.find((x) => x.id === teacherId);
      const names = courses.filter((c) => desired.has(c.id)).map((c) => c.code).join(", ");
      toast.success(`Courses saved${names ? `: ${names}` : ""}`);
      try {
        const em = String(t?.profiles?.email || "").trim();
        if (em.includes("@") && names) {
          void notifyTeacherCoursesAssigned({
            data: {
              email: em,
              fullName: t?.profiles?.full_name || "Teacher",
              courseLabels: names.split(", ").filter(Boolean),
            },
          });
        }
      } catch {
        /* ignore */
      }
      await linksQ.refetch();
      await qc.invalidateQueries({ queryKey: ["rows"] });
    } catch (err) {
      toast.error((err as Error).message || "Could not save courses");
    } finally {
      setActionBusy(null);
    }
  }

  async function suspendTeacher(t: Teacher) {
    setMenuOpen(null);
    setActionTeacher(null);
    setActionBusy(t.id);
    try {
      const { error } = await supabase
        .from("teachers")
        .update({ employment_status: "suspended", updated_at: new Date().toISOString() } as never)
        .eq("id", t.id);
      if (error) throw error;
      if (t.profile_id) {
        await supabase
          .from("profiles")
          .update({ status: "suspended", updated_at: new Date().toISOString() } as never)
          .eq("id", t.profile_id);
      }
      toast.success(`${t.profiles?.full_name || "Teacher"} suspended — they cannot use the app until reactivated`);
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not suspend");
    } finally {
      setActionBusy(null);
    }
  }

  async function reactivateTeacher(t: Teacher) {
    setMenuOpen(null);
    setActionTeacher(null);
    setActionBusy(t.id);
    try {
      const { error } = await supabase
        .from("teachers")
        .update({ employment_status: "active", updated_at: new Date().toISOString() } as never)
        .eq("id", t.id);
      if (error) throw error;
      if (t.profile_id) {
        await supabase
          .from("profiles")
          .update({ status: "active", updated_at: new Date().toISOString() } as never)
          .eq("id", t.profile_id);
      }
      toast.success(`${t.profiles?.full_name || "Teacher"} reactivated`);
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reactivate");
    } finally {
      setActionBusy(null);
    }
  }

  async function removeTeacher(t: Teacher) {
    const label = t.profiles?.full_name || t.staff_id || "this teacher";
    if (!confirm(`Remove ${label}?\n\nThey will no longer be able to sign in with these details.`)) return;
    setMenuOpen(null);
    setActionTeacher(null);
    setActionBusy(t.id);
    try {
      await supabase.from("teacher_courses").delete().eq("teacher_id", t.id);
      const { error } = await supabase
        .from("teachers")
        .update({ employment_status: "terminated", updated_at: new Date().toISOString() } as never)
        .eq("id", t.id);
      if (error) throw error;
      if (t.profile_id) {
        await supabase
          .from("profiles")
          .update({ status: "deleted", updated_at: new Date().toISOString() } as never)
          .eq("id", t.profile_id);
        // Remove role rows keyed by profile id or auth id
        await supabase.from("user_roles").delete().eq("role", "teacher").eq("user_id", t.profile_id);
        const { data: prof } = await supabase.from("profiles").select("auth_user_id").eq("id", t.profile_id).maybeSingle();
        if (prof?.auth_user_id) {
          await supabase.from("user_roles").delete().eq("role", "teacher").eq("user_id", prof.auth_user_id);
        }
      }
      toast.success(`${label} removed — login with these details is blocked`);
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove");
    } finally {
      setActionBusy(null);
    }
  }

  async function importTeachers(file: File) {
    if (!schoolId) {
      toast.error("Your account is not linked to a school.");
      return;
    }
    setImportBusy(true);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length < 2) {
        toast.error("CSV needs a header row and at least one teacher.");
        return;
      }
      const header = rows[0]!.map((h) => h.toLowerCase().replace(/\s+/g, "_"));
      const idx = (names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
      const iFirst = idx(["first_name", "firstname", "first"]);
      const iLast = idx(["last_name", "lastname", "last"]);
      const iName = idx(["full_name", "name", "teacher"]);
      const iEmail = idx(["email", "mail"]);
      const iStaff = idx(["staff_id", "staff", "identifier", "id"]);
      const iCourses = idx(["courses", "course_codes", "course"]);

      let ok = 0;
      let fail = 0;
      for (const row of rows.slice(1)) {
        try {
          let first = iFirst >= 0 ? row[iFirst] || "" : "";
          let last = iLast >= 0 ? row[iLast] || "" : "";
          if (!first && iName >= 0) {
            const parts = String(row[iName] || "").trim().split(/\s+/);
            first = parts[0] || "Teacher";
            last = parts.slice(1).join(" ") || "Staff";
          }
          const em = (iEmail >= 0 ? row[iEmail] : "") || "";
          const staff = (iStaff >= 0 ? row[iStaff] : "") || "";
          if (!staff || staff.length < 4) {
            fail += 1;
            continue;
          }
          const emailVal =
            em.includes("@")
              ? em.toLowerCase()
              : `${staff.replace(/[^a-z0-9]+/gi, ".").toLowerCase()}@placeholder.local`;
          const result = await createOne({
            data: {
              role: "teacher",
              firstName: first || "Teacher",
              lastName: last || "Staff",
              email: emailVal,
              identifier: staff.trim(),
            },
          });
          const teacherRowId = String((result as { id?: string })?.id || "");
          const courseCell = iCourses >= 0 ? String(row[iCourses] || "") : "";
          if (teacherRowId && courseCell) {
            const codes = courseCell
              .split(/[;|]/)
              .map((c) => c.trim().toUpperCase())
              .filter(Boolean);
            const ids = courses.filter((c) => codes.includes(c.code.toUpperCase())).map((c) => c.id);
            if (ids.length) {
              await supabase.from("teacher_courses").insert(
                ids.map((course_id) => ({
                  school_id: schoolId,
                  teacher_id: teacherRowId,
                  course_id,
                })) as never,
              );
            }
          }
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      toast.success(`Import done: ${ok} created, ${fail} failed`);
      await qc.invalidateQueries({ queryKey: ["rows"] });
      await teachersQ.refetch();
      await linksQ.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImportBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (!schoolId) {
    return (
      <>
        <PageHeader title="Teachers" description="Manage teachers and course assignments." />
        <SectionCard title="No school">
          <p className="text-sm text-slate-500">Your account is not linked to a school yet.</p>
        </SectionCard>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Teachers"
        description="Create teachers, assign multiple courses, import a list, or manage access — same clean layout as Departmental Officers."
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard title="Add teacher">
          <form className="space-y-3" onSubmit={addTeacher}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>First name</Label>
                <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Last name</Label>
                <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Staff ID (also their password)</Label>
              <Input value={staffId} onChange={(e) => setStaffId(e.target.value)} required minLength={4} />
            </div>
            <div className="space-y-1.5">
              <Label>Courses (select one or more)</Label>
              {courses.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No courses yet.{" "}
                  <Link to="/admin/courses" className="font-semibold text-primary hover:underline">
                    Create courses
                  </Link>{" "}
                  first.
                </p>
              ) : (
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2">
                  {courses.map((c) => {
                    const on = createCourses.has(c.id);
                    return (
                      <label
                        key={c.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                          on ? "bg-primary/10 font-semibold text-primary" : "hover:bg-white",
                        )}
                      >
                        <Checkbox
                          checked={on}
                          onCheckedChange={() => {
                            setCreateCourses((prev) => {
                              const next = new Set(prev);
                              if (next.has(c.id)) next.delete(c.id);
                              else next.add(c.id);
                              return next;
                            });
                          }}
                        />
                        <span>
                          {c.code}
                          <span className="ml-1 font-normal text-slate-500">{c.name}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <Button type="submit" disabled={busy} className="font-semibold">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
              Create teacher
            </Button>
            <p className="text-xs text-slate-500">
              Login: school code <strong>{schoolCode || "—"}</strong> + email/staff ID · password = Staff ID.
            </p>
          </form>
        </SectionCard>

        <SectionCard title="Import teachers">
          <p className="mb-3 text-sm text-slate-600">
            Upload a CSV with columns like:{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">
              first_name,last_name,email,staff_id,courses
            </code>
            . Courses can be codes separated by{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">;</code> (e.g.{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">CSC101;MTH101</code>).
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importTeachers(f);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={importBusy}
            className="font-semibold"
            onClick={() => fileRef.current?.click()}
          >
            {importBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            Import CSV
          </Button>
          <p className="mt-3 text-xs text-slate-500">
            Word/PDF lists should be converted to CSV first (name + staff ID required).
          </p>
        </SectionCard>
      </div>

      <div className="mt-6">
        <SectionCard title="Existing teachers">
          {teachersQ.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : teachers.length === 0 ? (
            <EmptyState title="No teachers yet" description="Create or import teachers above." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {teachers.map((t) => {
                const assigned = coursesByTeacher.get(t.id) ?? new Set<string>();
                const labels = courses
                  .filter((c) => assigned.has(c.id))
                  .map((c) => c.code)
                  .join(", ");
                const open = courseOpen === t.id;
                const menu = menuOpen === t.id;
                return (
                  <li
                    key={t.id}
                    className="relative flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold text-slate-900">
                        {t.profiles?.full_name ?? "Teacher"}
                      </p>
                      <p className="text-xs text-slate-500">
                        {t.staff_id}
                        {t.profiles?.email ? ` · ${t.profiles.email}` : ""}
                      </p>
                      <p className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                        <BookOpen className="h-3.5 w-3.5" />
                        {labels || "No courses assigned"}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={t.employment_status || "active"} />

                      {/* Course picker — one click */}
                      <div className="relative">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 text-xs font-semibold"
                          disabled={actionBusy === t.id}
                          onClick={() => {
                            setCourseOpen(open ? null : t.id);
                            setCourseSearch("");
                            setMenuOpen(null);
                            setActionTeacher(null);
                          }}
                        >
                          Select courses
                        </Button>
                      </div>

                      {/* ⋮ menu */}
                      <div className="relative">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 w-9 p-0"
                          disabled={actionBusy === t.id}
                          onClick={() => {
                            setActionTeacher(t);
                            setCourseOpen(null);
                            setMenuOpen(null);
                          }}
                          aria-label="Teacher actions"
                        >
                          {actionBusy === t.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <MoreVertical className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* Centered course assignment dialog */}
      <Dialog open={Boolean(courseOpen)} onOpenChange={(o) => { if (!o) setCourseOpen(null); }}>
        <DialogContent className="max-h-[85vh] max-w-md overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Assign courses</DialogTitle>
            <DialogDescription>
              {(() => {
                const tt = teachers.find((x) => x.id === courseOpen);
                return tt?.profiles?.full_name || "Teacher";
              })()}
            </DialogDescription>
          </DialogHeader>
          <Input
            className="h-10"
            placeholder="Search course code or name…"
            value={courseSearch}
            onChange={(e) => setCourseSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
            {(() => {
              const assigned = courseOpen ? coursesByTeacher.get(courseOpen) ?? new Set<string>() : new Set<string>();
              const q = courseSearch.trim().toLowerCase();
              const list = courses.filter(
                (c) => !q || c.code.toLowerCase().includes(q) || (c.name || "").toLowerCase().includes(q),
              );
              if (!list.length) {
                return <p className="py-6 text-center text-sm text-slate-500">No courses match.</p>;
              }
              return list.map((c) => {
                const on = assigned.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-sm",
                      on ? "bg-primary/10 font-semibold text-primary" : "hover:bg-slate-50",
                    )}
                  >
                    <Checkbox
                      checked={on}
                      onCheckedChange={() => {
                        if (!courseOpen) return;
                        const next = new Set(assigned);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        void setTeacherCourses(courseOpen, next);
                      }}
                    />
                    <span>
                      <span className="font-semibold">{c.code}</span>
                      <span className="ml-1.5 font-normal text-slate-500">{c.name}</span>
                    </span>
                  </label>
                );
              });
            })()}
          </div>
          <DialogFooter>
            <Button type="button" className="font-semibold" onClick={() => setCourseOpen(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Centered teacher actions dialog */}
      <Dialog open={Boolean(actionTeacher)} onOpenChange={(o) => { if (!o) setActionTeacher(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Teacher actions</DialogTitle>
            <DialogDescription>
              {actionTeacher?.profiles?.full_name || actionTeacher?.staff_id || "Teacher"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-1">
            {(actionTeacher?.employment_status || "active") === "suspended" ? (
              <Button
                type="button"
                variant="outline"
                className="justify-start font-semibold"
                disabled={!actionTeacher || actionBusy === actionTeacher?.id}
                onClick={() => actionTeacher && void reactivateTeacher(actionTeacher)}
              >
                Reactivate {actionTeacher?.profiles?.full_name || "teacher"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="justify-start font-semibold"
                disabled={!actionTeacher || actionBusy === actionTeacher?.id}
                onClick={() => actionTeacher && void suspendTeacher(actionTeacher)}
              >
                <UserX className="mr-2 h-4 w-4" />
                Suspend {actionTeacher?.profiles?.full_name || "teacher"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="justify-start font-semibold text-red-600 hover:bg-red-50 hover:text-red-700"
              disabled={!actionTeacher || actionBusy === actionTeacher?.id}
              onClick={() => actionTeacher && void removeTeacher(actionTeacher)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Remove {actionTeacher?.profiles?.full_name || "teacher"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </>
  );
}
