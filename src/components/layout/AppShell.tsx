import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
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
import { LiteDrawer, useTapThrottle } from "@/components/ui/lite-drawer";
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
  subtitle: string;
}

/** Temporary stub while full AppShell is restored — re-export path kept. */
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
  const unreadQ = useUnreadNotificationCount(session?.userId);
  const unreadCount = unreadQ.data ?? 0;
  const isSuperAdmin = session?.role === "super_admin";
  const isSchoolPortal = Boolean(session?.schoolId) && !isSuperAdmin;
  const logoUrl = isSuperAdmin ? null : (school?.logoUrl ?? session?.schoolLogoUrl ?? null);
  const schoolName = isSuperAdmin ? null : (school?.name ?? session?.schoolName ?? null);
  const avatarLetters = user.avatar || initials(user.name || "U");
  const role = session?.role ?? null;
  const notifPath = `${config.home}/notifications`;

  return (
    <div className={cn("relative min-h-dvh overflow-x-hidden overflow-y-visible bg-slate-50", immersiveMessaging && "bg-white")}>
      <NetworkBanner />
      {!immersiveMessaging ? (
        <Watermark opacity={0.08} size="xl" className="pointer-events-none lg:left-64" />
      ) : null}

      <aside className={cn("sa-sidebar fixed inset-y-0 left-0 z-40 hidden h-dvh max-h-dvh w-64 flex-col bg-[#0b1b3a] lg:flex", immersiveMessaging && "!hidden")}>
        <div className="flex h-[4.5rem] shrink-0 items-center border-b border-white/10 px-4">
          <Link to={config.home} preload={false} className="pressable flex min-w-0 items-center gap-2.5">
            {isSchoolPortal ? (
              <SchoolLogo logoUrl={logoUrl} schoolName={schoolName} size="md" className="shrink-0 bg-transparent" />
            ) : (
              <Logo size="md" />
            )}
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain hide-scrollbar px-3 py-4">
          <nav className="flex flex-col gap-1" aria-label={`${config.label} navigation`}>
            {config.groups.flatMap((g) =>
              g.items.map((item) => (
                <Link
                  key={item.to}
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
                  className="pressable flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-300 hover:bg-white/5 hover:text-white"
                >
                  <item.icon className="h-4 w-4" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </Link>
              )),
            )}
          </nav>
        </div>
        <div className="shrink-0 border-t border-white/10 p-3">
          <button type="button" onClick={() => void signOut()} className="pressable flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-red-400">
            <LogOut className="h-4 w-4" aria-hidden />
            Logout
          </button>
        </div>
      </aside>

      <header
        className={cn(
          "d4-app-topbar fixed top-0 right-0 z-50 border-b border-white/10 left-0 lg:left-64 bg-[#0b1b3a]",
          immersiveMessaging && "!hidden",
        )}
        style={{ position: "fixed", paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="mx-auto flex h-12 max-w-[1400px] items-center gap-2 px-2.5 sm:h-16 sm:px-6">
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
          <LiteDrawer
            open={open}
            onClose={() => setOpen(false)}
            side="left"
            label={`${config.label} navigation`}
            className="w-[min(100vw-2rem,18rem)] bg-[#0b1b3a] text-white lg:hidden"
          >
            <div className="flex min-h-16 shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 pt-[env(safe-area-inset-top,0px)]">
              <span className="truncate text-sm font-bold text-white">{schoolName || "D4EXAM"}</span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="grid h-9 w-9 place-items-center rounded-full text-white/90 hover:bg-white/10">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4">
              <nav className="flex flex-col gap-1">
                {config.groups.flatMap((g) =>
                  g.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      preload={false}
                      onClick={(e) => {
                        setOpen(false);
                        try {
                          e.preventDefault();
                          appNavigate(item.to);
                        } catch {
                          /* */
                        }
                      }}
                      className="pressable flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-300 hover:bg-white/5 hover:text-white"
                    >
                      <item.icon className="h-4 w-4" aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  )),
                )}
              </nav>
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
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-white" onClick={() => setSearchOpen(true)} aria-label="Search">
              <Search className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" className="relative h-9 w-9 text-white" asChild>
              <Link to={notifPath as string} preload={false}>
                <Bell className="h-5 w-5" />
                {unreadCount > 0 ? (
                  <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                ) : null}
              </Link>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" className="h-9 gap-2 rounded-full px-2 text-white">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15 text-xs font-bold">{avatarLetters}</span>
                  <span className="hidden max-w-[8rem] truncate text-sm sm:inline">{shortDisplayName(user.name)}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
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

      <main
        className={cn(
          "relative z-0 min-h-dvh",
          immersiveMessaging ? "pt-0 lg:pl-0" : "pt-[calc(3rem+env(safe-area-inset-top,0px))] sm:pt-[calc(4rem+env(safe-area-inset-top,0px))] lg:pl-64",
        )}
      >
        {children}
      </main>

      <GlobalSearchPage open={searchOpen} onClose={() => setSearchOpen(false)} />
      <InstallAndPushPrompt />
    </div>
  );
}
