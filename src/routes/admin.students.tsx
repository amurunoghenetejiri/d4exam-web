// @ts-nocheck
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Eye, Building2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin/students")({
  head: () => ({
    meta: [{ title: "Students — D4EXAM" }],
  }),
  component: Page,
});

type StudentRow = {
  id: string;
  student_id: string;
  matric_number: string | null;
  full_name?: string | null;
  status: string;
  faculty_id: string | null;
  department_id: string | null;
  level_id: string | null;
  profile_id?: string | null;
  profiles: { full_name: string; email?: string } | null;
  faculties: { name: string; code: string | null } | null;
  departments: { name: string; code: string | null } | null;
  levels: { name: string; code: string | null } | null;
};

function displayName(s: StudentRow) {
  const fromStudent = (s.full_name || "").trim();
  const fromProfile = (s.profiles?.full_name || "").trim();
  const name = fromProfile || fromStudent;
  if (name && name.toLowerCase() !== "student" && name.toLowerCase() !== "student student") {
    return name;
  }
  if (name) return name;
  return s.matric_number || s.student_id || "—";
}

type SortKey = "name" | "matric" | "level";

function Page() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const schoolCode = user?.schoolCode ?? "";

  const [search, setSearch] = useState("");
  const [facultyFilter, setFacultyFilter] = useState<string>("all");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkFaculty, setBulkFaculty] = useState<string>("");
  const [bulkDept, setBulkDept] = useState<string>("");
  const [bulkLevel, setBulkLevel] = useState<string>("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const qc = useQueryClient();

  const listQ = useQuery({
    queryKey: ["admin-all-students", schoolId],
    enabled: Boolean(schoolId),
    staleTime: 60_000,
    queryFn: async () => {
      const pageSize = 1000;
      const selectFull = `id, student_id, matric_number, status, profile_id,
           faculty_id, department_id, level_id,
           profiles(full_name, email),
           faculties(name, code),
           departments(name, code),
           levels(name, code)`;
      const selectBasic = `id, student_id, matric_number, status, profile_id,
           faculty_id, department_id, level_id,
           profiles(full_name, email)`;
      const selectPlain = `id, student_id, matric_number, status, profile_id,
           faculty_id, department_id, level_id`;

      async function loadAll(select: string) {
        const all: StudentRow[] = [];
        let from = 0;
        for (;;) {
          const { data, error } = await supabase
            .from("students")
            .select(select)
            .eq("school_id", schoolId!)
            .order("matric_number", { ascending: true, nullsFirst: false })
            .range(from, from + pageSize - 1);
          if (error) throw error;
          const chunk = (data ?? []) as StudentRow[];
          all.push(...chunk);
          if (chunk.length < pageSize) break;
          from += pageSize;
          if (from > 20000) break;
        }
        return all;
      }

      async function hydrateProfiles(rows: StudentRow[]): Promise<StudentRow[]> {
        const missing = rows.filter((r) => !r.profiles?.full_name && r.profile_id);
        if (!missing.length) return rows;
        const ids = [...new Set(missing.map((r) => r.profile_id!).filter(Boolean))];
        if (!ids.length) return rows;
        const { data: prows } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", ids);
        const map = new Map((prows ?? []).map((p) => [p.id, p]));
        return rows.map((r) => {
          if (r.profiles?.full_name || !r.profile_id) return r;
          const p = map.get(r.profile_id);
          if (!p) return r;
          return { ...r, profiles: { full_name: p.full_name, email: p.email } };
        });
      }

      async function hydrateStructure(rows: StudentRow[]): Promise<StudentRow[]> {
        const fIds = [...new Set(rows.map((r) => r.faculty_id).filter(Boolean))] as string[];
        const dIds = [...new Set(rows.map((r) => r.department_id).filter(Boolean))] as string[];
        const lIds = [...new Set(rows.map((r) => r.level_id).filter(Boolean))] as string[];
        const [fRes, dRes, lRes] = await Promise.all([
          fIds.length
            ? supabase.from("faculties").select("id, name, code").in("id", fIds)
            : Promise.resolve({ data: [] as { id: string; name: string; code: string | null }[] }),
          dIds.length
            ? supabase.from("departments").select("id, name, code").in("id", dIds)
            : Promise.resolve({ data: [] as { id: string; name: string; code: string | null }[] }),
          lIds.length
            ? supabase.from("levels").select("id, name, code").in("id", lIds)
            : Promise.resolve({ data: [] as { id: string; name: string; code: string | null }[] }),
        ]);
        const fMap = new Map((fRes.data ?? []).map((x) => [x.id, x]));
        const dMap = new Map((dRes.data ?? []).map((x) => [x.id, x]));
        const lMap = new Map((lRes.data ?? []).map((x) => [x.id, x]));
        return rows.map((r) => ({
          ...r,
          faculties: r.faculties?.name
            ? r.faculties
            : r.faculty_id && fMap.get(r.faculty_id)
              ? { name: fMap.get(r.faculty_id)!.name, code: fMap.get(r.faculty_id)!.code }
              : r.faculties,
          departments: r.departments?.name
            ? r.departments
            : r.department_id && dMap.get(r.department_id)
              ? { name: dMap.get(r.department_id)!.name, code: dMap.get(r.department_id)!.code }
              : r.departments,
          levels: r.levels?.name
            ? r.levels
            : r.level_id && lMap.get(r.level_id)
              ? { name: lMap.get(r.level_id)!.name, code: lMap.get(r.level_id)!.code }
              : r.levels,
        }));
      }

      try {
        return await hydrateStructure(await hydrateProfiles(await loadAll(selectFull)));
      } catch {
        try {
          return await hydrateStructure(await hydrateProfiles(await loadAll(selectBasic)));
        } catch {
          try {
            return await hydrateStructure(await hydrateProfiles(await loadAll(selectPlain)));
          } catch {
            const { data, error } = await supabase
              .from("students")
              .select("id, student_id, matric_number, status, profile_id")
              .eq("school_id", schoolId!)
              .limit(5000);
            if (error) throw error;
            return await hydrateStructure(await hydrateProfiles((data ?? []) as StudentRow[]));
          }
        }
      }
    },
  });

  const facultiesQ = useQuery({
    queryKey: ["admin-filter-faculties", schoolId],
    enabled: Boolean(schoolId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("faculties")
        .select("id, name")
        .eq("school_id", schoolId!)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const deptsQ = useQuery({
    queryKey: ["admin-filter-depts", schoolId, facultyFilter],
    enabled: Boolean(schoolId),
    queryFn: async () => {
      let q = supabase.from("departments").select("id, name, faculty_id").eq("school_id", schoolId!);
      if (facultyFilter !== "all") q = q.eq("faculty_id", facultyFilter);
      const { data, error } = await q.order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const levelsQ = useQuery({
    queryKey: ["admin-filter-levels", schoolId],
    enabled: Boolean(schoolId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("levels")
        .select("id, name")
        .eq("school_id", schoolId!)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const rows = useMemo(() => {
    let list = [...(listQ.data ?? [])];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        [displayName(s), s.matric_number ?? "", s.student_id ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    if (facultyFilter !== "all") list = list.filter((s) => s.faculty_id === facultyFilter);
    if (deptFilter !== "all") list = list.filter((s) => s.department_id === deptFilter);
    if (levelFilter !== "all") list = list.filter((s) => s.level_id === levelFilter);
    if (statusFilter !== "all") list = list.filter((s) => s.status === statusFilter);
    list.sort((a, b) => {
      if (sortBy === "matric") {
        return (a.matric_number || a.student_id || "").localeCompare(
          b.matric_number || b.student_id || "",
          undefined,
          { sensitivity: "base" },
        );
      }
      if (sortBy === "level") {
        return (a.levels?.name || "").localeCompare(b.levels?.name || "", undefined, {
          sensitivity: "base",
        });
      }
      return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" });
    });
    return list;
  }, [listQ.data, search, facultyFilter, deptFilter, levelFilter, statusFilter, sortBy]);

  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = selected.size > 0;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      if (rows.length && rows.every((r) => prev.has(r.id))) {
        const next = new Set(prev);
        for (const r of rows) next.delete(r.id);
        return next;
      }
      const next = new Set(prev);
      for (const r of rows) next.add(r.id);
      return next;
    });
  }

  async function assignToDepartment() {
    if (!schoolId) {
      toast.error("Your account is not linked to a school.");
      return;
    }
    if (!selected.size) {
      toast.error("Select at least one student first.");
      return;
    }
    if (!bulkDept && !bulkFaculty && !bulkLevel) {
      toast.error("Choose a faculty, department, or level to assign.");
      return;
    }
    setBulkBusy(true);
    try {
      const ids = [...selected];
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (bulkFaculty) patch.faculty_id = bulkFaculty;
      if (bulkDept) patch.department_id = bulkDept;
      if (bulkLevel) patch.level_id = bulkLevel;
      // batch in chunks
      for (let i = 0; i < ids.length; i += 80) {
        const chunk = ids.slice(i, i + 80);
        const { error } = await supabase
          .from("students")
          .update(patch as never)
          .eq("school_id", schoolId)
          .in("id", chunk);
        if (error) throw error;
      }
      toast.success(`Updated ${ids.length} student${ids.length === 1 ? "" : "s"}`);
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["admin-all-students", schoolId] });
      await qc.invalidateQueries({ queryKey: ["admin-student"] });
      await listQ.refetch();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (/row-level security|42501/i.test(m)) {
        toast.error("Permission denied. Sign in again as school admin.");
      } else {
        toast.error(m || "Could not assign students");
      }
    } finally {
      setBulkBusy(false);
    }
  }

  // Departments filtered by selected faculty when bulk assigning
  const bulkDepts = useMemo(() => {
    const all = deptsQ.data ?? [];
    if (!bulkFaculty) return all;
    return all.filter((d: { faculty_id?: string | null }) => !d.faculty_id || d.faculty_id === bulkFaculty);
  }, [deptsQ.data, bulkFaculty]);

  return (
    <>
      <PageHeader
        title="Students"
        description="Import students first, then select them and assign to a department. Students add their own email later — no placeholder emails."
        actions={
          <Button asChild className="font-semibold">
            <Link to="/admin/student-import">Import students</Link>
          </Button>
        }
      />

      <SectionCard className="space-y-3">
        <p className="text-sm text-slate-600">
          School code: <strong>{schoolCode || "—"}</strong> · Username: email or matric · Password:{" "}
          <strong>their matric / student ID</strong>
        </p>
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              className="h-10 pl-9"
              placeholder="Search name or matric…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={facultyFilter} onValueChange={setFacultyFilter}>
            <SelectTrigger className="h-10 w-[160px]">
              <SelectValue placeholder="Faculty" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All faculties</SelectItem>
              {(facultiesQ.data ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={deptFilter} onValueChange={setDeptFilter}>
            <SelectTrigger className="h-10 w-[160px]">
              <SelectValue placeholder="Department" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {(deptsQ.data ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger className="h-10 w-[140px]">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levels</SelectItem>
              {(levelsQ.data ?? []).map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-10 w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
            <SelectTrigger className="h-10 w-[140px]">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="matric">Matric number</SelectItem>
              <SelectItem value="level">Level</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 text-xs font-semibold" onClick={() => toggleAllVisible()}>
            {allVisibleSelected ? "Clear selection" : "Select all visible"}
          </Button>
          {someSelected ? (
            <span className="text-xs font-semibold text-primary">{selected.size} selected — tap a row to toggle</span>
          ) : (
            <span className="text-xs text-slate-500">Tap a student to select · Details opens the profile</span>
          )}
        </div>
        {someSelected ? (
          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-primary/25 bg-primary/5 p-3">
            <p className="w-full text-xs font-semibold text-slate-700">
              {selected.size} selected · Assign faculty / department / level
            </p>
            <Select value={bulkFaculty || undefined} onValueChange={(v) => { setBulkFaculty(v); setBulkDept(""); }}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue placeholder="Faculty / College" />
              </SelectTrigger>
              <SelectContent>
                {(facultiesQ.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={bulkDept || undefined} onValueChange={setBulkDept}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue placeholder="Department" />
              </SelectTrigger>
              <SelectContent>
                {bulkDepts.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={bulkLevel || undefined} onValueChange={setBulkLevel}>
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                {(levelsQ.data ?? []).map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              className="h-9 gap-1.5 font-semibold"
              disabled={bulkBusy}
              onClick={() => void assignToDepartment()}
            >
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Building2 className="h-3.5 w-3.5" />}
              Add to department
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-9" disabled={bulkBusy} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        ) : null}

        {listQ.isLoading ? (
          <p className="text-sm text-slate-500">Loading students…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No students found"
            description="Import a CSV or add students under Academic Structure → Department → Level."
          />
        ) : (
          <div className="overflow-x-auto">
            <p className="mb-2 text-xs text-slate-500">{rows.length} student(s)</p>
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Full name</th>
                  <th className="py-2 pr-3">Matric</th>
                  <th className="py-2 pr-3">College</th>
                  <th className="py-2 pr-3">Department</th>
                  <th className="py-2 pr-3">Level</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const isOn = selected.has(s.id);
                  return (
                    <tr
                      key={s.id}
                      className={
                        "cursor-pointer border-b border-slate-50 transition " +
                        (isOn ? "bg-primary/10 ring-1 ring-inset ring-primary/30" : "hover:bg-slate-50/80")
                      }
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("a,button")) return;
                        toggleOne(s.id);
                      }}
                    >
                      <td className="py-2.5 pr-3 text-slate-500">{i + 1}</td>
                      <td className="py-2.5 pr-3 font-semibold text-slate-900">
                        {displayName(s)}
                      </td>
                      <td className="py-2.5 pr-3">{s.matric_number ?? s.student_id}</td>
                      <td className="py-2.5 pr-3">{s.faculties?.name ?? "—"}</td>
                      <td className="py-2.5 pr-3">{s.departments?.name ?? "—"}</td>
                      <td className="py-2.5 pr-3">{s.levels?.name ?? "—"}</td>
                      <td className="py-2.5 pr-3">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="py-2.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button size="sm" variant="outline" className="h-8 gap-1 text-xs font-semibold" asChild>
                            <Link to="/admin/student/$id" params={{ id: s.id }}>
                              <Eye className="h-3.5 w-3.5 text-primary" />
                              Details
                            </Link>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
