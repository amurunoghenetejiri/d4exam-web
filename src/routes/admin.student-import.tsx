import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader, SectionCard } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSchoolUser, importStudents } from "@/lib/import-students";
import { useSessionUser } from "@/lib/session";
import { toast } from "sonner";
import { Loader2, Upload, Download } from "lucide-react";

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


export const Route = createFileRoute("/admin/student-import")({
  head: () => ({
    meta: [{ title: "Student Import — D4EXAM" }],
  }),
  component: Page,
});

type ParsedRow = {
  firstName: string;
  lastName: string;
  email: string;
  identifier: string;
  matricNumber: string;
  rowNumber: number;
};

function parseCsv(text: string): ParsedRow[] {
  const cleaned = text.replace(/^\uFEFF/, "");
  const lines = cleaned
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        q = !q;
        continue;
      }
      if ((c === "," || c === "\t") && !q) {
        out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(cur.trim());
    return out;
  };

  const headers = split(lines[0]).map((h) =>
    h
      .toLowerCase()
      .replace(/\uFEFF/g, "")
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, ""),
  );
  const idx = (names: string[]) => headers.findIndex((h) => names.includes(h));
  const iFirst = idx(["first_name", "firstname", "first", "given_name"]);
  const iLast = idx(["last_name", "lastname", "last", "surname", "family_name"]);
  const iFull = idx(["full_name", "fullname", "student_name", "name"]);
  const iEmail = idx(["email", "e_mail", "email_address"]);
  const iId = idx([
    "student_id",
    "matric",
    "matric_number",
    "admission_number",
    "id",
    "reg_number",
    "registration_number",
  ]);
  const iMatric = idx(["matric_number", "matric", "reg_no", "reg_number"]);

  const rows: ParsedRow[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = split(lines[r]);
    let firstName = (iFirst >= 0 ? cols[iFirst] : "") || "";
    let lastName = (iLast >= 0 ? cols[iLast] : "") || "";
    if ((!firstName || !lastName) && iFull >= 0 && cols[iFull]) {
      const parts = cols[iFull].trim().split(/\s+/);
      firstName = firstName || parts[0] || "";
      lastName = lastName || parts.slice(1).join(" ") || "Student";
    }
    if (!firstName && cols[0]) firstName = cols[0];
    if (!lastName && cols[1]) lastName = cols[1];

    const email = (iEmail >= 0 ? cols[iEmail] : "") || "";
    let identifier = (iId >= 0 ? cols[iId] : "") || "";
    let matricNumber = (iMatric >= 0 ? cols[iMatric] : "") || "";
    if (!identifier && !matricNumber) {
      if (cols[3]) identifier = cols[3];
      if (cols[4]) matricNumber = cols[4];
      if (!identifier && cols.length === 4 && cols[3]) identifier = cols[3];
    }
    identifier = (identifier || matricNumber).trim();
    matricNumber = (matricNumber || identifier).trim();

    if (!firstName.trim() && !lastName.trim() && !identifier && !matricNumber) continue;

    rows.push({
      firstName: firstName.trim() || "Student",
      lastName: (lastName || "Student").trim(),
      email: email.trim().toLowerCase(),
      identifier,
      matricNumber,
      rowNumber: r + 1,
    });
  }
  return rows;
}

type ImportResult = {
  total: number;
  created: number;
  updated: number;
  failed: number;
  processed: number;
  failures: {
    rowNumber?: number;
    name: string;
    identifier: string;
    matricNumber: string;
    reason: string;
  }[];
};

function Page() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const schoolCode = user?.schoolCode ?? "";
  const createOne = useServerFn(createSchoolUser);
  const importMany = useServerFn(importStudents);
  const qc = useQueryClient();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [preview, setPreview] = useState<ParsedRow[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function addStudent(e: React.FormEvent) {
    e.preventDefault();
    if (!schoolId) {
      toast.error("Not linked to a school");
      return;
    }
    setBusy(true);
    try {
      const res = await createOne({
        data: {
          role: "student",
          firstName: firstName.trim(),
          lastName: lastName.trim() || "Student",
          email: email.trim().toLowerCase(),
          identifier: identifier.trim(),
          matricNumber: identifier.trim(),
        },
      });
      const action = (res as { action?: string }).action;
      toast.success(
        action === "updated"
          ? `Student updated (existing profile kept). Login: school code + matric as password.`
          : `Student created. They log in with school code + matric (${identifier.trim()}) as password.`,
      );
      setFirstName("");
      setLastName("");
      setEmail("");
      setIdentifier("");
      await qc.invalidateQueries({ queryKey: ["admin-all-students"] });
      await qc.invalidateQueries({ queryKey: ["rows"] });
      await qc.invalidateQueries({ queryKey: ["count"] });
    } catch (err) {
      toast.error((err as Error).message || "Could not create student");
    } finally {
      setBusy(false);
    }
  }

  function onFile(file: File | null) {
    if (!file) return;
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseCsv(String(reader.result ?? ""));
      setPreview(rows);
      if (!rows.length) toast.error("No rows detected. Check CSV headers.");
      else toast.message(`${rows.length} student row(s) detected — ready to import`);
    };
    reader.readAsText(file);
  }

  async function runImport() {
    if (!preview.length || !schoolId) return;
    setImportBusy(true);
    setResult(null);
    try {
      const res = (await importMany({
        data: {
          rows: preview.map((r) => ({
            firstName: r.firstName,
            lastName: r.lastName,
            email: r.email,
            identifier: r.identifier,
            matricNumber: r.matricNumber,
            rowNumber: r.rowNumber,
          })),
        },
      })) as ImportResult;

      const total = res.total ?? preview.length;
      const processed = res.processed ?? res.created + res.updated;
      setResult({ ...res, total, processed });
      toast.success(
        `Import complete: ${res.created} new · ${res.updated} updated · ${res.failed} invalid of ${total}`,
      );
      if (res.failed === 0) setPreview([]);
      else toast.message(`${res.failed} row(s) need attention — download error report below`);
      await qc.invalidateQueries({ queryKey: ["admin-all-students"] });
      await qc.invalidateQueries({ queryKey: ["rows"] });
      await qc.invalidateQueries({ queryKey: ["count"] });
      await qc.invalidateQueries({ queryKey: ["struct-students"] });
    } catch (err) {
      toast.error((err as Error).message || "Import failed");
    } finally {
      setImportBusy(false);
    }
  }

  function downloadErrorReport() {
    if (!result?.failures?.length) return;
    const header = "row_number,name,matric,reason\n";
    const body = result.failures
      .map(
        (f) =>
          `${f.rowNumber ?? ""},"${(f.name || "").replace(/"/g, '""')}","${f.matricNumber || f.identifier}","${(f.reason || "").replace(/"/g, '""')}"`,
      )
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `d4exam-import-errors-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Student Import"
        description="Add or bulk-import students. Re-uploading the same matric updates the profile — it never creates duplicates or wipes exam history."
        actions={
          <Button variant="outline" asChild>
            <Link to="/admin/students">View student list</Link>
          </Button>
        }
      />

      <SectionCard title="How students log in">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>
            School code: <strong>{schoolCode || "(your school code)"}</strong>
          </li>
          <li>Username: their email OR matric / student ID</li>
          <li>
            Password: <strong>exactly their matric / student ID</strong>
          </li>
        </ol>
      </SectionCard>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard title="Add one student">
          <form className="space-y-3" onSubmit={addStudent}>
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
              <Label>Matric / Student ID (also their password)</Label>
              <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            </div>
            <Button type="submit" disabled={busy || !schoolId} className="font-semibold">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save student
            </Button>
          </form>
        </SectionCard>

        <SectionCard title="Import CSV from Excel">
          <p className="text-sm text-slate-600">
            Save Excel as CSV. Required columns (header row):
          </p>
          <code className="mt-2 block rounded-lg bg-slate-100 px-3 py-2 text-xs">
            first_name,last_name,email,student_id,matric_number
          </code>
          <p className="mt-2 text-xs text-slate-500">
            Email is optional. Same matric in a new file updates the existing student — exams and
            results are kept.
          </p>
          <div className="mt-4">
            <Label htmlFor="csv">Upload CSV</Label>
            <Input
              id="csv"
              type="file"
              accept=".csv,text/csv,.txt"
              className="mt-1.5"
              disabled={importBusy}
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
          </div>
          {preview.length > 0 && (
            <p className="mt-2 text-sm font-semibold text-slate-800">
              {preview.length} row(s) detected — will process ALL in one upload
            </p>
          )}
          <Button
            type="button"
            className="mt-4 gap-2 font-semibold"
            disabled={importBusy || !preview.length || !schoolId}
            onClick={() => void runImport()}
          >
            {importBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {importBusy ? "Importing all rows…" : "Import all students"}
          </Button>
        </SectionCard>
      </div>

      {result && (
        <SectionCard className="mt-6" title="Import results">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Total records" value={result.total} />
            <Stat label="New students" value={result.created} tone="ok" />
            <Stat label="Updated students" value={result.updated} tone="info" />
            <Stat label="Processed" value={result.processed} />
            <Stat label="Skipped / invalid" value={result.failed} tone={result.failed ? "bad" : undefined} />
          </div>

          {result.failures.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800">Invalid rows</p>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={downloadErrorReport}>
                  <Download className="h-3.5 w-3.5" />
                  Download error report
                </Button>
              </div>
              <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Matric</th>
                      <th className="px-3 py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.failures.map((f, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-3 py-2">{f.rowNumber ?? "—"}</td>
                        <td className="px-3 py-2">{f.name || "—"}</td>
                        <td className="px-3 py-2">{f.matricNumber || f.identifier}</td>
                        <td className="px-3 py-2 text-red-600">{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SectionCard>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "info" | "bad";
}) {
  const color =
    tone === "ok"
      ? "text-emerald-700"
      : tone === "info"
        ? "text-blue-700"
        : tone === "bad"
          ? "text-red-700"
          : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${color}`}>{value}</p>
    </div>
  );
}
