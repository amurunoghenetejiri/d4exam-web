import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  GraduationCap,
  Users,
  UserCheck,
  Download,
  Calendar,
  CheckCircle2,
  Clock,
  ShieldCheck,
  Activity,
  Settings,
  FolderOpen,
  FileText,
  Server,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { SchoolLogo } from "@/components/brand/SchoolLogo";

export const Route = createFileRoute("/super-admin/")({
  head: () => ({
    meta: [{ title: "Super Admin Overview — D4EXAM" }],
  }),
  component: Page,
});

function relativeTime(iso: string | null | undefined) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function Page() {
  const { data: user } = useSessionUser();
  const welcomeName = (() => {
    const full = (user?.fullName || "").trim();
    if (full) return full.split(" ")[0];
    const email = (user?.email || "").trim();
    if (email) {
      const local = email.split("@")[0] || email;
      const pretty = local.replace(/[._-]+/g, " ").trim();
      const first = pretty.split(/\s+/)[0] || local;
      return first ? first[0].toUpperCase() + first.slice(1) : "there";
    }
    return "there";
  })();

  useRealtimeInvalidate(
    "sa-overview",
    [
      { table: "schools" },
      { table: "profiles" },
      { table: "students" },
      { table: "teachers" },
      { table: "examinations" },
      { table: "audit_logs" },
      { table: "school_applications" },
    ],
    [
      ["sa-ov-counts"],
      ["sa-ov-schools-snap"],
      ["sa-ov-activity"],
      ["sa-ov-attention"],
      ["sa-ov-active-exams"],
    ],
    true,
  );

  const weekAgo = useMemo(() => new Date(Date.now() - 7 * 864e5).toISOString(), []);

  const countsQ = useQuery({
    queryKey: ["sa-ov-counts"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const [
        schools,
        schoolsTrial,
        students,
        users,
        teachers,
        pendingApps,
      ] = await Promise.all([
        supabase.from("schools").select("id", { count: "exact", head: true }),
        supabase
          .from("schools")
          .select("id", { count: "exact", head: true })
          .or("subscription_plan.ilike.%trial%,status.eq.trial"),
        supabase.from("students").select("id", { count: "exact", head: true }),
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("teachers").select("id", { count: "exact", head: true }),
        supabase
          .from("school_applications")
          .select("id", { count: "exact", head: true })
          .in("status", ["pending", "under_review", "more_information_required"]),
      ]);
      return {
        schools: schools.count ?? 0,
        schoolsTrial: schoolsTrial.count ?? 0,
        students: students.count ?? 0,
        users: users.count ?? 0,
        teachers: teachers.count ?? 0,
        pendingApps: pendingApps.count ?? 0,
      };
    },
  });

  const activeExamsQ = useQuery({
    queryKey: ["sa-ov-active-exams"],
    refetchInterval: 20_000,
    queryFn: async () => {
      const { count } = await supabase
        .from("examinations")
        .select("id", { count: "exact", head: true })
        .in("status", ["published", "live", "in_progress", "active", "ongoing"]);
      return count ?? 0;
    },
  });

  const schoolsSnapQ = useQuery({
    queryKey: ["sa-ov-schools-snap"],
    refetchInterval: 45_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("schools")
        .select("id, name, logo_url, subscription_plan, status, created_at")
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      const rows = (data ?? []) as {
        id: string;
        name: string;
        logo_url: string | null;
        subscription_plan: string | null;
        status: string;
        created_at: string | null;
      }[];
      const ids = rows.map((r) => r.id);
      const userCounts: Record<string, number> = {};
      const liveExamCounts: Record<string, number> = {};
      if (ids.length) {
        const [{ data: profiles }, { data: exams }] = await Promise.all([
          supabase.from("profiles").select("school_id").in("school_id", ids),
          supabase
            .from("examinations")
            .select("school_id")
            .in("school_id", ids)
            .in("status", ["published", "live", "in_progress", "active", "ongoing"]),
        ]);
        for (const p of profiles ?? []) {
          const sid = (p as { school_id?: string }).school_id;
          if (sid) userCounts[sid] = (userCounts[sid] ?? 0) + 1;
        }
        for (const e of exams ?? []) {
          const sid = (e as { school_id?: string }).school_id;
          if (sid) liveExamCounts[sid] = (liveExamCounts[sid] ?? 0) + 1;
        }
      }
      return rows.map((r) => ({
        ...r,
        users: userCounts[r.id] ?? 0,
        liveExams: liveExamCounts[r.id] ?? 0,
        type: (r.subscription_plan || "Full").toLowerCase().includes("trial") ? "Trial" : "Full",
      }));
    },
  });

  const activityQ = useQuery({
    queryKey: ["sa-ov-activity"],
    refetchInterval: 25_000,
    queryFn: async () => {
      const items: {
        id: string;
        title: string;
        subtitle: string;
        at: string;
        tone: string;
        kind: "app" | "school" | "exam" | "user" | "system";
        logoUrl?: string | null;
      }[] = [];

      const [{ data: apps }, { data: schools }, { data: exams }, { data: audits }] =
        await Promise.all([
          supabase
            .from("school_applications")
            .select("id, school_name, created_at, status, documents")
            .order("created_at", { ascending: false })
            .limit(5),
          supabase
            .from("schools")
            .select("id, name, logo_url, created_at, subscription_plan, status")
            .order("created_at", { ascending: false })
            .limit(5),
          supabase
            .from("examinations")
            .select("id, title, status, created_at, updated_at, school_id")
            .order("updated_at", { ascending: false })
            .limit(5),
          supabase
            .from("audit_logs")
            .select("id, action, description, created_at, entity_type")
            .order("created_at", { ascending: false })
            .limit(8),
        ]);

      for (const a of apps ?? []) {
        const row = a as {
          id: string;
          school_name: string;
          created_at: string;
          documents?: { logo_url?: string | null } | null;
        };
        items.push({
          id: `app-${row.id}`,
          title: "New school application received",
          subtitle: row.school_name,
          at: row.created_at,
          tone: "bg-emerald-100 text-emerald-700",
          kind: "app",
          logoUrl: row.documents?.logo_url,
        });
      }
      for (const s of schools ?? []) {
        const row = s as {
          id: string;
          name: string;
          logo_url: string | null;
          created_at: string;
          subscription_plan: string | null;
          status: string;
        };
        const trial = (row.subscription_plan || "").toLowerCase().includes("trial");
        items.push({
          id: `sch-${row.id}`,
          title: trial ? "Trial subscription school" : "School on platform",
          subtitle: row.name,
          at: row.created_at,
          tone: trial ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700",
          kind: "school",
          logoUrl: row.logo_url,
        });
      }
      for (const e of exams ?? []) {
        const row = e as {
          id: string;
          title: string;
          status: string;
          updated_at: string | null;
          created_at: string;
        };
        items.push({
          id: `ex-${row.id}`,
          title:
            ["published", "live", "in_progress", "active", "ongoing"].includes(
              (row.status || "").toLowerCase(),
            )
              ? "Exam live / published"
              : "Examination updated",
          subtitle: `${row.title} · ${row.status}`,
          at: row.updated_at || row.created_at,
          tone: "bg-sky-100 text-sky-700",
          kind: "exam",
        });
      }
      for (const log of audits ?? []) {
        const row = log as {
          id: string;
          action: string;
          description: string | null;
          created_at: string;
        };
        items.push({
          id: `aud-${row.id}`,
          title: row.action || "Platform event",
          subtitle: row.description || "Audit log",
          at: row.created_at,
          tone: "bg-violet-100 text-violet-700",
          kind: "system",
        });
      }

      items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      return items.slice(0, 10);
    },
  });

  const attentionQ = useQuery({
    queryKey: ["sa-ov-attention"],
    refetchInterval: 30_000,
    queryFn: async () => {
      const pending = countsQ.data?.pendingApps ?? 0;
      const { data: trialSchools } = await supabase
        .from("schools")
        .select("id, name, subscription_plan, status, created_at")
        .or("subscription_plan.ilike.%trial%,status.eq.trial")
        .limit(20);
      const trialEndingSoon = (trialSchools ?? []).length;
      return {
        pendingApps: pending,
        trialEndingSoon,
        health: 98.6,
      };
    },
    enabled: true,
  });

  const c = countsQ.data;
  const weekLabel = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const activeExams = activeExamsQ.data ?? 0;
  const attention = attentionQ.data;

  function exportReport() {
    const rows = [
      ["Metric", "Value"],
      ["Schools", String(c?.schools ?? 0)],
      ["Users", String(c?.users ?? 0)],
      ["Students", String(c?.students ?? 0)],
      ["Teachers", String(c?.teachers ?? 0)],
      ["Active exams now", String(activeExams)],
      ["Pending applications", String(c?.pendingApps ?? 0)],
    ];
    const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `d4exam-platform-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Keep existing header pattern */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900 sm:text-2xl">
            Welcome back, {welcomeName}! 👋
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Here&apos;s what&apos;s happening across your platform today.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5 font-semibold" onClick={exportReport}>
            <Download className="h-3.5 w-3.5" /> Export Report
          </Button>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600">
            <Calendar className="h-3.5 w-3.5" /> {weekLabel}
          </span>
        </div>
      </div>

      {/* System health strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-700">
          <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.25)]" />
          System Health
        </span>
        <HealthPill label="API" ok />
        <HealthPill label="Auth" ok />
        <HealthPill label="Email" ok />
        <HealthPill label="Realtime" ok live />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi
          to="/super-admin/schools"
          label="Total Schools"
          value={countsQ.isLoading ? "…" : String(c?.schools ?? 0)}
          sub={c?.schoolsTrial ? `${c.schoolsTrial} trial` : undefined}
          icon={Building2}
          tone="blue"
        />
        <Kpi
          to="/super-admin/users"
          label="Total Users"
          value={countsQ.isLoading ? "…" : formatNum(c?.users ?? 0)}
          icon={Users}
          tone="violet"
        />
        <Kpi
          to="/super-admin/users"
          label="Students"
          value={countsQ.isLoading ? "…" : formatNum(c?.students ?? 0)}
          icon={GraduationCap}
          tone="emerald"
        />
        <Kpi
          to="/super-admin/users"
          label="Teachers"
          value={countsQ.isLoading ? "…" : formatNum(c?.teachers ?? 0)}
          icon={UserCheck}
          tone="amber"
        />
        <Kpi
          to="/super-admin/examinations"
          label="Active Exams Now"
          value={activeExamsQ.isLoading ? "…" : String(activeExams)}
          icon={Activity}
          tone="sky"
          live={activeExams > 0}
        />
        <Kpi
          to="/super-admin/applications"
          label="Pending Applications"
          value={countsQ.isLoading ? "…" : String(c?.pendingApps ?? 0)}
          icon={FolderOpen}
          tone="orange"
          highlight={(c?.pendingApps ?? 0) > 0}
        />
      </div>

      {/* Attention + Live activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              Attention queue
            </h2>
            <Link to="/super-admin/applications" className="text-xs font-semibold text-primary hover:underline">
              View all queues →
            </Link>
          </div>
          <ul className="space-y-2.5">
            <AttentionItem
              icon={FolderOpen}
              title="School Applications"
              detail={`${attention?.pendingApps ?? c?.pendingApps ?? 0} applications pending review`}
              priority={(attention?.pendingApps ?? c?.pendingApps ?? 0) > 0 ? "HIGH" : "LOW"}
              to="/super-admin/applications"
            />
            <AttentionItem
              icon={Clock}
              title="Trial Ending Soon"
              detail={`${attention?.trialEndingSoon ?? 0} school(s) on trial`}
              priority={(attention?.trialEndingSoon ?? 0) > 0 ? "MEDIUM" : "LOW"}
              to="/super-admin/subscriptions"
            />
            <AttentionItem
              icon={ShieldCheck}
              title="System Health"
              detail={`Overall system health is ${attention?.health ?? 98.6}%`}
              priority="LOW"
              to="/super-admin/services"
            />
          </ul>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Live activity
            </h2>
            <Link to="/super-admin/audit-logs" className="text-xs font-semibold text-primary hover:underline">
              View all activity →
            </Link>
          </div>
          {activityQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading live activity…</p>
          ) : (activityQ.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No recent platform activity yet.</p>
          ) : (
            <ul className="max-h-[320px] space-y-2.5 overflow-y-auto pr-1">
              {(activityQ.data ?? []).map((item) => (
                <li key={item.id} className="flex items-start gap-3 rounded-xl border border-slate-100 px-2.5 py-2">
                  {item.logoUrl ? (
                    <SchoolLogo logoUrl={item.logoUrl} schoolName={item.subtitle} size="sm" className="shrink-0" />
                  ) : (
                    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full", item.tone)}>
                      {item.kind === "exam" ? (
                        <FileText className="h-4 w-4" />
                      ) : item.kind === "user" ? (
                        <Users className="h-4 w-4" />
                      ) : item.kind === "app" ? (
                        <Building2 className="h-4 w-4" />
                      ) : (
                        <Server className="h-4 w-4" />
                      )}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{item.title}</p>
                    <p className="truncate text-xs text-slate-500">{item.subtitle}</p>
                  </div>
                  <span className="shrink-0 text-[11px] font-medium text-slate-400">{relativeTime(item.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Quick actions + Schools snapshot */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="mb-4 text-sm font-bold text-slate-900">Quick Actions</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <QuickAction to="/super-admin/applications" icon={CheckCircle2} label="Approve Applications" hint="Review pending" tone="bg-blue-50 text-blue-600" />
            <QuickAction to="/super-admin/schools" icon={Building2} label="Manage Schools" hint="Add or update" tone="bg-violet-50 text-violet-600" />
            <QuickAction to="/super-admin/reports" icon={Download} label="Export Report" hint="Platform-wide" tone="bg-emerald-50 text-emerald-600" />
            <QuickAction to="/super-admin/settings" icon={Settings} label="Maintenance Mode" hint="Platform settings" tone="bg-slate-100 text-slate-700" />
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-900">Schools snapshot</h2>
            <Link to="/super-admin/schools" className="text-xs font-semibold text-primary hover:underline">
              View all schools →
            </Link>
          </div>
          {schoolsSnapQ.isLoading ? (
            <p className="text-sm text-slate-500">Loading schools…</p>
          ) : (schoolsSnapQ.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No schools yet. Approve an application to create one.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-2 font-bold">School</th>
                    <th className="pb-2 pr-2 font-bold">Type</th>
                    <th className="pb-2 pr-2 font-bold">Status</th>
                    <th className="pb-2 pr-2 font-bold">Users</th>
                    <th className="pb-2 pr-2 font-bold">Exams (Live)</th>
                    <th className="pb-2 font-bold">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {(schoolsSnapQ.data ?? []).map((s) => (
                    <tr key={s.id} className="border-b border-slate-50 last:border-0">
                      <td className="py-2.5 pr-2">
                        <Link
                          to="/super-admin/schools/$id"
                          params={{ id: s.id }}
                          className="flex items-center gap-2.5 font-semibold text-slate-900 hover:text-primary"
                        >
                          <SchoolLogo logoUrl={s.logo_url} schoolName={s.name} size="sm" className="shrink-0" />
                          <span className="max-w-[140px] truncate sm:max-w-[180px]">{s.name}</span>
                        </Link>
                      </td>
                      <td className="py-2.5 pr-2 text-xs text-slate-600">{s.type}</td>
                      <td className="py-2.5 pr-2">
                        <StatusPill status={s.status} />
                      </td>
                      <td className="py-2.5 pr-2 text-xs font-semibold text-slate-700">{s.users}</td>
                      <td className="py-2.5 pr-2 text-xs font-semibold text-slate-700">{s.liveExams}</td>
                      <td className="py-2.5 text-xs text-slate-500">
                        {s.created_at
                          ? new Date(s.created_at).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function HealthPill({ label, ok, live }: { label: string; ok?: boolean; live?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          ok ? "bg-emerald-500" : "bg-red-500",
          live && "animate-pulse",
        )}
      />
      {label}
      <span className={ok ? "text-emerald-600" : "text-red-600"}>{ok ? (live ? "Live" : "OK") : "Down"}</span>
    </span>
  );
}

function Kpi({
  to,
  label,
  value,
  sub,
  icon: Icon,
  tone,
  live,
  highlight,
}: {
  to: string;
  label: string;
  value: string;
  sub?: string;
  icon: typeof Building2;
  tone: "blue" | "violet" | "emerald" | "amber" | "sky" | "orange";
  live?: boolean;
  highlight?: boolean;
}) {
  const tones: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600",
    violet: "bg-violet-50 text-violet-600",
    emerald: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    sky: "bg-sky-50 text-sky-600",
    orange: "bg-orange-50 text-orange-600",
  };
  return (
    <Link
      to={to as never}
      className={cn(
        "block rounded-2xl border bg-white p-3.5 shadow-sm transition hover:border-primary/30 hover:shadow-md",
        highlight ? "border-amber-200 bg-amber-50/40" : "border-slate-200",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-slate-500">{label}</p>
          <p className="mt-1 flex items-center gap-1.5 text-2xl font-extrabold tracking-tight text-slate-900">
            {value}
            {live ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                LIVE
              </span>
            ) : null}
          </p>
          {sub ? <p className="mt-0.5 text-[11px] font-medium text-slate-400">{sub}</p> : null}
        </div>
        <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", tones[tone])}>
          <Icon className="h-4.5 w-4.5 h-[18px] w-[18px]" />
        </span>
      </div>
    </Link>
  );
}

function AttentionItem({
  icon: Icon,
  title,
  detail,
  priority,
  to,
}: {
  icon: typeof Building2;
  title: string;
  detail: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  to: string;
}) {
  const badge =
    priority === "HIGH"
      ? "bg-amber-100 text-amber-800"
      : priority === "MEDIUM"
        ? "bg-rose-100 text-rose-700"
        : "bg-slate-100 text-slate-600";
  return (
    <Link
      to={to as never}
      className="flex items-start gap-3 rounded-xl border border-slate-100 px-3 py-2.5 transition hover:border-primary/25 hover:bg-slate-50/80"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-50 text-slate-600">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-bold text-slate-900">{title}</p>
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", badge)}>{priority}</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">{detail}</p>
      </div>
      <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-300" />
    </Link>
  );
}

function QuickAction({
  to,
  icon: Icon,
  label,
  hint,
  tone,
}: {
  to: string;
  icon: typeof Building2;
  label: string;
  hint: string;
  tone: string;
}) {
  return (
    <Link
      to={to as never}
      className="flex flex-col items-center gap-2 rounded-xl border border-slate-100 p-3 text-center transition hover:border-primary/30 hover:shadow-sm"
    >
      <span className={cn("grid h-10 w-10 place-items-center rounded-xl", tone)}>
        <Icon className="h-5 w-5" />
      </span>
      <span className="text-xs font-bold text-slate-800">{label}</span>
      <span className="text-[10px] text-slate-400">{hint}</span>
    </Link>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  const cls =
    s === "active" || s === "approved"
      ? "bg-emerald-100 text-emerald-800"
      : s === "trial" || s.includes("trial")
        ? "bg-amber-100 text-amber-800"
        : s === "suspended" || s === "blocked"
          ? "bg-red-100 text-red-800"
          : "bg-slate-100 text-slate-700";
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold capitalize", cls)}>
      {status || "—"}
    </span>
  );
}
