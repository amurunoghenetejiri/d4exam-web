import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  listSchoolApplications,
  reviewSchoolApplication,
} from "@/lib/auth.school-admin.functions";
import { toast } from "sonner";
import { ArrowLeft, Building2, Copy, Download, Loader2, MapPin, Phone, Mail, User, Trash2, ZoomIn, X as XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/super-admin/applications")({
  head: () => ({
    meta: [{ title: "School Applications — D4EXAM" }],
  }),
  component: Page,
});

type AppRow = {
  id: string;
  school_name: string;
  school_type: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  official_email: string | null;
  official_phone: string | null;
  applicant_name: string;
  applicant_email: string;
  applicant_phone: string | null;
  tracking_code: string | null;
  status: string;
  created_at: string;
  review_notes: string | null;
  documents?: { logo_url?: string | null; logo_name?: string | null; notes?: string | null } | null;
};

type Creds = {
  schoolName: string;
  schoolCode: string;
  adminEmail: string;
  adminPassword: string;
  emailSent?: boolean;
  emailError?: string | null;
};

/** Checkerboard so transparent PNG logos are visible (not black/white solid). */
const LOGO_CHECKER =
  "bg-[length:12px_12px] bg-[linear-gradient(45deg,#e2e8f0_25%,transparent_25%,transparent_75%,#e2e8f0_75%,#e2e8f0),linear-gradient(45deg,#e2e8f0_25%,#f8fafc_25%,#f8fafc_75%,#e2e8f0_75%,#e2e8f0)] bg-[position:0_0,6px_6px]";

function SchoolLogo({
  url,
  name,
  size = "md",
  onOpen,
}: {
  url?: string | null;
  name: string;
  size?: "sm" | "md" | "lg" | "xl";
  /** When set, logo is clickable (zoom / download). */
  onOpen?: (url: string, name: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  const dim =
    size === "xl"
      ? "h-20 w-20"
      : size === "lg"
        ? "h-14 w-14"
        : size === "sm"
          ? "h-9 w-9"
          : "h-12 w-12";
  const src = url && !failed ? url : null;
  if (src) {
    const clickable = Boolean(onOpen);
    return (
      <button
        type="button"
        disabled={!clickable}
        onClick={(e) => {
          e.stopPropagation();
          onOpen?.(src, name);
        }}
        className={cn(
          dim,
          "group relative shrink-0 overflow-hidden rounded-xl border border-slate-200 object-contain shadow-sm",
          LOGO_CHECKER,
          clickable && "cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          !clickable && "cursor-default",
        )}
        aria-label={clickable ? `View ${name} logo` : `${name} logo`}
      >
        <img
          src={src}
          alt={`${name} logo`}
          className="h-full w-full object-contain p-1"
          style={{ backgroundColor: "transparent" }}
          onError={() => setFailed(true)}
        />
        {clickable ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-900/0 transition group-hover:bg-slate-900/25">
            <ZoomIn className="h-5 w-5 text-white opacity-0 drop-shadow transition group-hover:opacity-100" />
          </span>
        ) : null}
      </button>
    );
  }
  return (
    <span
      className={cn(
        dim,
        "grid shrink-0 place-items-center rounded-xl border border-slate-200 bg-slate-50 text-slate-400 shadow-sm",
      )}
      aria-hidden
    >
      <Building2 className={size === "sm" ? "h-4 w-4" : "h-6 w-6"} />
    </span>
  );
}

function LogoLightbox({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function download() {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const a = document.createElement("a");
      const href = URL.createObjectURL(blob);
      a.href = href;
      const ext =
        blob.type.includes("png")
          ? "png"
          : blob.type.includes("webp")
            ? "webp"
            : blob.type.includes("jpeg") || blob.type.includes("jpg")
              ? "jpg"
              : url.startsWith("data:image/png")
                ? "png"
                : "png";
      a.download = `${(name || "school-logo").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-logo.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch {
      // data URL or CORS — open in new tab as fallback
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-slate-950/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`${name} logo`}
      onClick={onClose}
    >
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="min-w-0 truncate text-sm font-semibold text-white">{name} — logo</p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={() => setScale((s) => Math.max(0.5, Number((s - 0.25).toFixed(2))))}
          >
            −
          </Button>
          <span className="min-w-[3rem] text-center text-xs font-semibold text-white/80">{Math.round(scale * 100)}%</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={() => setScale((s) => Math.min(4, Number((s + 0.25).toFixed(2))))}
          >
            +
          </Button>
          <Button
            type="button"
            size="sm"
            className="bg-white font-semibold text-slate-900 hover:bg-slate-100"
            onClick={() => void download()}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Download
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="text-white hover:bg-white/15 hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon className="h-5 w-5" />
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center overflow-auto p-4",
          LOGO_CHECKER,
        )}
        onClick={onClose}
      >
        <img
          src={url}
          alt={`${name} logo`}
          className="max-h-[min(85vh,900px)] max-w-[min(95vw,900px)] object-contain shadow-2xl transition-transform"
          style={{
            backgroundColor: "transparent",
            transform: `scale(${scale})`,
            transformOrigin: "center center",
          }}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
        />
      </div>
    </div>
  );
}

function parseDocuments(raw: unknown): {
  logo_url?: string | null;
  logo_name?: string | null;
  notes?: string | null;
} | null {
  if (raw == null) return null;
  let docs: unknown = raw;
  if (typeof docs === "string") {
    try {
      docs = JSON.parse(docs);
    } catch {
      return null;
    }
  }
  if (!docs || typeof docs !== "object") return null;
  return docs as { logo_url?: string | null; logo_name?: string | null; notes?: string | null };
}

function notesFromApp(app: AppRow): string | null {
  const docs = parseDocuments(app.documents);
  if (!docs) return null;
  const n = docs.notes;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

function logoFromApp(app: AppRow): string | null {
  const docs = parseDocuments(app.documents);
  if (!docs) return null;
  const candidates = [docs.logo_url, (docs as { url?: string }).url, (docs as { logo?: string }).logo];
  for (const u of candidates) {
    if (typeof u === "string" && u.trim()) return u.trim();
  }
  return null;
}


function TrialCountdown({ endsAt }: { endsAt?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [endsAt]);
  if (!endsAt) return <span className="text-xs text-amber-700">Pending activation</span>;
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end)) return null;
  const ms = end - now;
  if (ms <= 0) {
    return (
      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-rose-800">
        Expired
      </span>
    );
  }
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const label =
    h > 0
      ? `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s left`
      : `${m}m ${String(s).padStart(2, "0")}s left`;
  return <span className="font-mono text-xs text-amber-800">{label}</span>;
}

function extrasFromApp(app: AppRow): {
  website?: string | null;
  social_link?: string | null;
  approx_students?: string | null;
  approx_teachers?: string | null;
  application_type?: string | null;
  is_trial?: boolean;
  trial_hours?: number | null;
  trial_ends_at?: string | null;
  lat?: number | null;
  lng?: number | null;
} {
  const docs = parseDocuments(app.documents) as Record<string, unknown> | null;
  if (!docs) return {};
  const num = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
    return null;
  };
  return {
    website: typeof docs.website === "string" ? docs.website : null,
    social_link: typeof docs.social_link === "string" ? docs.social_link : null,
    approx_students: docs.approx_students != null ? String(docs.approx_students) : null,
    approx_teachers: docs.approx_teachers != null ? String(docs.approx_teachers) : null,
    application_type: typeof docs.application_type === "string" ? docs.application_type : null,
    is_trial: Boolean(docs.is_trial) || docs.application_type === "trial",
    trial_hours: num(docs.trial_hours),
    trial_ends_at: typeof docs.trial_ends_at === "string" ? docs.trial_ends_at : null,
    lat: num(docs.lat),
    lng: num(docs.lng),
  };
}


function locationLine(app: AppRow): string {
  return [app.city, app.state, app.country].filter(Boolean).join(", ") || "—";
}

async function attachDocuments(rows: AppRow[]): Promise<AppRow[]> {
  if (!rows.length) return rows;
  try {
    const ids = rows.map((r) => r.id);
    const { data: docRows, error } = await supabase
      .from("school_applications")
      .select("id, documents")
      .in("id", ids);
    if (!error && docRows?.length) {
      const byId = new Map<string, unknown>();
      for (const d of docRows) {
        byId.set(String((d as { id: string }).id), (d as { documents?: unknown }).documents);
      }
      for (const r of rows) {
        if (byId.has(r.id)) r.documents = parseDocuments(byId.get(r.id)) as AppRow["documents"];
      }
      return rows;
    }
  } catch (e) {
    console.warn("[applications] bulk documents failed:", e);
  }
  await Promise.all(
    rows.map(async (r) => {
      try {
        const { data } = await supabase
          .from("school_applications")
          .select("documents")
          .eq("id", r.id)
          .maybeSingle();
        if (data) r.documents = parseDocuments((data as { documents?: unknown }).documents) as AppRow["documents"];
      } catch {
        /* skip */
      }
    }),
  );
  return rows;
}

async function fetchApplicationsClient(): Promise<AppRow[]> {
  const colsWithDocs =
    "id, school_name, school_type, country, state, city, address, official_email, official_phone, applicant_name, applicant_email, applicant_phone, tracking_code, status, created_at, review_notes, documents";
  const colsNoDocs =
    "id, school_name, school_type, country, state, city, address, official_email, official_phone, applicant_name, applicant_email, applicant_phone, tracking_code, status, created_at, review_notes";

  let { data, error } = await supabase
    .from("school_applications")
    .select(colsWithDocs)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.warn("[applications] select with documents failed:", error.message);
    const retry = await supabase
      .from("school_applications")
      .select(colsNoDocs)
      .order("created_at", { ascending: false })
      .limit(200);
    data = retry.data as typeof data;
    error = retry.error;
  }

  if (error) {
    const msg = String(error.message || "");
    // Missing table/column or empty project: show friendly empty state, not raw Postgres error
    const soft =
      /does not exist|relation|permission denied|schema cache|PGRST/i.test(msg) ||
      error.code === "42P01" ||
      error.code === "42703" ||
      error.code === "PGRST116" ||
      error.code === "PGRST205";
    console.error("[applications] client select:", error);
    if (soft) return [];
    throw new Error(error.message || "Could not load applications");
  }

  let rows = (data ?? []) as AppRow[];
  for (const r of rows) {
    r.documents = parseDocuments(r.documents) as AppRow["documents"];
  }
  if (rows.some((r) => !logoFromApp(r))) {
    rows = await attachDocuments(rows);
  }
  return rows;
}

function Page() {
  const review = useServerFn(reviewSchoolApplication);
  const listApps = useServerFn(listSchoolApplications);
  const qc = useQueryClient();

  const { data, isLoading, refetch, error: listError } = useQuery({
    queryKey: ["super-admin", "school_applications"],
    queryFn: async () => {
      try {
        const clientRows = await fetchApplicationsClient();
        if (clientRows.length > 0) return clientRows;
      } catch (e) {
        console.warn("[applications] client list failed:", e);
      }

      try {
        const rows = await listApps();
        if (Array.isArray(rows) && rows.length > 0) {
          const normalized = (rows as AppRow[]).map((r) => ({
            ...r,
            documents: parseDocuments(r.documents) as AppRow["documents"],
          }));
          return normalized;
        }
      } catch (e) {
        console.warn("[applications] server list failed:", e);
      }

      return await fetchApplicationsClient();
    },
    staleTime: 2_000,
    refetchOnWindowFocus: true,
    refetchInterval: 10_000,
    retry: 2,
  });

  useEffect(() => {
    const channel = supabase
      .channel("super-admin-school-applications")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "school_applications" },
        () => {
          void qc.invalidateQueries({ queryKey: ["super-admin", "school_applications"] });
          void refetch();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [qc, refetch]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<Creds | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logoViewer, setLogoViewer] = useState<{ url: string; name: string } | null>(null);

  const apps = data ?? [];
  const selected = useMemo(
    () => (selectedId ? apps.find((a) => a.id === selectedId) ?? null : null),
    [apps, selectedId],
  );

  async function decide(
    applicationId: string,
    decision: "approved" | "rejected" | "under_review" | "more_information_required",
  ) {
    if (decision === "approved") {
      const ok = window.confirm(
        "Are you sure you want to approve this school application?\n\nThis will create the school, generate login credentials, and notify the applicant.",
      );
      if (!ok) return;
    }
    if (decision === "rejected") {
      const ok = window.confirm("Reject this application? The school will not be created.");
      if (!ok) return;
    }

    setBusyId(applicationId);
    try {
      const result = await review({
        data: {
          applicationId,
          decision,
          notes: notes[applicationId]?.trim() || undefined,
        },
      });

      if (decision === "approved" && result && "schoolCode" in result && result.schoolCode) {
        const r = result as {
          schoolName?: string;
          schoolCode?: string;
          adminEmail?: string;
          adminPassword?: string;
          emailSent?: boolean;
          emailError?: string | null;
        };
        setCreds({
          schoolName: String(r.schoolName ?? "School"),
          schoolCode: String(r.schoolCode),
          adminEmail: String(r.adminEmail ?? ""),
          adminPassword: String(r.adminPassword ?? ""),
          emailSent: r.emailSent,
          emailError: r.emailError,
        });
        if (r.emailSent) {
          toast.success("School approved. Login details emailed to the applicant.");
        } else {
          toast.success(
            r.emailError
              ? `School approved. Email failed (${r.emailError}). Copy details below.`
              : "School approved. Copy the login details below (email not configured).",
          );
        }
      } else if (decision === "rejected") {
        toast.success("Application rejected.");
        setCreds(null);
      } else if (decision === "more_information_required") {
        toast.success("Marked as needing more information.");
      } else {
        toast.success("Application marked under review.");
      }

      await qc.invalidateQueries({ queryKey: ["super-admin", "school_applications"] });
      await qc.invalidateQueries({ queryKey: ["sa-schools-list"] });
      await qc.invalidateQueries({ queryKey: ["sa-schools-counts"] });
      await qc.invalidateQueries({ queryKey: ["super-admin"] });
      await refetch();
    } catch (e) {
      toast.error((e as Error).message || "Could not update application");
    } finally {
      setBusyId(null);
    }
  }

  function copyCreds() {
    if (!creds) return;
    const text = [
      `Congratulations! Your school is live on D4EXAM.`,
      `School: ${creds.schoolName}`,
      `School code: ${creds.schoolCode}`,
      `Admin email: ${creds.adminEmail}`,
      `Temporary password: ${creds.adminPassword}`,
      `Login: open /login, enter school code, email and password.`,
    ].join("\n");
    void navigator.clipboard.writeText(text).then(
      () => toast.success("Credentials copied"),
      () => toast.error("Could not copy"),
    );
  }

  if (selected) {
    const logo = logoFromApp(selected);
    const st = String(selected.status || "").toLowerCase();
    const isApproved = st === "approved";
    const isRejected = st === "rejected";
    const isPending =
      st === "pending" || st === "under_review" || st === "more_information_required" || !st;

    return (
      <>
        {logoViewer ? (
          <LogoLightbox
            url={logoViewer.url}
            name={logoViewer.name}
            onClose={() => setLogoViewer(null)}
          />
        ) : null}
        <PageHeader
          title={selected.school_name}
          description="Full application details submitted by the school"
          actions={<StatusBadge status={selected.status || "pending"} />}
        />

        <div className="mb-4">
          <Button type="button" variant="outline" size="sm" className="font-semibold" onClick={() => setSelectedId(null)}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to applications
          </Button>
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <SchoolLogo url={logo} name={selected.school_name} size="xl" onOpen={(url, n) => setLogoViewer({ url, name: n })} />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-extrabold text-slate-900">{selected.school_name}</p>
            <p className="mt-0.5 text-sm text-slate-500">
              {[selected.school_type, locationLine(selected)].filter(Boolean).join(" · ")}
            </p>
            {selected.tracking_code ? (
              <p className="mt-1 font-mono text-xs text-slate-400">Ref {selected.tracking_code}</p>
            ) : null}
          </div>
          <StatusBadge status={selected.status || "pending"} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Institution">
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Name</dt>
                <dd className="font-medium text-slate-900">{selected.school_name}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Type</dt>
                <dd className="capitalize text-slate-800">{selected.school_type || "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Location</dt>
                <dd className="text-slate-800">
                  <span className="inline-flex items-start gap-1">
                    <MapPin className="mt-0.5 h-3.5 w-3.5 text-slate-400" />
                    {locationLine(selected)}
                  </span>
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Address</dt>
                <dd className="text-slate-800">{selected.address || "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Official email</dt>
                <dd className="text-slate-800">
                  <span className="inline-flex items-center gap-1">
                    <Mail className="h-3.5 w-3.5 text-slate-400" />
                    {selected.official_email || "—"}
                  </span>
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Official phone</dt>
                <dd className="text-slate-800">
                  <span className="inline-flex items-center gap-1">
                    <Phone className="h-3.5 w-3.5 text-slate-400" />
                    {selected.official_phone || "—"}
                  </span>
                </dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard title="Contact person">
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Name</dt>
                <dd className="font-medium text-slate-900">
                  <span className="inline-flex items-center gap-1">
                    <User className="h-3.5 w-3.5 text-slate-400" />
                    {selected.applicant_name}
                  </span>
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Email</dt>
                <dd className="text-slate-800">{selected.applicant_email}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Phone</dt>
                <dd className="text-slate-800">{selected.applicant_phone || "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 font-semibold text-slate-500">Submitted</dt>
                <dd className="text-slate-800">
                  {selected.created_at ? new Date(selected.created_at).toLocaleString() : "—"}
                </dd>
              </div>
            </dl>
          </SectionCard>
        </div>

        {notesFromApp(selected) ? (
          <div className="mt-4">
            <SectionCard title="Applicant notes">
              <p className="whitespace-pre-wrap text-sm text-slate-700">{notesFromApp(selected)}</p>
            </SectionCard>
          </div>
        ) : null}

        
{(() => {
  const x = extrasFromApp(selected);
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <SectionCard title="Application extras">
        <dl className="space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 font-semibold text-slate-500">Type</dt>
            <dd className="font-semibold text-slate-800">
              {x.is_trial ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-800">
                    Trial / Demo
                  </span>
                  <TrialCountdown endsAt={x.trial_ends_at} />
                </span>
              ) : (
                "Full school"
              )}
            </dd>
          </div>
          {x.website ? (
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 font-semibold text-slate-500">Website</dt>
              <dd className="break-all text-slate-800">
                <a href={x.website.startsWith("http") ? x.website : `https://${x.website}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  {x.website}
                </a>
              </dd>
            </div>
          ) : null}
          {x.social_link ? (
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 font-semibold text-slate-500">Social</dt>
              <dd className="break-all text-slate-800">{x.social_link}</dd>
            </div>
          ) : null}
          {(x.approx_students || x.approx_teachers) ? (
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 font-semibold text-slate-500">Size</dt>
              <dd className="text-slate-800">
                {[
                  x.approx_students ? `${x.approx_students} students` : null,
                  x.approx_teachers ? `${x.approx_teachers} teachers` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </dd>
            </div>
          ) : null}
        </dl>
      </SectionCard>
      {x.lat != null && x.lng != null ? (
        <SectionCard title="Map location" description="Pinned by the applicant">
          <p className="mb-2 font-mono text-xs text-slate-500">
            {x.lat.toFixed(5)}, {x.lng.toFixed(5)}
          </p>
          <iframe
            title="Applicant map pin"
            className="h-56 w-full rounded-xl border border-slate-200"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            src={
              "https://www.openstreetmap.org/export/embed.html?bbox=" +
              (x.lng - 0.03) +
              "%2C" +
              (x.lat - 0.02) +
              "%2C" +
              (x.lng + 0.03) +
              "%2C" +
              (x.lat + 0.02) +
              "&layer=mapnik&marker=" +
              x.lat +
              "%2C" +
              x.lng
            }
          />
          <div className="mt-2 flex flex-wrap gap-3 text-xs font-semibold">
            <a className="text-primary hover:underline" href={`https://www.openstreetmap.org/?mlat=${x.lat}&mlon=${x.lng}#map=17/${x.lat}/${x.lng}`} target="_blank" rel="noreferrer">
              Open in OpenStreetMap
            </a>
            <a className="text-primary hover:underline" href={`https://www.google.com/maps?q=${x.lat},${x.lng}`} target="_blank" rel="noreferrer">
              Open in Google Maps
            </a>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
})()}

<div className="mt-4">
          <SectionCard title="School logo">
            <div className="flex items-center gap-4">
              <SchoolLogo url={logo} name={selected.school_name} size="xl" onOpen={(url, n) => setLogoViewer({ url, name: n })} />
              <p className="text-sm text-slate-500">
                {logo
                  ? "Official logo uploaded with the application."
                  : "No logo was stored for this application."}
              </p>
            </div>
          </SectionCard>
        </div>

        {creds && (
          <div className="mt-4">
            <SectionCard title="Approved — login credentials" description="Share these with the school administrator.">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-4 text-sm">
                <p className="font-bold text-emerald-900">Congratulations — school space is ready</p>
                <ul className="mt-2 space-y-1 font-mono text-xs text-slate-800 sm:text-sm">
                  <li>
                    <span className="font-sans font-semibold text-slate-600">School:</span> {creds.schoolName}
                  </li>
                  <li>
                    <span className="font-sans font-semibold text-slate-600">School code:</span> {creds.schoolCode}
                  </li>
                  <li>
                    <span className="font-sans font-semibold text-slate-600">Admin email:</span> {creds.adminEmail}
                  </li>
                  <li>
                    <span className="font-sans font-semibold text-slate-600">Password:</span> {creds.adminPassword}
                  </li>
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="gap-1.5 font-semibold" onClick={copyCreds}>
                    <Copy className="h-3.5 w-3.5" /> Copy details
                  </Button>
                </div>
              </div>
            </SectionCard>
          </div>
        )}

        <div className="mt-6">
          {isApproved ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              Approved — this school is live. Manage it from Schools.
            </div>
          ) : isRejected ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
              Rejected — no further review actions.
            </div>
          ) : (
            <SectionCard title="Review actions">
              <div className="space-y-2">
                <Textarea
                  placeholder="Review notes / feedback (optional)"
                  value={notes[selected.id] ?? selected.review_notes ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [selected.id]: e.target.value }))}
                  rows={2}
                  className="border-slate-200"
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" className="font-semibold" disabled={busyId === selected.id} onClick={() => void decide(selected.id, "approved")}>
                    {busyId === selected.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" disabled={busyId === selected.id} onClick={() => void decide(selected.id, "under_review")}>
                    Under review
                  </Button>
                  <Button size="sm" variant="outline" disabled={busyId === selected.id} onClick={() => void decide(selected.id, "more_information_required")}>
                    Need more info
                  </Button>
                  <Button size="sm" variant="destructive" disabled={busyId === selected.id} onClick={() => void decide(selected.id, "rejected")}>
                    Reject
                  </Button>
                </div>
                {isPending ? <p className="text-xs text-slate-500">Status: pending until you approve or reject.</p> : null}
              </div>
            </SectionCard>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {logoViewer ? (
        <LogoLightbox
          url={logoViewer.url}
          name={logoViewer.name}
          onClose={() => setLogoViewer(null)}
        />
      ) : null}
      <PageHeader
        title="School Applications"
        description="Pending applications appear as cards. Click a school to open full details. Approve creates the school and login credentials."
      />

      {creds && (
        <SectionCard title="Approved — login credentials" description="Share these with the school administrator.">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-4 text-sm">
            <p className="font-bold text-emerald-900">Congratulations — school space is ready</p>
            <ul className="mt-2 space-y-1 font-mono text-xs text-slate-800 sm:text-sm">
              <li>
                <span className="font-sans font-semibold text-slate-600">School:</span> {creds.schoolName}
              </li>
              <li>
                <span className="font-sans font-semibold text-slate-600">School code:</span> {creds.schoolCode}
              </li>
              <li>
                <span className="font-sans font-semibold text-slate-600">Admin email:</span> {creds.adminEmail}
              </li>
              <li>
                <span className="font-sans font-semibold text-slate-600">Password:</span> {creds.adminPassword}
              </li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="gap-1.5 font-semibold" onClick={copyCreds}>
                <Copy className="h-3.5 w-3.5" /> Copy details
              </Button>
            </div>
          </div>
        </SectionCard>
      )}

      <div className="mt-4 sm:mt-6">
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading applications…</p>
        ) : listError ? (
          <EmptyState
            title="No school applications yet"
            description="When schools apply from the public form, they will appear here for review."
          />
        ) : apps.length === 0 ? (
          <EmptyState
            title="No school applications yet"
            description="When schools apply from the public form, they will appear here for review."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((app) => {
              const logo = logoFromApp(app);
              return (
                <SwipeDeleteCard
                  key={app.id}
                  onOpen={() => setSelectedId(app.id)}
                  onDelete={async () => {
                    const ok = window.confirm(`Delete application for ${app.school_name}?`);
                    if (!ok) return;
                    try {
                      const { error } = await supabase.from("school_applications").delete().eq("id", app.id);
                      if (error) throw error;
                      toast.success("Application deleted");
                      void qc.invalidateQueries({ queryKey: ["super-admin", "school_applications"] });
                      void refetch();
                    } catch (e) {
                      toast.error((e as Error).message || "Could not delete application");
                    }
                  }}
                >
                  <div className="flex w-full items-start gap-3">
                    <SchoolLogo url={logo} name={app.school_name} size="lg" onOpen={(url, n) => setLogoViewer({ url, name: n })} />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-base font-bold text-slate-900">{app.school_name}</h2>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {[app.school_type, app.city || app.state || app.country].filter(Boolean).join(" · ") || "—"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <StatusBadge status={app.status || "pending"} />
                        {extrasFromApp(app).is_trial ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                            Trial / Demo
                          </span>
                        ) : null}
                        {extrasFromApp(app).lat != null ? (
                          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-800">
                            Map
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-slate-400">
                    {app.created_at ? new Date(app.created_at).toLocaleString() : ""}
                  </p>
                </SwipeDeleteCard>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/** Drag left to reveal delete, then release past threshold to delete. Tap opens detail. */
function SwipeDeleteCard({
  children,
  onOpen,
  onDelete,
}: {
  children: React.ReactNode;
  onOpen: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const [ox, setOx] = useState(0);
  const startX = useRef(0);
  const dragging = useRef(false);
  const moved = useRef(false);

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <div className="absolute inset-y-0 right-0 flex w-20 items-center justify-center bg-red-500">
        <Trash2 className="h-5 w-5 text-white" />
      </div>
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onOpen();
        }}
        onPointerDown={(e) => {
          dragging.current = true;
          moved.current = false;
          startX.current = e.clientX;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          const dx = e.clientX - startX.current;
          if (Math.abs(dx) > 6) moved.current = true;
          setOx(Math.min(0, Math.max(-88, dx)));
        }}
        onPointerUp={() => {
          dragging.current = false;
          if (ox < -64) {
            void onDelete();
            setOx(0);
            return;
          }
          if (!moved.current) onOpen();
          setOx(0);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setOx(0);
        }}
        className="relative flex flex-col items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-primary/40 hover:shadow-md"
        style={{ transform: `translateX(${ox}px)`, touchAction: "pan-y" }}
      >
        {children}
      </div>
    </div>
  );
}
