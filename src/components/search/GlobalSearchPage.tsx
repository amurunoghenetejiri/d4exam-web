/**
 * Full-screen role-aware D4EXAM search.
 * White content surface (native chrome stays navy). Live results as you type.
 * Category icons: materials/book, student/grad-cap, exam/clipboard, etc.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  ClipboardList,
  FileText,
  Loader2,
  Search,
  Users,
  X,
  GraduationCap,
  Building2,
  Shield,
  Trophy,
  LayoutDashboard,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSessionUser, type AppRole } from "@/lib/session";
import { cn } from "@/lib/utils";

type SearchHit = {
  id: string;
  kind:
    | "course"
    | "exam"
    | "student"
    | "teacher"
    | "material"
    | "result"
    | "feature"
    | "school";
  title: string;
  subtitle?: string;
  meta?: string;
  href?: string;
};

const FEATURES: { q: string[]; title: string; href: string; roles?: AppRole[] }[] = [
  { q: ["settings", "security", "password"], title: "Settings", href: "/settings" },
  { q: ["notification", "alerts"], title: "Notifications", href: "/notifications" },
  { q: ["material", "notes", "pdf", "past question"], title: "Materials", href: "/student/materials", roles: ["student"] },
  { q: ["result", "score", "grade"], title: "My Results", href: "/student/results", roles: ["student"] },
  { q: ["exam", "cbt", "test", "examination"], title: "Examinations", href: "/student/examinations", roles: ["student"] },
  { q: ["course", "enrol", "enroll"], title: "My Courses", href: "/student/courses", roles: ["student"] },
  { q: ["history"], title: "Exam History", href: "/student/history", roles: ["student"] },
  { q: ["dashboard", "home"], title: "Dashboard", href: "/student", roles: ["student"] },
  { q: ["monitor", "live", "integrity"], title: "Live monitoring", href: "/officer/live-monitor", roles: ["examination_officer", "school_admin"] },
  { q: ["approval", "approve"], title: "Approvals", href: "/officer/approvals", roles: ["examination_officer"] },
  { q: ["result"], title: "Results", href: "/officer/results", roles: ["examination_officer", "school_admin"] },
  { q: ["student"], title: "Students", href: "/admin/students", roles: ["school_admin"] },
];

function recentKey(userId: string | null, role: string): string {
  const u = userId || "anon";
  return `d4_search_recent_v2:${u}:${role}`;
}

function loadRecent(userId: string | null, role: string): string[] {
  try {
    const raw = localStorage.getItem(recentKey(userId, role));
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(arr) ? arr.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecent(q: string, userId: string | null, role: string) {
  try {
    const term = q.trim();
    if (term.length < 2) return;
    const prev = loadRecent(userId, role).filter((x) => x.toLowerCase() !== term.toLowerCase());
    localStorage.setItem(recentKey(userId, role), JSON.stringify([term, ...prev].slice(0, 8)));
  } catch {
    /* ignore */
  }
}

function safeGo(href: string | undefined) {
  if (!href) return;
  try {
    window.location.assign(href);
  } catch {
    try {
      window.location.href = href;
    } catch {
      /* ignore */
    }
  }
}

function roleHome(role: AppRole): string {
  if (role === "student") return "/student";
  if (role === "teacher") return "/teacher";
  if (role === "examination_officer") return "/officer";
  if (role === "school_admin") return "/admin";
  if (role === "super_admin") return "/super-admin";
  return "/";
}

export function GlobalSearchPage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: session } = useSessionUser();
  const role = (session?.role || "student") as AppRole;
  const schoolId = session?.schoolId ?? null;
  const userId = session?.userId ?? null;

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setRecent(loadRecent(userId, role));
    setQ("");
    setHits([]);
    setErr(null);
  }, [open, userId, role]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setBusy(false);
      setErr(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setErr(null);
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const out = await runSearch(term, role, schoolId, userId);
          if (!cancelled) setHits(out);
        } catch (e) {
          console.warn("[search]", e);
          if (!cancelled) {
            setHits([]);
            setErr("Search failed. Try a different term.");
          }
        } finally {
          if (!cancelled) setBusy(false);
        }
      })();
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, open, role, schoolId, userId]);

  function go(hit: SearchHit) {
    saveRecent(q, userId, role);
    onClose();
    safeGo(hit.href);
  }

  const grouped = useMemo(() => {
    const g: Record<string, SearchHit[]> = {};
    for (const h of hits) {
      (g[h.kind] ||= []).push(h);
    }
    return g;
  }, [hits]);

  const kindLabel: Record<string, string> = {
    course: "Courses",
    exam: "Examinations",
    student: "Students",
    teacher: "Teachers",
    material: "Materials",
    result: "Results",
    feature: "Features",
    school: "Schools",
  };

  if (!open) return null;
  if (typeof document === "undefined") return null;

  try {
    return createPortal(
      <div
        className="fixed inset-0 z-[2147483000] flex flex-col bg-white text-slate-900"
        style={{
          width: "100%",
          height: "100%",
          minHeight: "100vh",
          minWidth: "100vw",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Search D4EXAM"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        {/* Header strip keeps brand navy */}
        <div
          className="shrink-0 border-b border-slate-200 bg-[#0b1b3a] px-3 pb-3 pt-3"
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top, 0px))" }}
        >
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-white/60 bg-white/10 px-3 py-2.5 shadow-[0_0_0_1px_rgba(56,189,248,0.2),inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-sm">
              <Search className="h-5 w-5 shrink-0 text-white" aria-hidden />
              <input
                autoFocus
                type="search"
                enterKeyHint="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search exams, materials, results, courses…"
                className="min-w-0 flex-1 bg-transparent text-base font-medium text-white outline-none placeholder:text-white/75"
                autoComplete="off"
                autoCorrect="off"
              />
              {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/60" /> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/10 text-white hover:bg-white/15"
              aria-label="Close search"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* White body */}
        <div
          className="flex-1 overflow-y-auto bg-white px-3 py-4"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))" }}
        >
          {err ? (
            <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-center text-sm text-amber-800">{err}</p>
          ) : null}

          {q.trim().length < 2 ? (
            <div className="space-y-6">
              {recent.length ? (
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Recent
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {recent.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setQ(r)}
                        className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <section>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Suggested
                </p>
                <div className="grid gap-2">
                  {FEATURES.filter((f) => !f.roles || f.roles.includes(role)).map((f) => (
                    <button
                      key={f.title}
                      type="button"
                      onClick={() => {
                        onClose();
                        safeGo(f.href);
                      }}
                      className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left hover:bg-slate-100"
                    >
                      <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#0b1b3a]/10 text-[#0b1b3a]">
                        <LayoutDashboard className="h-4 w-4" />
                      </span>
                      <span className="font-semibold text-slate-800">{f.title}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          ) : hits.length === 0 && !busy ? (
            <p className="py-12 text-center text-sm text-slate-500">No results for “{q.trim()}”</p>
          ) : (
            <div className="space-y-6">
              {Object.entries(grouped).map(([kind, list]) => (
                <section key={kind}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    {kindLabel[kind] || kind}
                  </p>
                  <div className="grid gap-2">
                    {list.map((h) => (
                      <button
                        key={`${h.kind}-${h.id}`}
                        type="button"
                        onClick={() => go(h)}
                        className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left shadow-sm ring-1 ring-slate-100 hover:bg-slate-50"
                      >
                        <HitIcon kind={h.kind} />
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-slate-900">{h.title}</p>
                          {h.subtitle ? (
                            <p className="mt-0.5 text-sm text-slate-600">{h.subtitle}</p>
                          ) : null}
                          {h.meta ? <p className="mt-1 text-xs text-slate-400">{h.meta}</p> : null}
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>,
      document.body,
    );
  } catch (e) {
    console.error("[GlobalSearchPage]", e);
    return null;
  }
}

function HitIcon({ kind }: { kind: SearchHit["kind"] }) {
  const wrap =
    "grid h-10 w-10 shrink-0 place-items-center rounded-xl mt-0.5";
  if (kind === "material")
    return (
      <span className={cn(wrap, "bg-violet-50 text-violet-700")}>
        <BookOpen className="h-5 w-5" />
      </span>
    );
  if (kind === "course")
    return (
      <span className={cn(wrap, "bg-sky-50 text-sky-700")}>
        <BookOpen className="h-5 w-5" />
      </span>
    );
  if (kind === "exam")
    return (
      <span className={cn(wrap, "bg-blue-50 text-blue-700")}>
        <ClipboardList className="h-5 w-5" />
      </span>
    );
  if (kind === "student")
    return (
      <span className={cn(wrap, "bg-emerald-50 text-emerald-700")}>
        <GraduationCap className="h-5 w-5" />
      </span>
    );
  if (kind === "teacher")
    return (
      <span className={cn(wrap, "bg-amber-50 text-amber-700")}>
        <Users className="h-5 w-5" />
      </span>
    );
  if (kind === "result")
    return (
      <span className={cn(wrap, "bg-rose-50 text-rose-700")}>
        <Trophy className="h-5 w-5" />
      </span>
    );
  if (kind === "school")
    return (
      <span className={cn(wrap, "bg-indigo-50 text-indigo-700")}>
        <Building2 className="h-5 w-5" />
      </span>
    );
  if (kind === "feature")
    return (
      <span className={cn(wrap, "bg-slate-100 text-slate-700")}>
        <Shield className="h-5 w-5" />
      </span>
    );
  return (
    <span className={cn(wrap, "bg-slate-100 text-slate-600")}>
      <FileText className="h-5 w-5" />
    </span>
  );
}

async function runSearch(
  term: string,
  role: AppRole,
  schoolId: string | null,
  userId: string | null,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const raw = term.trim().slice(0, 64);
  const lower = raw.toLowerCase();
  // Escape PostgREST special chars in ilike patterns
  const safe = raw.replace(/[%_,.()]/g, " ").replace(/\s+/g, " ").trim();
  const pattern = `%${safe}%`;

  // Features (local, always available)
  for (const f of FEATURES) {
    if (f.roles && !f.roles.includes(role)) continue;
    if (f.q.some((k) => lower.includes(k) || k.includes(lower) || lower === k)) {
      hits.push({
        id: `feat-${f.title}`,
        kind: "feature",
        title: f.title,
        subtitle: "Go to page",
        href: f.href,
      });
    }
  }

  if (role === "super_admin") {
    try {
      const { data: schools } = await supabase
        .from("schools")
        .select("id, name, code")
        .or(`name.ilike.${JSON.stringify(pattern)},code.ilike.${JSON.stringify(pattern)}`)
        .limit(8);
      for (const s of schools ?? []) {
        hits.push({
          id: String(s.id),
          kind: "school",
          title: String(s.name || "School"),
          subtitle: s.code ? `Code: ${s.code}` : undefined,
          href: `/super-admin/schools/${s.id}`,
        });
      }
    } catch (e) {
      console.warn("[search] schools", e);
    }
  }

  if (!schoolId) {
    // Still return feature hits so search is never empty of all UX
    return hits.slice(0, 40);
  }

  // Courses
  try {
    const { data: courses, error } = await supabase
      .from("courses")
      .select("id, code, name")
      .eq("school_id", schoolId)
      .or(`code.ilike.${JSON.stringify(pattern)},name.ilike.${JSON.stringify(pattern)}`)
      .limit(12);
    if (error) console.warn("[search] courses err", error.message);
    for (const c of courses ?? []) {
      hits.push({
        id: String(c.id),
        kind: "course",
        title: `${c.code || ""} — ${c.name || "Course"}`.trim(),
        subtitle: "Course",
        href:
          role === "student"
            ? "/student/courses"
            : role === "teacher"
              ? "/teacher/courses"
              : role === "examination_officer"
                ? "/officer"
                : "/admin/courses",
      });
    }
  } catch (e) {
    console.warn("[search] courses", e);
  }

  // Examinations
  try {
    const { data: exams, error } = await supabase
      .from("examinations")
      .select("id, title, status, duration_minutes")
      .eq("school_id", schoolId)
      .ilike("title", pattern)
      .limit(12);
    if (error) console.warn("[search] exams err", error.message);
    for (const e of exams ?? []) {
      hits.push({
        id: String(e.id),
        kind: "exam",
        title: String(e.title || "Examination"),
        meta: `Status: ${e.status || "—"} · ${e.duration_minutes ?? "—"} min`,
        href:
          role === "student"
            ? "/student/examinations"
            : role === "examination_officer"
              ? "/officer/live-monitor"
              : role === "teacher"
                ? "/teacher/examinations"
                : "/admin/examinations",
      });
    }
  } catch (e) {
    console.warn("[search] exams", e);
  }

  // Materials — title, description, file_name, tags
  try {
    let q = supabase
      .from("course_materials")
      .select("id, title, description, course_id, file_name, tags")
      .eq("school_id", schoolId)
      .limit(15);
    // Prefer multi-column or; fall back to title only
    const { data: mats, error } = await q.or(
      `title.ilike.${JSON.stringify(pattern)},description.ilike.${JSON.stringify(pattern)},file_name.ilike.${JSON.stringify(pattern)},tags.ilike.${JSON.stringify(pattern)}`,
    );
    if (error) {
      const { data: mats2 } = await supabase
        .from("course_materials")
        .select("id, title, description, course_id, file_name")
        .eq("school_id", schoolId)
        .ilike("title", pattern)
        .limit(15);
      for (const m of mats2 ?? []) {
        hits.push({
          id: String(m.id),
          kind: "material",
          title: String(m.title || m.file_name || "Material"),
          subtitle: m.description ? String(m.description).slice(0, 80) : "Study material",
          href: role === "student" ? "/student/materials" : role === "teacher" ? "/teacher/materials" : roleHome(role),
        });
      }
    } else {
      for (const m of mats ?? []) {
        hits.push({
          id: String(m.id),
          kind: "material",
          title: String(m.title || m.file_name || "Material"),
          subtitle: m.description ? String(m.description).slice(0, 80) : "Study material",
          href: role === "student" ? "/student/materials" : role === "teacher" ? "/teacher/materials" : roleHome(role),
        });
      }
    }
  } catch (e) {
    console.warn("[search] materials", e);
  }

  // Student results (own)
  if (role === "student" && userId) {
    try {
      let sid: string | null = null;
      const byProfile = await supabase
        .from("students")
        .select("id")
        .eq("profile_id", userId)
        .eq("school_id", schoolId)
        .maybeSingle();
      sid = byProfile.data?.id ? String(byProfile.data.id) : null;
      if (!sid) {
        const byUser = await supabase
          .from("students")
          .select("id")
          .eq("user_id", userId)
          .eq("school_id", schoolId)
          .maybeSingle();
        sid = byUser.data?.id ? String(byUser.data.id) : null;
      }
      if (sid) {
        const { data: results } = await supabase
          .from("results")
          .select("id, percentage, grade, examinations(title)")
          .eq("student_id", sid)
          .order("created_at", { ascending: false })
          .limit(25);
        for (const r of results ?? []) {
          const title =
            (r as { examinations?: { title?: string } | null }).examinations?.title ||
            "Exam result";
          if (
            String(title).toLowerCase().includes(lower) ||
            String(r.grade || "").toLowerCase().includes(lower) ||
            lower.includes("result") ||
            lower.includes("score") ||
            lower.includes("grade")
          ) {
            hits.push({
              id: String(r.id),
              kind: "result",
              title: String(title),
              meta:
                r.percentage != null
                  ? `${r.percentage}%${r.grade ? ` · ${r.grade}` : ""}`
                  : r.grade || undefined,
              href: `/student/results/${r.id}`,
            });
          }
        }
      }
    } catch (e) {
      console.warn("[search] student results", e);
    }
  }

  // Students directory — officer / admin
  if (role === "school_admin" || role === "examination_officer" || role === "super_admin") {
    try {
      const { data: students } = await supabase
        .from("students")
        .select("id, matric_number, student_id, full_name")
        .eq("school_id", schoolId)
        .or(
          `matric_number.ilike.${JSON.stringify(pattern)},student_id.ilike.${JSON.stringify(pattern)},full_name.ilike.${JSON.stringify(pattern)}`,
        )
        .limit(12);
      for (const s of students ?? []) {
        hits.push({
          id: String(s.id),
          kind: "student",
          title: String(s.full_name || s.matric_number || "Student"),
          subtitle: s.matric_number ? `Matric: ${s.matric_number}` : s.student_id || undefined,
          href:
            role === "examination_officer"
              ? "/officer/results"
              : role === "school_admin"
                ? `/admin/student/${s.id}`
                : "/officer/live-monitor",
        });
      }
    } catch (e) {
      // full_name may not exist — try without it
      try {
        const { data: students } = await supabase
          .from("students")
          .select("id, matric_number, student_id")
          .eq("school_id", schoolId)
          .or(
            `matric_number.ilike.${JSON.stringify(pattern)},student_id.ilike.${JSON.stringify(pattern)}`,
          )
          .limit(12);
        for (const s of students ?? []) {
          hits.push({
            id: String(s.id),
            kind: "student",
            title: String(s.matric_number || s.student_id || "Student"),
            subtitle: s.matric_number ? `Matric: ${s.matric_number}` : undefined,
            href: role === "examination_officer" ? "/officer/results" : `/admin/student/${s.id}`,
          });
        }
      } catch (e2) {
        console.warn("[search] students", e, e2);
      }
    }
  }

  // Teachers — admin
  if (role === "school_admin" || role === "super_admin") {
    try {
      const { data: teachers } = await supabase
        .from("teachers")
        .select("id, full_name, staff_id")
        .eq("school_id", schoolId)
        .or(`full_name.ilike.${JSON.stringify(pattern)},staff_id.ilike.${JSON.stringify(pattern)}`)
        .limit(8);
      for (const te of teachers ?? []) {
        hits.push({
          id: String(te.id),
          kind: "teacher",
          title: String(te.full_name || "Teacher"),
          subtitle: te.staff_id ? `Staff: ${te.staff_id}` : undefined,
          href: "/admin/teachers",
        });
      }
    } catch (e) {
      console.warn("[search] teachers", e);
    }
  }

  return hits.slice(0, 48);
}
