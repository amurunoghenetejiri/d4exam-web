import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Monitor } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import {
  adminNav,
  officerNav,
  studentNav,
  superAdminNav,
  teacherNav,
} from "@/components/navigation/navConfig";
import type { RoleConfig } from "@/components/navigation/navConfig";
import { initials, useSessionUser } from "@/lib/session";

function RoleShell({ config, children }: { config: RoleConfig; children: ReactNode }) {
  const { data: user } = useSessionUser();

  return (
    <AppShell
      config={config}
      user={{
        name: user?.fullName ?? "…",
        avatar: initials(user?.fullName ?? ""),
        subtitle: user?.identifier ?? user?.schoolName ?? "",
      }}
    >
      {children}
    </AppShell>
  );
}

/** CBT exam must be distraction-free: no sidebar, top bar, or bottom nav. */
export function StudentLayout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash =
    typeof window !== "undefined" ? (window.location.hash || "").replace(/^#/, "") : "";
  const pathForCheck = hash.startsWith("/") ? hash : pathname;
  const isExamMode = pathForCheck.startsWith("/student/exam/");
  // Full-screen profile (own or peer) — no school top bar / bottom nav
  const isUserProfile =
    pathForCheck.includes("/student/user/") ||
    pathForCheck.endsWith("/student/user") ||
    pathForCheck.includes("/user/");

  if (isExamMode || isUserProfile) {
    return <>{children}</>;
  }

  return <RoleShell config={studentNav}>{children}</RoleShell>;
}

export function TeacherLayout({ children }: { children: ReactNode }) {
  return <RoleShell config={teacherNav}>{children}</RoleShell>;
}

export function AdminLayout({ children }: { children: ReactNode }) {
  return <RoleShell config={adminNav}>{children}</RoleShell>;
}

export function OfficerLayout({ children }: { children: ReactNode }) {
  return <RoleShell config={officerNav}>{children}</RoleShell>;
}

export function SuperAdminLayout({ children }: { children: ReactNode }) {
  return (
    <RoleShell config={superAdminNav}>
      <SuperAdminDesktopShell>{children}</SuperAdminDesktopShell>
    </RoleShell>
  );
}


function DesktopScaledFrame({
  children,
  scale,
  desktopWidth,
}: {
  children: ReactNode;
  scale: number;
  desktopWidth: number;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => {
      setHeight(el.scrollHeight * scale);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [scale, children]);

  return (
    <div
      className="relative w-full overflow-x-hidden"
      style={{ height: height ?? "auto", maxWidth: "100vw" }}
    >
      <div
        ref={innerRef}
        style={{
          width: desktopWidth,
          maxWidth: desktopWidth,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Super Admin only: desktop layout on a phone without horizontal zoom.
 * Renders the desktop shell at 1100px logical width, then CSS-scales it
 * down to fit the device width (Chrome-like "desktop site", fit-to-screen).
 */
function SuperAdminDesktopShell({ children }: { children: ReactNode }) {
  const [desktop, setDesktop] = useState(false);
  const [scale, setScale] = useState(1);
  const DESKTOP_W = 1024;

  useEffect(() => {
    try {
      if (localStorage.getItem("d4_sa_desktop_view") === "1") setDesktop(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("d4_sa_desktop_view", desktop ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (desktop) {
      root.classList.add("sa-desktop-view");
      root.style.overflowX = "hidden";
      document.body.style.overflowX = "hidden";
    } else {
      root.classList.remove("sa-desktop-view");
      root.style.overflowX = "";
      document.body.style.overflowX = "";
    }
    return () => {
      root.classList.remove("sa-desktop-view");
      root.style.overflowX = "";
      document.body.style.overflowX = "";
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) {
      setScale(1);
      return;
    }
    const update = () => {
      const w = typeof window !== "undefined" ? window.innerWidth : DESKTOP_W;
      // Fit full desktop layout into the phone width (never larger than 1)
      setScale(Math.min(1, Math.max(0.35, w / DESKTOP_W)));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [desktop]);

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setDesktop((v) => !v)}
        title={desktop ? "Switch to mobile view" : "Switch to desktop view"}
        aria-pressed={desktop}
        className={`fixed bottom-20 right-3 z-[70] inline-flex h-11 w-11 items-center justify-center rounded-full border shadow-lg transition md:bottom-6 md:right-6 ${desktop ? "border-primary bg-primary text-white hover:bg-primary/90" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
      >
        <Monitor className="h-5 w-5" aria-hidden />
        <span className="sr-only">{desktop ? "Mobile view" : "Desktop view"}</span>
      </button>
      {desktop ? (
        <DesktopScaledFrame scale={scale} desktopWidth={DESKTOP_W}>
          {children}
        </DesktopScaledFrame>
      ) : (
        children
      )}
    </div>
  );
}
