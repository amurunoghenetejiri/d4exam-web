import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import {
  Loader2,
  UserPlus,
  Trash2,
  Building2,
  Upload,
  MoreVertical,
  UserX,
} from "lucide-react";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSchoolUser } from "@/lib/auth.school-admin.functions";
import { useSessionUser } from "@/lib/session";
import { useRows } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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


export const Route = createFileRoute("/admin/officers")({
  head: () => ({
    meta: [{ title: "Departmental Officers — D4EXAM" }],
  }),
  component: Page,
});

type Officer = {
  id: string;
  officer_id: string;
  status: string;
  department_id?: string | null;
  profile_id?: string | null;
  profiles: { full_name: string; email?: string } | null;
  departments?: { name?: string } | null;
};

type Dept = { id: string; name: string };

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
  const fileRef = useRef<HTMLInputElement>(null);

  const listQ = useRows<Officer>({
    table: "examination_officers",
    select: "id, officer_id, status, department_id, profile_id, profiles(full_name, email), departments(name)",
    filters: schoolId ? [{ column: "school_id", value: schoolId }] : [],
    order: { column: "created_at", ascending: false },
    limit: 200,
    enabled: Boolean(schoolId),
  });

  const deptsQ = useRows<Dept>({
    table: "departments",
    select: "id, name",
    filters: schoolId ? [{ column: "school_id", value: schoolId }] : [],
    order: { column: "name", ascending: true },
    limit: 300,
    enabled: Boolean(schoolId),
  });

  const officers = listQ.data ?? [];
  const departments = deptsQ.data ?? [];
  const deptName = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of departments) m.set(d.id, d.name);
    return m;
  }, [departments]);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [officerId, setOfficerId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [lastCreds, setLastCreds] = useState<{
    officerId: string;
    email: string;
    password: string;
  } | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId) {
      toast.error("Your account is not linked to a school.");
      return;
    }
    setBusy(true);
    try {
      const result = await createOne({
        data: {
          role: "examination_officer",
          firstName: firstName.trim(),
          lastName: lastName.trim() || "Officer",
          email: email.trim().toLowerCase(),
          identifier: officerId.trim(),
          departmentId: departmentId || null,
        },
      });
      if (departmentId && result?.id) {
        try {
          await supabase
            .from("examination_officers")
            .update({ department_id: departmentId } as never)
            .eq("id", String(result.id));
        } catch {
          /* column may not exist yet */
        }
      }
      setLastCreds({
        officerId: result.identifier,
        email: result.email,
        password: result.password ?? officerId.trim(),
      });
      setFirstName("");
      setLastName("");
      setEmail("");
      setOfficerId("");
      setDepartmentId("");
      toast.success((result as { action?: string }).action === "updated" ? "Officer already existed — details updated" : "Departmental officer created");
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(friendlyErr(err, "Could not create officer"));
    } finally {
      setBusy(false);
    }
  }

  async function mapDepartment(officerRowId: string, deptId: string) {
    setActionBusy(officerRowId);
    try {
      const { error } = await supabase
        .from("examination_officers")
        .update({ department_id: deptId || null, updated_at: new Date().toISOString() } as never)
        .eq("id", officerRowId);
      if (error) throw error;
      toast.success(deptId ? "Department assigned" : "Department cleared");
      await listQ.refetch?.();
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Could not map department. Run SQL migration for department_id if needed.",
      );
    } finally {
      setActionBusy(null);
    }
  }

  async function suspendOfficer(o: Officer) {
    setMenuOpen(null);
    setActionBusy(o.id);
    try {
      const { error } = await supabase
        .from("examination_officers")
        .update({ status: "suspended", updated_at: new Date().toISOString() } as never)
        .eq("id", o.id);
      if (error) throw error;
      if (o.profile_id) {
        await supabase
          .from("profiles")
          .update({ status: "suspended", updated_at: new Date().toISOString() } as never)
          .eq("id", o.profile_id);
      }
      toast.success("Officer suspended");
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not suspend");
    } finally {
      setActionBusy(null);
    }
  }

  async function reactivateOfficer(o: Officer) {
    setMenuOpen(null);
    setActionBusy(o.id);
    try {
      const { error } = await supabase
        .from("examination_officers")
        .update({ status: "active", updated_at: new Date().toISOString() } as never)
        .eq("id", o.id);
      if (error) throw error;
      if (o.profile_id) {
        await supabase
          .from("profiles")
          .update({ status: "active", updated_at: new Date().toISOString() } as never)
          .eq("id", o.profile_id);
      }
      toast.success("Officer reactivated");
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reactivate");
    } finally {
      setActionBusy(null);
    }
  }

  async function removeOfficer(o: Officer) {
    if (
      !confirm(
        `Remove departmental officer ${o.profiles?.full_name || o.officer_id}? They will no longer access the app.`,
      )
    ) {
      return;
    }
    setMenuOpen(null);
    setActionBusy(o.id);
    try {
      const { error } = await supabase
        .from("examination_officers")
        .update({ status: "suspended", updated_at: new Date().toISOString() } as never)
        .eq("id", o.id);
      if (error) throw error;
      if (o.profile_id) {
        await supabase
          .from("profiles")
          .update({ status: "suspended", updated_at: new Date().toISOString() } as never)
          .eq("id", o.profile_id);
      }
      toast.success("Officer removed (suspended)");
      await qc.invalidateQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove officer");
    } finally {
      setActionBusy(null);
    }
  }

  async function importOfficers(file: File) {
    if (!schoolId) {
      toast.error("Your account is not linked to a school.");
      return;
    }
    setImportBusy(true);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length < 2) {
        toast.error("CSV needs a header row and at least one officer.");
        return;
      }
      const header = rows[0]!.map((h) => h.toLowerCase().replace(/\s+/g, "_"));
      const idx = (names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
      const iFirst = idx(["first_name", "firstname", "first"]);
      const iLast = idx(["last_name", "lastname", "last"]);
      const iName = idx(["full_name", "name", "officer"]);
      const iEmail = idx(["email", "mail"]);
      const iOid = idx(["officer_id", "staff_id", "identifier", "id"]);
      const iDept = idx(["department", "dept", "department_name"]);

      let ok = 0;
      let fail = 0;
      for (const row of rows.slice(1)) {
        try {
          let first = iFirst >= 0 ? row[iFirst] || "" : "";
          let last = iLast >= 0 ? row[iLast] || "" : "";
          if (!first && iName >= 0) {
            const parts = String(row[iName] || "").trim().split(/\s+/);
            first = parts[0] || "Officer";
            last = parts.slice(1).join(" ") || "Staff";
          }
          const em = (iEmail >= 0 ? row[iEmail] : "") || "";
          const oid = (iOid >= 0 ? row[iOid] : "") || "";
          if (!oid || oid.length < 4) {
            fail += 1;
            continue;
          }
          const deptLabel = iDept >= 0 ? String(row[iDept] || "").trim().toLowerCase() : "";
          const dept =
            departments.find((d) => d.name.toLowerCase() === deptLabel) ||
            departments.find((d) => d.name.toLowerCase().includes(deptLabel) && deptLabel.length > 2);
          const emailVal =
            em.includes("@")
              ? em.toLowerCase()
              : `${oid.replace(/[^a-z0-9]+/gi, ".").toLowerCase()}@placeholder.local`;
          const result = await createOne({
            data: {
              role: "examination_officer",
              firstName: first || "Officer",
              lastName: last || "Staff",
              email: emailVal,
              identifier: oid.trim(),
              departmentId: dept?.id || null,
            },
          });
          if (dept?.id && result?.id) {
            try {
              await supabase
                .from("examination_officers")
                .update({ department_id: dept.id } as never)
                .eq("id", String(result.id));
            } catch {
              /* ignore */
            }
          }
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      toast.success(`Import done: ${ok} created, ${fail} failed`);
      await qc.invalidateQueries();
      await listQ.refetch?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImportBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <PageHeader
        title="Departmental Officers"
        description="Create officers, map each one to a department, import a list, or remove access."
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard title="Add departmental officer">
          <form className="space-y-3" onSubmit={onCreate}>
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
              <Label>Officer ID (also their password)</Label>
              <Input value={officerId} onChange={(e) => setOfficerId(e.target.value)} required minLength={4} />
            </div>
            <div className="space-y-1.5">
              <Label>Department</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
              >
                <option value="">Select department…</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy || !schoolId} className="font-semibold">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
              Create departmental officer
            </Button>
            <p className="text-xs text-slate-500">
              Login: school code <strong>{schoolCode || "—"}</strong> + email/officer ID · password = Officer ID.
            </p>
          </form>
          {lastCreds ? (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <p className="font-bold">Give these login details to the departmental officer</p>
              <p className="mt-1">Officer ID: {lastCreds.officerId}</p>
              <p>Email: {lastCreds.email}</p>
              <p>Password: {lastCreds.password}</p>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard title="Import officers">
          <p className="mb-3 text-sm text-slate-600">
            CSV columns:{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">
              first_name,last_name,email,officer_id,department
            </code>
            . Department should match an existing department name.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importOfficers(f);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={importBusy || !schoolId}
            className="font-semibold"
            onClick={() => fileRef.current?.click()}
          >
            {importBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            Import CSV
          </Button>
        </SectionCard>
      </div>

      <div className="mt-6">
        <SectionCard title="Existing officers">
          {listQ.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : officers.length === 0 ? (
            <EmptyState
              title="No departmental officers yet"
              description="Create or import officers above."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {officers.map((o) => {
                const mappedName =
                  o.departments?.name ||
                  (o.department_id ? deptName.get(o.department_id) : null) ||
                  "No department";
                const menu = menuOpen === o.id;
                return (
                  <li
                    key={o.id}
                    className="relative flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold text-slate-900">
                        {o.profiles?.full_name ?? "Officer"}
                      </p>
                      <p className="text-xs text-slate-500">
                        {o.officer_id}
                        {o.profiles?.email ? ` · ${o.profiles.email}` : ""}
                      </p>
                      <p className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                        <Building2 className="h-3.5 w-3.5" />
                        {mappedName}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={o.status || "active"} />
                      <select
                        className="h-9 max-w-[12rem] rounded-md border border-slate-200 bg-white px-2 text-xs"
                        value={o.department_id ?? ""}
                        disabled={actionBusy === o.id}
                        onChange={(e) => void mapDepartment(o.id, e.target.value)}
                      >
                        <option value="">Select department…</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                      <div className="relative">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 w-9 p-0"
                          disabled={actionBusy === o.id}
                          onClick={() => setMenuOpen(menu ? null : o.id)}
                          aria-label="Officer actions"
                        >
                          {actionBusy === o.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <MoreVertical className="h-4 w-4" />
                          )}
                        </Button>
                        {menu ? (
                          <div className="absolute right-0 z-30 mt-1 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                            {o.status === "suspended" ? (
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                                onClick={() => void reactivateOfficer(o)}
                              >
                                Reactivate officer
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                                onClick={() => void suspendOfficer(o)}
                              >
                                <UserX className="h-3.5 w-3.5" />
                                Suspend officer
                              </button>
                            )}
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                              onClick={() => void removeOfficer(o)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Remove officer
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
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
