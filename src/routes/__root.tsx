// @ts-nocheck
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";
import { ThemeColorSync } from "@/components/ThemeColorSync";
import { OfflineBootstrap } from "@/components/OfflineBootstrap";
import { LocalDbBootstrap } from "@/components/LocalDbBootstrap";
import { OfflineStatusPill } from "@/components/OfflineStatusPill";
import { NotificationLiveListener } from "@/components/NotificationLiveListener";
import { GlobalCallHost } from "@/components/calls/GlobalCallHost";
import { NotificationPermissionPrompt } from "@/components/NotificationPermissionPrompt";
import { hideSplashSafely } from "@/native/statusBar";
import { AppUpdateGate } from "@/components/AppUpdateGate";
import { FingerprintLockGate } from "@/components/security/FingerprintLockGate";
import { AppUnlockSetupGate } from "@/components/security/AppUnlockSetupGate";
import { AndroidApkInstallBanner } from "@/components/AndroidApkInstallBanner";
import { useSessionUser, rememberLastPath, readLastRole, readPreferredRole, roleHome, roleFromPath, type AppRole } from "@/lib/session";
import { initNativePushIfNeeded, initWebPushIfNeeded } from "@/lib/push";
import { isNativeShell } from "@/native/platform";
import { applyNativeStatusBar } from "@/native/statusBar";
import { registerAndroidBackButton } from "@/native/backButton";
import { AnimatedSplash } from "@/components/splash/AnimatedSplash";
import { DisplayPrefsBootstrap } from "@/components/DisplayPrefsBootstrap";
import { SchoolSessionBootstrap } from "@/components/SchoolSessionBootstrap";
import { startAccountVaultKeepAlive } from "@/lib/account-switcher";
import { notifyWelcomeRole } from "@/lib/email-notify.functions";
import { isSyntheticStudentEmail } from "@/lib/student-email";
import { startNativeShellWatcher } from "@/native/platform";
import { forceUnlockBody, installUnlockWatchdog } from "@/lib/unlock-ui";

if (typeof window !== "undefined") {
  startNativeShellWatcher();
}

function NativeBootstrap() {
  const { data: session } = useSessionUser();
  const router = useRouter();
  const pathForPersist = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    if (!pathForPersist) return;
    rememberLastPath(pathForPersist, session?.role ?? roleFromPath(pathForPersist));
  }, [pathForPersist, session?.role]);
  useEffect(() => {
    if (pathForPersist !== "/") return;
    const role = (readLastRole() || readPreferredRole() || session?.role) as AppRole | null;
    if (role && roleHome[role]) {
      void router.navigate({ to: roleHome[role] as never, replace: true });
    }
  }, [pathForPersist, session?.role, router]);
  useEffect(() => {
    if (!isNativeShell()) return;
    let cancelled = false;
    (async () => {
      try {
        document.documentElement.classList.add("d4-native");
        await applyNativeStatusBar();
        const unsubBack = await registerAndroidBackButton();
        if (cancelled) {
          unsubBack();
          return;
        }
        (window as unknown as { __d4UnsubBack?: () => void }).__d4UnsubBack = unsubBack;
        if (!cancelled && session?.userId) {
          window.setTimeout(() => {
            void initNativePushIfNeeded(session.userId, session.role);
          }, 2500);
        }
      } catch (e) {
        console.warn("[D4EXAM] Native bootstrap error", e);
      }
    })();
    return () => {
      cancelled = true;
      try {
        (window as unknown as { __d4UnsubBack?: () => void }).__d4UnsubBack?.();
      } catch {
        /* ignore */
      }
    };
  }, [session?.userId, session?.role]);
  return null;
}

function WebPushBootstrap() {
  const { data: session } = useSessionUser();
  useEffect(() => {
    if (!session?.userId) return;
    try {
      const key = `d4_welcome_email_sent_${session.userId}`;
      if (typeof localStorage !== "undefined" && !localStorage.getItem(key)) {
        const em = (session.email || "").trim();
        if (em.includes("@") && !isSyntheticStudentEmail(em)) {
          localStorage.setItem(key, "1");
          void notifyWelcomeRole({
            data: {
              email: em,
              fullName: session.fullName || undefined,
              role: session.role || "student",
            },
          });
        }
      }
    } catch { /* ignore */ }
    if (isNativeShell()) return;
    void initWebPushIfNeeded(session.userId, session.role);
            void import("@/lib/push").then((m) => m.enablePushNotifications(session.userId, session.role, { requestPermission: false })).catch(() => null);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void initWebPushIfNeeded(session.userId, session.role);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [session?.userId, session?.role]);
  return null;
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">The page you're looking for doesn't exist or has been moved.</p>
        <div className="mt-6">
          <Link to="/" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Go home</Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">Don't worry — D4EXAM is still running. You can try again or head back home.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button onClick={() => { router.invalidate(); reset(); }} className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Try Again</button>
          <a href="/" className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground">Go Home</a>
          <button type="button" onClick={() => { try { window.location.reload(); } catch { window.location.href = "/"; } }} className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground">Reload App</button>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" },
      { title: "D4EXAM — Secure Online Examination Platform" },
      { name: "description", content: "D4EXAM is a professional CBT and examination management platform for schools, colleges and universities." },
      { name: "theme-color", content: "#ffffff" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent as never,
});

function RootShell({ children }: { children: ReactNode }) {
  // Phone app (client-only bundle): never render a second <html>/<body> inside #root
  if (typeof window !== "undefined" && (window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA) {
    return <>{children}</>;
  }
  return (
    <html lang="en" style={{ backgroundColor: "#0b1b3a" }}>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh text-foreground antialiased" style={{ backgroundColor: "#ffffff" }}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function installGlobalErrorHandlers() {
  if (typeof window === "undefined") return;
  const w = window as Window & { __d4GlobalHandlers?: boolean };
  if (w.__d4GlobalHandlers) return;
  w.__d4GlobalHandlers = true;
  window.addEventListener("unhandledrejection", (ev) => {
    console.warn("[D4EXAM] unhandledrejection", ev.reason);
    ev.preventDefault?.();
  });
  window.addEventListener("error", (ev) => {
    console.warn("[D4EXAM] window error", ev.message);
  });
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const unlockPath = useRouterState({ select: (s) => s.location.pathname });
  // Freeze guard: release stuck overlay locks after every page change
  useEffect(() => {
    forceUnlockBody();
    const t1 = window.setTimeout(forceUnlockBody, 120);
    const t2 = window.setTimeout(forceUnlockBody, 450);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [unlockPath]);
  useEffect(() => installUnlockWatchdog(), []);
  useEffect(() => {
    installGlobalErrorHandlers();
    startAccountVaultKeepAlive();
    const native = isNativeShell();
    if (!native) {
      void hideSplashSafely();
      try {
        window.dispatchEvent(new Event("d4-hide-boot-splash"));
      } catch { /* ignore */ }
    }
    try {
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
      document.body.classList.remove("d4-fp-lock-active", "d4-setup-lock-active");
      document.body.style.pointerEvents = "";
      document.documentElement.style.pointerEvents = "";
    } catch { /* ignore */ }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeColorSync />
      <LocalDbBootstrap />
      <OfflineBootstrap />
      <OfflineStatusPill />
      <NotificationLiveListener />
      <GlobalCallHost />
      <NotificationPermissionPrompt />
      <AppUpdateGate />
      <AppUnlockSetupGate />
      <FingerprintLockGate />
      <AndroidApkInstallBanner />
      <Outlet />
      <NativeBootstrap />
      <WebPushBootstrap />
      <SchoolSessionBootstrap />
      <DisplayPrefsBootstrap />
      <AnimatedSplash />
      <Toaster />
    </QueryClientProvider>
  );
}
