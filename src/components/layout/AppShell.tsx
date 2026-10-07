// @ts-nocheck
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  Building2,
  ChevronRight,
  GraduationCap,
  LogOut,
  Menu,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { SchoolLogo } from "@/components/brand/SchoolLogo";
import { Watermark } from "@/components/brand/Watermark";
import { InstallAndPushPrompt } from "@/components/InstallAndPushPrompt";
import { NetworkBanner } from "@/components/NetworkBanner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, shortLabel, shortDisplayName } from "@/lib/utils";
import { initials, signOut, useSessionUser, type AppRole } from "@/lib/session";
import { useSchoolIdentity } from "@/lib/school-identity";
import { useUnreadNotificationCount } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/lib/realtime";
import type { RoleConfig } from "@/components/navigation/navConfig";
import { useT } from "@/lib/i18n";
import { appNavigate } from "@/lib/app-navigate";

import { GlobalSearchPage } from "@/components/search/GlobalSearchPage";

export interface AppUser {
  name: string;
  avatar: string;
  avatarUrl?: string | null;
  subtitle: string;
}

const ROLE_LABELS: Record<string, { label: string; icon: typeof UserRound }> = {
  student: { label: "Student", icon: GraduationCap },
  teacher: { label: "Teacher", icon: UserRound },
  school_admin: { label: "School Admin", icon: Building2 },
  examination_officer: { label: "Departmental Officer", icon: Shield },
  super_admin: { label: "Super Admin", icon: ShieldCheck },
};

function roleMeta(role: AppRole | string | null | undefined) {
  if (!role) return { label: "User", icon: UserRound };
  return ROLE_LABELS[role] ?? { label: String(role).replace(/_/g, " "), icon: UserRound };
}

function AccountRoleBadge({
  role,
  className,
}: {
  role: AppRole | string | null | undefined;
  className?: string;
}) {
  if (!role) return null;
  const { label, icon: Icon } = roleMeta(role);
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600",
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0 text-slate-500" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}


const NAV_I18N: Record<string, string> = {
  Dashboard: "nav.dashboard",
  Home: "nav.home",
  "My Exams": "nav.myExams",
  Exams: "nav.exams",
  Examinations: "nav.examinations",
  Results: "nav.results",
  "Results / Exam Analysis": "nav.resultsAnalysis",
  "My Courses": "nav.myCourses",
  Courses: "nav.courses",
  Materials: "nav.materials",
  Notifications: "nav.notifications",
  Profile: "nav.profile",
  Settings: "nav.settings",
  Students: "nav.students",
  Teachers: "nav.teachers",
  Officers: "nav.officers",
  "Live Monitor": "nav.liveMonitor",
  Approvals: "nav.approvals",
  Integrity: "nav.integrity",
  Reports: "nav.reports",
  "Question bank": "nav.questionBank",
  "Question Bank": "nav.questionBank",
  Marking: "nav.marking",
  Submissions: "nav.submissions",
  Account: "nav.account",
  Logout: "nav.logout",
};

function translateNavLabel(label: string, tFn: (k: string) => string) {
  const key = NAV_I18N[label];
  return key ? tFn(key) : label;
}

function NavLinks({
  config,
  onNavigate,
  badges,
}: {
  config: RoleConfig;
  onNavigate?: () => void;
  badges?: Record<string, { dot?: "green" | "blue" | "red"; live?: boolean; count?: number }>;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const t = useT();
  const translateNav = (label: string) => translateNavLabel(label, t);
  return (
    <nav className="flex flex-col gap-5 px-3 py-4" aria-label={`${config.label} navigation`}>
      {config.groups.map((group, gi) => (
        <div key={gi}>
          {group.label && (
            <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {group.label}
            </p>
          )}
          <ul className="space-y-1">
            {group.items.map((item) => {
              const active =
                item.to === config.home ? pathname === item.to : pathname.startsWith(item.to);
              const badge = badges?.[item.to];
              const isLive = Boolean(badge?.live);
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    preload={false}
                    onClick={(e) => {
                      onNavigate?.();
                      // Capacitor WebView: ensure route change even if Link is swallowed
                      try {
                        e.preventDefault();
                        appNavigate(item.to);
                      } catch {
                        /* Link default */
                      }
                    }}
                    className={cn(
                      "pressable relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
                      "active:scale-[0.98] active:bg-white/10",
                      active
                        ? "bg-blue-500/20 text-white"
                        : "text-slate-300 hover:bg-white/5 hover:text-white",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="relative shrink-0">
                      <item.icon
                        className={cn(
                          "h-4 w-4",
                          (item.to.includes("live-monitor") || item.to.includes("live-exams")) &&
                            !isLive &&
                            "text-white",
                          isLive && "animate-pulse text-emerald-400",
                        )}
                        aria-hidden
                      />
                    </span>
                    <span className="truncate">{translateNav(item.label)}</span>
                    {!isLive && badge?.count != null && badge.count > 0 ? (
                      <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-sky-500 px-1.5 text-[10px] font-bold text-white">
                        {badge.count > 99 ? "99+" : badge.count}
                      </span>
                    ) : !isLive && badge?.dot ? (
                      <span
                        className={cn(
                          "ml-auto h-2 w-2 shrink-0 rounded-full",
                          badge.dot === "green" && "bg-emerald-400",
                          badge.dot === "blue" && "bg-sky-400",
                          badge.dot === "red" && "bg-red-400",
                        )}
                        aria-hidden
                      />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function PortalBrand({
  isSchoolPortal,
  logoUrl,
  schoolName,
  homeTo,
}: {
  isSchoolPortal: boolean;
  logoUrl: string | null;
  schoolName: string | null;
  homeTo: string;
}) {
  if (isSchoolPortal) {
    return (
      <Link
        to={homeTo}
        preload={false}
        className="pressable flex min-w-0 items-center gap-2.5 active:scale-[0.98]"
        aria-label={schoolName || "School home"}
      >
        <SchoolLogo
          logoUrl={logoUrl}
          schoolName={schoolName}
          size="md"
          className="shrink-0 bg-transparent"
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-extrabold leading-tight text-white sm:text-base">
            {schoolName || "School"}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold text-slate-400">
            <img
              src="/logo.png"
              alt=""
              className="h-3.5 w-auto object-contain bg-transparent opacity-80"
            />
            Powered by D4EXAM
          </span>
        </span>
      </Link>
    );
  }
  return (
    <Link to="/" preload={false} aria-label="D4EXAM home" className="pressable min-w-0 active:scale-[0.98]">
      <Logo size="md" />
    </Link>
  );
}

function NotificationBell({ to, unread }: { to: string; unread: number }) {
  const hasUnread = unread > 0;
  const label = unread > 99 ? "99+" : unread > 0 ? String(unread) : undefined;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative h-11 w-11 shrink-0 rounded-full"
      aria-label={hasUnread ? `${unread} unread notifications` : "Notifications"}
      asChild
    >
      <Link to={to as string} preload={false} className="inline-flex h-11 w-11 items-center justify-center">
        <span className={cn("inline-flex items-center justify-center", hasUnread && "bell-ring")}>
          <Bell className="h-7 w-7 text-white/90" strokeWidth={2.25} aria-hidden />
        </span>
        {hasUnread ? (
          <span className="absolute right-0.5 top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold leading-none text-white shadow-sm">
            {label}
          </span>
        ) : null}
      </Link>
    </Button>
  );
}


const SCHOOL_BRAND_KEY = "d4exam_school_brand_v1";
function readSeededSchoolBrand(schoolId?: string | null): { name: string | null; logoUrl: string | null } {
  if (typeof window === "undefined" || !schoolId) return { name: null, logoUrl: null };
  try {
    const raw = window.localStorage.getItem(SCHOOL_BRAND_KEY);
    if (!raw) return { name: null, logoUrl: null };
    const parsed = JSON.parse(raw) as { id?: string; name?: string | null; logoUrl?: string | null };
    if (parsed?.id && String(parsed.id) === String(schoolId)) {
      return { name: parsed.name ?? null, logoUrl: parsed.logoUrl ?? null };
    }
  } catch { /* ignore */ }
  return { name: null, logoUrl: null };
}
function seedSchoolBrand(schoolId?: string | null, name?: string | null, logoUrl?: string | null) {
  if (typeof window === "undefined" || !schoolId) return;
  if (!name && !logoUrl) return;
  try {
    window.localStorage.setItem(SCHOOL_BRAND_KEY, JSON.stringify({ id: schoolId, name: name || null, logoUrl: logoUrl || null, ts: Date.now() }));
  } catch { /* ignore */ }
}

export function AppShell({
  config,
  user,
  children,
}: {
  config: RoleConfig;
  user: AppUser;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const immersiveMessaging =
    pathname.includes("/contact-officer") ||
    pathname.includes("/officer/reports") ||
    pathname.includes("/student/messages");
  const t = useT();
  const { data: session } = useSessionUser();
  const { data: school } = useSchoolIdentity(session?.schoolId);

  useRealtimeInvalidate(
    `shell-notifs-${session?.userId ?? "x"}`,
    session?.userId
      ? [{ table: "notifications", filter: `recipient_user_id=eq.${session.userId}` }]
      : [],
    [
      ["count", "notifications", "unread", session?.userId],
      ["rows", "notifications"],
      ["student-dashboard-notifs"],
    ],
    Boolean(session?.userId),
    400,
  );

  const unreadQ = useUnreadNotificationCount(session?.userId);
  const unreadCount = unreadQ.data ?? 0;

  // Nav activity indicators (live + pending)
  const liveMonQ = useQuery({
    queryKey: ["nav-live-monitor", session?.schoolId, session?.role],
    enabled: Boolean(session?.schoolId) && (
      session?.role === "examination_officer" ||
      session?.role === "school_admin" ||
      session?.role === "teacher"
    ),
    staleTime: 8_000,
    refetchInterval: 12_000,
    queryFn: async () => {
      const sid = session?.schoolId;
      if (!sid) return 0;
      const { count } = await supabase
        .from("exam_attempts")
        .select("id", { count: "exact", head: true })
        .eq("school_id", sid)
        .eq("status", "in_progress");
      return count ?? 0;
    },
  });
  const pendingApprovalQ = useQuery({
    queryKey: ["nav-pending-approvals", session?.schoolId, session?.role],
    enabled: Boolean(session?.schoolId) && (session?.role === "examination_officer" || session?.role === "school_admin"),
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: async () => {
      const sid = session?.schoolId;
      if (!sid) return 0;
      const { count } = await supabase
        .from("examinations")
        .select("id", { count: "exact", head: true })
        .eq("school_id", sid)
        .in("status", ["pending_approval", "changes_requested"]);
      return count ?? 0;
    },
  });

  const studentReportsQ = useQuery({
    queryKey: ["nav-student-reports-open", session?.schoolId, session?.role],
    enabled:
      Boolean(session?.schoolId) &&
      (session?.role === "examination_officer" || session?.role === "school_admin"),
    staleTime: 10_000,
    refetchInterval: 20_000,
    queryFn: async () => {
      const sid = session?.schoolId;
      if (!sid) return 0;
      const { data, error } = await supabase
        .from("student_officer_reports")
        .select("id, status")
        .eq("school_id", sid)
        .limit(150);
      if (error) {
        console.warn("[nav-student-reports]", error.message);
        return 0;
      }
      return (data ?? []).filter(
        (r) => String((r as { status?: string }).status || "open").toLowerCase() !== "replied",
      ).length;
    },
  });

  const navBadges = (() => {
    const b: Record<string, { dot?: "green" | "blue" | "red"; live?: boolean; count?: number }> = {};
    if ((liveMonQ.data ?? 0) > 0) {
      b["/officer/live-monitor"] = { live: true, dot: "green" };
      b["/teacher/live-exams"] = { live: true, dot: "green" };
    }
    if ((pendingApprovalQ.data ?? 0) > 0) {
      b["/officer/approvals"] = { dot: "blue", count: pendingApprovalQ.data ?? 0 };
    }
    const repN = studentReportsQ.data ?? 0;
    if (repN > 0) {
      b["/officer/reports"] = { dot: "blue", count: repN };
    }
    if (unreadCount > 0) {
      b[`${config.home}/notifications`] = { dot: "blue" };
      // also common paths
      b["/officer/notifications"] = { dot: "blue" };
      b["/admin/notifications"] = { dot: "blue" };
      b["/teacher/notifications"] = { dot: "blue" };
      b["/student/notifications"] = { dot: "blue" };
    }
    return b;
  })();
  const notifPath = `${config.home}/notifications`;
  const isSuperAdmin = session?.role === "super_admin";
  const isSchoolPortal = Boolean(session?.schoolId) && !isSuperAdmin;
  const seeded = isSchoolPortal ? readSeededSchoolBrand(session?.schoolId) : { name: null, logoUrl: null };
  const logoUrl = isSuperAdmin ? null : (school?.logoUrl ?? session?.schoolLogoUrl ?? seeded.logoUrl ?? null);
  const schoolName = isSuperAdmin ? null : (school?.name ?? session?.schoolName ?? seeded.name ?? null);
  if (isSchoolPortal && session?.schoolId && (schoolName || logoUrl)) {
    seedSchoolBrand(session.schoolId, schoolName, logoUrl);
  }
  const avatarLetters = user.avatar || initials(user.name || "U");
  const [navAvatarUrl, setNavAvatarUrl] = useState<string | null>(user.avatarUrl || null);
  useEffect(() => {
    setNavAvatarUrl(user.avatarUrl || null);
  }, [user.avatarUrl]);
  useEffect(() => {
    const uid = session?.userId;
    if (!uid) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("profile_photo_url")
          .eq("auth_user_id", uid)
          .maybeSingle();
        const url = (data as { profile_photo_url?: string | null } | null)?.profile_photo_url || null;
        if (!cancelled && url) setNavAvatarUrl(url);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [session?.userId]);
  const role = session?.role ?? null;

  return (
    <div className={cn("relative min-h-dvh overflow-x-hidden overflow-y-visible bg-slate-50", immersiveMessaging && "bg-white")}>
      <NetworkBanner />
      {!immersiveMessaging ? (
        <Watermark opacity={0.08} size="xl" className="pointer-events-none lg:left-64" />
      ) : null}

      <aside className={cn("sa-sidebar fixed inset-y-0 left-0 z-40 hidden h-dvh max-h-dvh w-64 flex-col bg-[#0b1b3a] lg:flex", immersiveMessaging && "!hidden")}>
        <div className="flex h-[4.5rem] shrink-0 items-center border-b border-white/10 px-4">
          <PortalBrand
            isSchoolPortal={isSchoolPortal}
            logoUrl={logoUrl}
            schoolName={schoolName}
            homeTo={config.home}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain hide-scrollbar">
          <NavLinks config={config} badges={navBadges} />
        </div>
        <div className="shrink-0 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
          <button
            type="button"
            onClick={() => void signOut()}
            className="pressable flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/15 hover:text-red-300 active:scale-[0.98]"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Logout
          </button>
        </div>
      </aside>

      <header
        className={cn(
          "d4-app-topbar fixed top-0 right-0 z-50 border-b border-white/10",
          "left-0 lg:left-64",
          "bg-[#0b1b3a] shadow-[0_4px_20px_rgba(11,27,58,0.35)]",
          "supports-[backdrop-filter]:bg-[#0b1b3a]/95 supports-[backdrop-filter]:backdrop-blur-md",
          immersiveMessaging && "!hidden",
        )}
        style={{ position: "fixed", paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="mx-auto grid h-12 max-w-[1400px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 sm:h-16 sm:gap-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <Sheet open={open} onOpenChange={setOpen} modal>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="sa-mobile-menu h-9 w-9 shrink-0 border-white/25 bg-white/5 text-white hover:bg-white/10 hover:text-white lg:hidden"
                  onClick={() => setOpen(true)}
                  aria-label="Open menu"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                hideClose
                className={cn(
                  "flex flex-col gap-0 border-r-0 bg-[#0b1b3a] p-0 text-white",
                  "!inset-y-0 !top-0 !bottom-0",
                  "!h-[100dvh] !min-h-[100dvh] !max-h-[100dvh]",
                  "w-[min(100vw-2rem,18rem)]",
                )}
              >
                <SheetTitle className="sr-only">{config.label} navigation</SheetTitle>
                <div className="flex min-h-16 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 sm:px-4 pt-[env(safe-area-inset-top,0px)]">
                  <div className="min-w-0 flex-1">
                    <PortalBrand
                      isSchoolPortal={isSchoolPortal}
                      logoUrl={logoUrl}
                      schoolName={schoolName}
                      homeTo={config.home}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close menu"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                  >
                    <X className="h-5 w-5" strokeWidth={2.25} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  <NavLinks config={config} onNavigate={() => setOpen(false)} badges={navBadges} />
                </div>
                <div className="mt-auto shrink-0 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      void signOut();
                    }}
                    className="pressable flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/15 hover:text-red-300 active:scale-[0.98]"
                  >
                    <LogOut className="h-4 w-4" aria-hidden />
                    Logout
                  </button>
                </div>
              </SheetContent>
            </Sheet>

            <span className="hidden text-sm font-bold tracking-tight text-white lg:inline">
              {config.label} Portal
            </span>

            <Link
              to={config.home}
              preload={false}
              className="pressable flex min-w-0 max-w-[min(100%,13.5rem)] items-center gap-1.5 active:scale-[0.98] sm:max-w-[18rem] md:max-w-[22rem] lg:hidden"
              aria-label={isSchoolPortal ? schoolName || "Home" : "D4EXAM home"}
            >
              {isSchoolPortal ? (
                <>
                  <SchoolLogo
                    logoUrl={logoUrl}
                    schoolName={schoolName}
                    size="sm"
                    className="shrink-0 bg-transparent"
                  />
                  <span className="truncate text-[15px] font-extrabold leading-none tracking-tight text-white sm:text-base">
                    {shortLabel(schoolName || "School", 28)}
                  </span>
                </>
              ) : (
                <Logo size="sm" />
              )}
            </Link>
          </div>

          <div className="flex min-w-0 justify-center px-1 sm:px-2">
            <div className="relative w-full max-w-xl">
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="flex h-9 w-full items-center gap-2 rounded-full border border-white/55 bg-white/10 px-3.5 text-left text-sm text-white transition hover:border-white hover:bg-white/15"
                aria-label="Open search"
              >
                <Search className="h-4 w-4 shrink-0 text-white" aria-hidden />
                <span className="truncate text-white/75">Search exams, materials, courses…</span>
              </button>
            </div>
          </div>

          <div className="flex items-center justify-end gap-0.5 sm:gap-2">
            <NotificationBell to={notifPath} unread={unreadCount} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="gap-2 px-1.5 text-white hover:bg-white/10 hover:text-white sm:px-2"
                  aria-label="Account menu"
                >
                  <span className="relative grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-white/15 text-[11px] font-semibold text-white ring-1 ring-white/25">
                    {navAvatarUrl ? (
                      <img src={navAvatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      avatarLetters.slice(0, 2)
                    )}
                  </span>
                  <span className="hidden max-w-[9rem] truncate text-left text-[15px] font-extrabold tracking-tight text-white sm:block">
                    {shortDisplayName(user.name, 16)}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="z-[70] w-[16.5rem] overflow-hidden rounded-xl border border-slate-200 bg-white p-0 shadow-lg"
              >
                <div className="border-b border-slate-100 bg-white px-3.5 py-3.5">
                  <div className="flex items-start gap-3">
                    <span className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-slate-800 text-xs font-semibold text-white">
                      {navAvatarUrl ? (
                        <img src={navAvatarUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        avatarLetters.slice(0, 2)
                      )}
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="truncate text-sm font-semibold leading-tight text-slate-900">
                        {shortDisplayName(user.name, 28)}
                      </p>
                      {user.subtitle ? (
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">{user.subtitle}</p>
                      ) : null}
                      <div className="mt-2">
                        <AccountRoleBadge role={role} />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="p-1">
                  <DropdownMenuItem asChild>
                    <Link
                      to={`${config.home}/profile` as never}
                      className="cursor-pointer rounded-lg px-2.5 py-2"
                    >
                      <UserRound className="mr-2.5 h-4 w-4 text-slate-500" />
                      <span className="text-sm font-medium text-slate-800">{translateNavLabel("Profile", t)}</span>
                      <ChevronRight className="ml-auto h-4 w-4 text-slate-300" aria-hidden />
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link
                      to={`${config.home}/settings` as never}
                      className="cursor-pointer rounded-lg px-2.5 py-2"
                    >
                      <Settings className="mr-2.5 h-4 w-4 text-slate-500" />
                      <span className="text-sm font-medium text-slate-800">{translateNavLabel("Settings", t)}</span>
                      <ChevronRight className="ml-auto h-4 w-4 text-slate-300" aria-hidden />
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="my-1" />
                  <DropdownMenuItem
                    className="cursor-pointer rounded-lg px-2.5 py-2 text-red-600 focus:bg-red-50 focus:text-red-700"
                    onClick={() => void signOut()}
                  >
                    <LogOut className="mr-2.5 h-4 w-4" />
                    <span className="text-sm font-medium">{translateNavLabel("Logout", t)}</span>
                  </DropdownMenuItem>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className={cn("sa-main relative z-10", !immersiveMessaging && "d4-shell-main-offset lg:pl-64")} style={immersiveMessaging ? { paddingTop: 0 } : { paddingTop: "calc(3rem + env(safe-area-inset-top, 0px))" }}>
        <main className={cn(
            immersiveMessaging
              ? "mx-auto h-dvh w-full max-w-none p-0"
              : "mx-auto w-full max-w-[1200px] px-3 pb-28 pt-4 sm:px-6 sm:pt-6 lg:max-w-[1400px] lg:px-8 lg:pb-12 lg:pt-8 xl:max-w-[1480px]",
          )}>
          <div className={cn("min-w-0 w-full", immersiveMessaging ? "h-full" : "overflow-visible")}>{children}</div>
        </main>
      </div>

      {/* bottom nav hidden in sa-desktop-view via CSS */}
      {config.bottomNav && !immersiveMessaging && (
        <nav
          className={cn(
            "sa-bottom-nav d4-app-bottom-nav fixed inset-x-0 bottom-0 z-40 lg:hidden",
            "border-t border-white/10 bg-[#0b1b3a]",
            "pb-[env(safe-area-inset-bottom,0px)]",
            "shadow-[0_-4px_16px_rgba(11,27,58,0.35)]",
          )}
          aria-label="Primary"
        >
          <ul className="grid h-14 grid-cols-4">
            {config.bottomNav.map((item) => {
              const active =
                item.to === config.home
                  ? pathname === item.to || pathname === `${item.to}/`
                  : pathname === item.to || pathname.startsWith(`${item.to}/`);
              const badge = navBadges[item.to];
              const isLive = Boolean(badge?.live);
              const isMonitor =
                item.to.includes("live-monitor") || item.to.includes("live-exams");
              return (
                <li key={item.to} className="flex">
                  <Link
                    to={item.to}
                    preload={false}
                    className={cn(
                      "pressable relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition-colors",
                      active ? "text-white" : "text-slate-400 hover:text-white",
                      isMonitor && !isLive && "text-white",
                      isLive && "text-emerald-400",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="relative">
                      <item.icon
                        className={cn(
                          "h-5 w-5",
                          isMonitor && !isLive && "text-white",
                          isLive && "animate-pulse text-emerald-400",
                        )}
                        aria-hidden
                      />
                      {!isLive && badge?.dot ? (
                        <span
                          className={cn(
                            "absolute -right-1 -top-0.5 h-2 w-2 rounded-full",
                            badge.dot === "green" && "bg-emerald-400",
                            badge.dot === "blue" && "bg-sky-400",
                            badge.dot === "red" && "bg-red-400",
                          )}
                        />
                      ) : null}
                    </span>
                    <span className="truncate px-1">{translateNavLabel(item.label, t)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      <GlobalSearchPage open={searchOpen} onClose={() => setSearchOpen(false)} />
      <InstallAndPushPrompt />
    </div>
  );
}
