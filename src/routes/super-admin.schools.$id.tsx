import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Building2,
  Users,
  Blocks,
  GraduationCap,
  BookOpen,
  FileText,
  ChevronRight,
  Loader2,
  UserCheck,
  Activity,
  Ban,
  Trash2,
  ShieldOff,
  Pencil,
  ImagePlus,
} from "lucide-react";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { SchoolLogo } from "@/components/brand/SchoolLogo";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { uploadSchoolLogo, updateSchoolLogoUrl } from "@/lib/school-identity";

export const Route = createFileRoute("/super-admin/schools/$id")({
  validateSearch: (
    s: Record<string, unknown>,
  ): { tab?: string; faculty?: string; department?: string; level?: string } => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
    faculty: typeof s.faculty === "string" ? s.faculty : undefined,
    department: typeof s.department === "string" ? s.department : undefined,
    level: typeof s.level === "string" ? s.level : undefined,
  }),
  head: () => ({ meta: [{ title: "School Overview — D4EXAM" }] }),
  component: Page,
});

type Tab =
  | "overview"
  | "users"
  | "faculties"
  | "departments"
  | "students"
  | "teachers"
  | "exams"
  | "results"
  | "activity";

function Page() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mgmtBusy, setMgmtBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const logoFileRef = useRef<HTMLInputElement | null>(null);
  const tab = (search.tab as Tab) || "overview";
  const facultyId = search.faculty ?? null;
  const departmentId = search.department ?? null;
  const levelId = search.level ?? null;

  async function setSchoolStatus(status: string, message: string) {
    if (!id) return;
    setMgmtBusy(true);
    try {
      const { error } = await supabase.from("schools").update({ status } as never).eq("id", id);
      if (error) throw error;
      toast.success(message);
      void qc.invalidateQueries({ queryKey: ["sa-school", id] });
      void qc.invalidateQueries({ queryKey: ["sa-schools-list"] });
      void qc.invalidateQueries({ queryKey: ["sa-ov-counts"] });
    } catch (e) {
      toast.error((e as Error).message || "Could not update school");
    } finally {
      setMgmtBusy(false);
    }
  }


  async function onLogoFile(file: File | null) {
    if (!file || !id) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose a PNG or JPG logo (PNG preferred for transparent background).");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Logo must be under 5MB.");
      return;
    }
    setLogoBusy(true);
    try {
      const up = await uploadSchoolLogo({ file, folder: `schools/${id}` });
      if (!up?.url) throw new Error("Upload failed — try a smaller PNG.");
      await updateSchoolLogoUrl(id, up.url);
      // Also direct update for reliability
      const { error } = await supabase
        .from("schools")
        .update({ logo_url: up.url, updated_at: new Date().toISOString() } as never)
        .eq("id", id);
      if (error) throw error;
      toast.success("School logo updated");
      void qc.invalidateQueries({ queryKey: ["sa-school", id] });
      void qc.invalidateQueries({ queryKey: ["sa-schools-list"] });
    } catch (e) {
      toast.error((e as Error).message || "Could not update logo");
    } finally {
      setLogoBusy(false);
      if (logoFileRef.current) logoFileRef.current.value = "";
    }
  }


  async function deleteSchool() {
    if (!id) return;
    if (!window.confirm("Permanently delete this school record? This cannot be undone from the UI.")) return;
    setMgmtBusy(true);
    try {
      const { error } = await supabase.from("schools").delete().eq("id", id);
      if (error) throw error;
      toast.success("School deleted");
      void navigate({ to: "/super-admin/schools" });
    } catch (e) {
      toast.error((e as Error).message || "Could not delete school (check related data / RLS)");
    } finally {
      setMgmtBusy(false);
    }
  }

  function setTab(next: Tab) {
    void navigate({
      to: "/super-admin/schools/$id",
      params: { id },
      search: { tab: next === "overview" ? undefined : next },
    });
  }

  function goStructure(next: {
    tab?: Tab;
    faculty?: string;
    department?: string;
    level?: string;
  }) {
    void navigate({
      to: "/super-admin/schools/$id",
      params: { id },
      search: {
        tab: next.tab ?? "faculties",
        faculty: next.faculty,
        department: next.department,
        level: next.level,
      },
    });
  }

  const schoolQ = useQuery({
    queryKey: ["sa-school", id],
    enabled: Boolean(id),
    staleTime: 10_000,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("schools")
        .select("id, name, school_code, country, logo_url, subscription_plan, status, created_at")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data as {
        id: string;
        name: string;
        school_code: string | null;
        country: string | null;
        logo_url: string | null;
        subscription_plan: string | null;
        status: string;
        created_at: string | null;
      } | null;
    },
  });

  const statsQ = useQuery({
    queryKey: ["sa-school-stats", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const [users, faculties, departments, students, exams, results, profilesRoles] =
        await Promise.all([
          supabase.from("profiles").select("id", { count: "exact", head: true }).eq("school_id", id),
          supabase.from("faculties").select("id", { count: "exact", head: true }).eq("school_id", id),
          supabase.from("departments").select("id", { count: "exact", head: true }).eq("school_id", id),
          supabase.from("students").select("id", { count: "exact", head: true }).eq("school_id", id),
          supabase.from("examinations").select("id", { count: "exact", head: true }).eq("school_id", id),
          supabase.from("results").select("id", { count: "exact", head: true }).eq("school_id", id),
          supabase.from("profiles").select("id").eq("school_id", id).limit(2000),
        ]);
      let teachers = 0;
      const profileIds = (profilesRoles.data ?? []).map((p) => p.id as string);
      if (profileIds.length) {
        const { data: roles } = await supabase
          .from("user_roles")
          .select("user_id, role")
          .in("user_id", profileIds)
          .eq("role", "teacher");
        teachers = new Set((roles ?? []).map((r) => r.user_id as string)).size;
      }
      return {
        users: users.count ?? 0,
        faculties: faculties.count ?? 0,
        departments: departments.count ?? 0,
        students: students.count ?? 0,
        teachers,
        exams: exams.count ?? 0,
        results: results.count ?? 0,
      };
    },
  });

  const facultiesQ = useQuery({
    queryKey: ["sa-school-faculties", id],
    enabled: Boolean(id) && (tab === "faculties" || tab === "overview"),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("faculties")
        .select("id, name, code, status")
        .eq("school_id", id)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const departmentsQ = useQuery({
    queryKey: ["sa-school-depts", id, facultyId],
    enabled: Boolean(id) && (tab === "departments" || (tab === "faculties" && Boolean(facultyId))),
    queryFn: async () => {
      let q = supabase
        .from("departments")
        .select("id, name, code, status, faculty_id, faculties(name)")
        .eq("school_id", id)
        .order("name");
      if (facultyId) q = q.eq("faculty_id", facultyId);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const studentsQ = useQuery({
    queryKey: ["sa-school-students", id, departmentId, levelId],
    enabled: Boolean(id) && tab === "students",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("students")
        .select("id, full_name, matric_number, student_id, status, departments(name), levels(name)")
        .eq("school_id", id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const teachersQ = useQuery({
    queryKey: ["sa-school-teachers", id],
    enabled: Boolean(id) && tab === "teachers",
    queryFn: async () => {
      const { data: profiles, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, status")
        .eq("school_id", id)
        .order("full_name")
        .limit(500);
      if (error) throw error;
      const ids = (profiles ?? []).map((p) => p.id as string);
      if (!ids.length) return [];
      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("user_id", ids)
        .eq("role", "teacher");
      const teacherIds = new Set((roles ?? []).map((r) => r.user_id as string));
      return (profiles ?? [])
        .filter((p) => teacherIds.has(p.id as string))
        .map((p) => ({
          id: p.id as string,
          name: (p.full_name as string) || "—",
          email: (p.email as string) || "—",
          status: (p.status as string) || "—",
        }));
    },
  });

  const usersQ = useQuery({
    queryKey: ["sa-school-users", id],
    enabled: Boolean(id) && tab === "users",
    queryFn: async () => {
      const { data: profiles, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, status, created_at")
        .eq("school_id", id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      const ids = (profiles ?? []).map((p) => p.id as string);
      let roles: { user_id: string; role: string }[] = [];
      if (ids.length) {
        const { data: r } = await supabase.from("user_roles").select("user_id, role").in("user_id", ids);
        roles = (r ?? []) as { user_id: string; role: string }[];
      }
      const roleByUser: Record<string, string[]> = {};
      for (const r of roles) {
        if (!roleByUser[r.user_id]) roleByUser[r.user_id] = [];
        roleByUser[r.user_id].push(r.role);
      }
      return (profiles ?? []).map((p) => ({
        id: p.id as string,
        name: (p.full_name as string) || "—",
        email: (p.email as string) || "—",
        status: (p.status as string) || "—",
        created_at: p.created_at as string | null,
        roles: roleByUser[p.id as string] ?? [],
      }));
    },
  });

  const examsQ = useQuery({
    queryKey: ["sa-school-exams", id],
    enabled: Boolean(id) && tab === "exams",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("examinations")
        .select("id, title, status, courses(code, name)")
        .eq("school_id", id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []).map((e) => ({
        id: e.id as string,
        title: e.title as string,
        status: e.status as string,
        course:
          ((e as { courses?: { code?: string; name?: string } | null }).courses?.code || "") +
          " " +
          ((e as { courses?: { code?: string; name?: string } | null }).courses?.name || ""),
      }));
    },
  });

  const resultsQ = useQuery({
    queryKey: ["sa-school-results", id],
    enabled: Boolean(id) && tab === "results",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("results")
        .select("id, percentage, grade, status, pass_fail, examinations(title)")
        .eq("school_id", id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const activityQ = useQuery({
    queryKey: ["sa-school-activity", id],
    enabled: Boolean(id) && tab === "activity",
    queryFn: async () => {
      const { data: events, error } = await supabase
        .from("integrity_events")
        .select("id, event_type, description, created_at")
        .eq("school_id", id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (!error && events) return events;
      return [];
    },
  });

  const school = schoolQ.data;
  const stats = statsQ.data;

  const tabs: { id: Tab; label: string; count?: number }[] = useMemo(
    () => [
      { id: "overview", label: "Overview" },
      { id: "users", label: "Users", count: stats?.users },
      { id: "faculties", label: "Faculties/Colleges", count: stats?.faculties },
      { id: "departments", label: "Departments", count: stats?.departments },
      { id: "students", label: "Students", count: stats?.students },
      { id: "teachers", label: "Teachers", count: stats?.teachers },
      { id: "exams", label: "Exams", count: stats?.exams },
      { id: "results", label: "Results", count: stats?.results },
      { id: "activity", label: "Activity Logs" },
    ],
    [stats],
  );

  if ((schoolQ.isLoading || schoolQ.isFetching) && !school) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading school…
      </div>
    );
  }

  if (schoolQ.isError) {
    return (
      <div className="mx-auto max-w-md text-center">
        <p className="font-bold text-slate-900">Could not load school</p>
        <p className="mt-1 text-sm text-slate-500">
          {(schoolQ.error as Error)?.message || "Check your connection and try again."}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button className="font-semibold" onClick={() => void schoolQ.refetch()}>
            Try again
          </Button>
          <Button variant="outline" className="font-semibold" asChild>
            <Link to="/super-admin/schools">Back to schools</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!school) {
    return (
      <div className="text-center">
        <p className="font-bold">School not found</p>
        <Button className="mt-4" asChild>
          <Link to="/super-admin/schools">Back to schools</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={`${school.name} — School Overview`}
        description={
          [school.school_code ? `Code ${school.school_code}` : null, school.country, school.subscription_plan]
            .filter(Boolean)
            .join(" · ") || "School overview"
        }
        actions={<StatusBadge status={school.status} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="relative">
          <SchoolLogo logoUrl={school.logo_url} schoolName={school.name} size="lg" className="!bg-transparent" />
          <input
            ref={logoFileRef}
            type="file"
            accept="image/png,image/webp,image/jpeg,image/jpg"
            className="hidden"
            onChange={(e) => void onLogoFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-extrabold text-slate-900">{school.name}</p>
          <p className="text-xs text-slate-500">
            {school.school_code ? `ID ${school.school_code}` : "No code"}
            {school.country ? ` · ${school.country}` : ""}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 gap-1.5 font-semibold"
            disabled={logoBusy || mgmtBusy}
            onClick={() => logoFileRef.current?.click()}
          >
            {logoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
            {school.logo_url ? "Update logo" : "Upload logo"}
          </Button>
          <p className="mt-1 text-[11px] text-slate-400">PNG with transparent background recommended</p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 font-semibold"
            disabled={mgmtBusy}
            onClick={() =>
              void setSchoolStatus(
                school.status === "suspended" ? "active" : "suspended",
                school.status === "suspended" ? "School reactivated" : "School suspended",
              )
            }
          >
            <Ban className="h-3.5 w-3.5" />
            {school.status === "suspended" ? "Reactivate" : "Suspend"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 font-semibold text-amber-800"
            disabled={mgmtBusy}
            onClick={() => void setSchoolStatus("revoked", "School access revoked")}
          >
            <ShieldOff className="h-3.5 w-3.5" /> Revoke
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 font-semibold text-red-700"
            disabled={mgmtBusy}
            onClick={() => void deleteSchool()}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      </div>

      <nav className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
              tab === t.id
                ? "border-primary bg-primary text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-primary/40",
            )}
          >
            {t.label}
            {typeof t.count === "number" ? ` (${t.count})` : ""}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard icon={Users} label="Total Users" value={stats?.users ?? "…"} />
          <StatCard icon={GraduationCap} label="Total Students" value={stats?.students ?? "…"} />
          <StatCard icon={UserCheck} label="Total Teachers" value={stats?.teachers ?? "…"} />
          <StatCard icon={Building2} label="Faculties / Colleges" value={stats?.faculties ?? "…"} />
          <StatCard icon={Blocks} label="Departments" value={stats?.departments ?? "…"} />
          <StatCard icon={BookOpen} label="Total Exams" value={stats?.exams ?? "…"} />
          <StatCard icon={FileText} label="Total Results" value={stats?.results ?? "…"} />
        </div>
      )}

      {tab === "users" && (
        <SectionCard title={`Users (${usersQ.data?.length ?? 0})`}>
          {usersQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !(usersQ.data?.length) ? (
            <EmptyState title="No users" description="Profiles linked to this school appear here." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {usersQ.data.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div>
                    <p className="font-semibold">{u.name}</p>
                    <p className="text-xs text-slate-500">{u.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">
                      {u.roles.map((r) => r.replaceAll("_", " ")).join(", ") || "—"}
                    </span>
                    <StatusBadge status={u.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "teachers" && (
        <SectionCard title={`Teachers (${teachersQ.data?.length ?? 0})`}>
          {teachersQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !(teachersQ.data?.length) ? (
            <EmptyState title="No teachers" description="Users with teacher role for this school." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {teachersQ.data.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div>
                    <p className="font-semibold">{t.name}</p>
                    <p className="text-xs text-slate-500">{t.email}</p>
                  </div>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "faculties" && (
        <SectionCard title="Faculties / Colleges">
          {(facultiesQ.data ?? []).length === 0 ? (
            <EmptyState title="None" description="No faculties for this school." />
          ) : (
            <ul className="space-y-2">
              {(facultiesQ.data ?? []).map((f) => (
                <li
                  key={f.id as string}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2.5"
                >
                  <p className="text-sm font-bold">{f.name as string}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-semibold"
                    onClick={() => goStructure({ tab: "faculties", faculty: f.id as string })}
                  >
                    View <ChevronRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "departments" && (
        <SectionCard title="Departments">
          {departmentsQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !(departmentsQ.data?.length) ? (
            <EmptyState title="None" description="No departments." />
          ) : (
            <ul className="space-y-2">
              {departmentsQ.data.map((d) => (
                <li key={d.id as string} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
                  <span className="font-semibold">{d.name as string}</span>
                  <span className="ml-2 text-xs text-slate-500">
                    {(d as { faculties?: { name?: string } | null }).faculties?.name ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "students" && (
        <SectionCard title={`Students (${studentsQ.data?.length ?? 0})`}>
          {studentsQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !(studentsQ.data?.length) ? (
            <EmptyState title="No students" description="Student records for this school." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {studentsQ.data.map((s) => (
                <li key={s.id as string} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <p className="font-semibold">{(s as { full_name?: string }).full_name || "—"}</p>
                    <p className="text-xs text-slate-500">
                      {(s.matric_number as string) || (s.student_id as string)}
                    </p>
                  </div>
                  <StatusBadge status={s.status as string} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "exams" && (
        <SectionCard title="Examinations">
          {examsQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !(examsQ.data?.length) ? (
            <EmptyState title="No exams" description="Examinations for this school." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {examsQ.data.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <p className="font-semibold">{e.title}</p>
                    <p className="text-xs text-slate-500">{e.course}</p>
                  </div>
                  <StatusBadge status={e.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "results" && (
        <SectionCard title="Results">
          {resultsQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !(resultsQ.data?.length) ? (
            <EmptyState title="No results" description="Published and pending results." />
          ) : (
            <ul className="space-y-2">
              {resultsQ.data.map((r) => (
                <li
                  key={r.id as string}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm"
                >
                  <span>
                    <span className="font-semibold">
                      {(r as { examinations?: { title?: string } | null }).examinations?.title ?? "Exam"}
                    </span>
                    <span className="ml-2 text-xs text-slate-500">
                      {r.percentage != null ? `${r.percentage}%` : "—"}
                      {r.grade ? ` · ${r.grade}` : ""}
                    </span>
                  </span>
                  <StatusBadge status={r.status as string} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "activity" && (
        <SectionCard title="Activity Logs">
          {activityQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !(activityQ.data?.length) ? (
            <EmptyState
              title="No activity yet"
              description="Security events for this school appear here."
              icon={Activity}
            />
          ) : (
            <ul className="space-y-2">
              {activityQ.data.map((ev) => (
                <li key={ev.id as string} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">
                      {String(ev.event_type || "EVENT").replaceAll("_", " ")}
                    </span>
                    <span className="text-xs text-slate-500">
                      {ev.created_at ? new Date(ev.created_at as string).toLocaleString() : "—"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-600">
                    {(ev as { description?: string }).description || "—"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      <div className="mt-6">
        <Button variant="outline" className="font-semibold" asChild>
          <Link to="/super-admin/schools">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to Schools
          </Link>
        </Button>
      </div>
    </>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <p className="mt-3 text-2xl font-extrabold text-slate-900">{value}</p>
      <p className="text-xs font-semibold text-slate-500">{label}</p>
    </div>
  );
}
