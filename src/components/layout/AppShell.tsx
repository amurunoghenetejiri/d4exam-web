import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  Bell,
  Building2,
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
import { LiteDrawer, useTapThrottle } from "@/components/ui/lite-drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, shortDisplayName } from "@/lib/utils";
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

const NAV_I18N: Record<string, string> = {
  Dashboard: "nav.dashboard",
  Home: "nav.home",
  "My Exams": "nav.myExams",
  Exams: "nav.exams",
  Results: "nav.results",
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
          {group.label ? (
            <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {group.label}
            </p>
          ) : null}
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
            <img src="/logo.png" alt="" className="h-3.5 w-auto object-contain opacity-80" />
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
  } catch {
    /* ignore */
  }
  return { name: null, logoUrl: null };
}
function seedSchoolBrand(schoolId?: string | null, name?: string | null, logoUrl?: string | null) {
  if (typeof window === "undefined" || !schoolId) return;
  if (!name && !logoUrl) return;
  try {
    window.localStorage.setItem(
      SCHOOL_BRAND_KEY,
      JSON.stringify({ id: schoolId, name: name || null, logoUrl: logoUrl || null, ts: Date.now() }),
    );
  } catch {
    /* ignore */
  }
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
  const tapThrottle = useTapThrottle(350);
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

  const liveMonQ = useQuery({
    queryKey: ["nav-live-monitor", session?.schoolId, session?.role],
    enabled:
      Boolean(session?.schoolId) &&
      (session?.role === "examination_officer" ||
        session?.role === "school_admin" ||
        session?.role === "teacher"),
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
    enabled:
      Boolean(session?.schoolId) &&
      (session?.role === "examination_officer" || session?.role === "school_admin"),
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
      if (error) return 0;
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
    if (repN > 0) b["/officer/reports"] = { dot: "blue", count: repN };
    if (unreadCount > 0) {
      b[`${config.home}/notifications`] = { dot: "blue" };
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
  const logoUrl = isSuperAdmin
    ? null
    : (school?.logoUrl ?? session?.schoolLogoUrl ?? seeded.logoUrl ?? null);
  const schoolName = isSuperAdmin
    ? null
    : (school?.name ?? session?.schoolName ?? seeded.name ?? null);
  if (isSchoolPortal && session?.schoolId && (schoolName || logoUrl)) {
    seedSchoolBrand(session.schoolId, schoolName, logoUrl);
  }
  const avatarLetters = user.avatar || initials(user.name || "U");
  const role = session?.role ?? null;
  const { label: roleLabel, icon: RoleIcon } = roleMeta(role);

  return (
    <div
      className={cn(
        "relative min-h-dvh overflow-x-hidden overflow-y-visible bg-slate-50",
        immersiveMessaging && "bg-white",
      )}
    >
      <NetworkBanner />
      {!immersiveMessaging ? (
        <Watermark opacity={0.08} size="xl" className="pointer-events-none lg:left-64" />
      ) : null}

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "sa-sidebar fixed inset-y-0 left-0 z-40 hidden h-dvh max-h-dvh w-64 flex-col bg-[#0b1b3a] lg:flex",
          immersiveMessaging && "!hidden",
        )}
      >
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

      {/* Top bar */}
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
        <div className="mx-auto flex h-12 max-w-[1400px] items-center gap-2 px-2.5 sm:h-16 sm:gap-3 sm:px-6 lg:px-8">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="sa-mobile-menu h-9 w-9 shrink-0 border-white/25 bg-white/5 text-white hover:bg-white/10 lg:hidden"
            onClick={() => tapThrottle(() => setOpen(true))}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </Button>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2 lg:hidden">
              {isSchoolPortal ? (
                <>
                  <SchoolLogo
                    logoUrl={logoUrl}
                    schoolName={schoolName}
                    size="sm"
                    className="shrink-0 bg-transparent"
                  />
                  <span className="truncate text-sm font-extrabold text-white">
                    {schoolName || "School"}
                  </span>
                </>
              ) : (
                <Logo size="sm" />
              )}
            </div>
            <div className="hidden min-w-0 lg:block">
              <p className="truncate text-sm font-bold text-white">
                {isSchoolPortal ? schoolName || config.label : config.label}
              </p>
              <p className="truncate text-xs text-slate-400">{user.subtitle}</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 text-white/90"
              onClick={() => setSearchOpen(true)}
              aria-label="Search"
            >
              <Search className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" className="relative h-10 w-10 text-white/90" asChild>
              <Link to={notifPath as string} preload={false}>
                <Bell className={cn("h-5 w-5", unreadCount > 0 && "bell-ring")} />
                {unreadCount > 0 ? (
                  <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                ) : null}
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" className="h-10 gap-2 rounded-full px-2 text-white">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-xs font-bold">
                    {avatarLetters}
                  </span>
                  <span className="hidden max-w-[8rem] truncate text-sm sm:inline">
                    {shortDisplayName(user.name)}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <div className="px-2 py-1.5">
                  <p className="truncate text-sm font-semibold">{user.name}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500">
                    <RoleIcon className="h-3 w-3" /> {roleLabel}
                  </p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => appNavigate(`${config.home}/profile`)}>
                  <UserRound className="mr-2 h-4 w-4" /> Profile
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => appNavigate(`${config.home}/settings`)}>
                  <Settings className="mr-2 h-4 w-4" /> Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-600" onClick={() => void signOut()}>
                  <LogOut className="mr-2 h-4 w-4" /> Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      <LiteDrawer
        open={open}
        onClose={() => setOpen(false)}
        side="left"
        label={`${config.label} navigation`}
        className="w-[min(100vw-2rem,18rem)] bg-[#0b1b3a] text-white lg:hidden"
      >
        <div className="flex min-h-16 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 pt-[env(safe-area-inset-top,0px)]">
          <PortalBrand
            isSchoolPortal={isSchoolPortal}
            logoUrl={logoUrl}
            schoolName={schoolName}
            homeTo={config.home}
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="grid h-9 w-9 place-items-center rounded-full text-white/90 hover:bg-white/10"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <NavLinks config={config} onNavigate={() => setOpen(false)} badges={navBadges} />
        </div>
        <div className="shrink-0 border-t border-white/10 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="pressable flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-red-400"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Logout
          </button>
        </div>
      </LiteDrawer>

      <main
        className={cn(
          "relative z-0 min-h-dvh",
          immersiveMessaging
            ? "pt-0 lg:pl-0"
            : cn(
                "pt-[calc(3rem+env(safe-area-inset-top,0px))] sm:pt-[calc(4rem+env(safe-area-inset-top,0px))] lg:pl-64",
                config.bottomNav && "pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))] lg:pb-0",
              ),
        )}
      >
        {children}
      </main>

      {/* Bottom nav (mobile) — same as website */}
      {config.bottomNav && !immersiveMessaging ? (
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
                    onClick={(e) => {
                      try {
                        e.preventDefault();
                        appNavigate(item.to);
                      } catch {
                        /* */
                      }
                    }}
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
                      {isLive ? (
                        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-[#0b1b3a]" />
                      ) : null}
                      {!isLive && badge?.count != null && badge.count > 0 ? (
                        <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-0.5 text-[9px] font-bold text-white">
                          {badge.count > 9 ? "9+" : badge.count}
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate px-0.5">{translateNavLabel(item.label, t)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      <GlobalSearchPage open={searchOpen} onClose={() => setSearchOpen(false)} />
      <InstallAndPushPrompt />
    </div>
  );
}
