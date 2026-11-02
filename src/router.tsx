import { QueryClient } from "@tanstack/react-query";
import { createRouter, createHashHistory, createBrowserHistory } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { isOnlineNow } from "@/lib/offline-sync";
import { bindAppRouter } from "@/lib/app-navigate";

function isApkShell(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    const ua = navigator.userAgent || "";
    const d4 = (window as unknown as { D4Android?: unknown; __D4_NATIVE__?: boolean });
    return (
      Boolean(d4.__D4_NATIVE__ || d4.D4Android) ||
      Boolean(cap?.isNativePlatform?.()) ||
      (ua.includes("; wv)") && /Android/i.test(ua)) ||
      /Capacitor/i.test(ua)
    );
  } catch {
    return false;
  }
}

/** Route transition loader — compact, never full navy D4EXAM splash. */
function DefaultPending() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[35vh] flex-col items-center justify-center gap-3 bg-transparent px-6 py-10"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-[#2563eb]" />
      <p className="text-sm font-medium text-slate-500">Loading…</p>
    </div>
  );
}

function recoverAppShell() {
  try {
    // Prefer last known in-app path (set by NativeBootstrap / rememberLastPath)
    const last =
      (typeof sessionStorage !== "undefined" && sessionStorage.getItem("d4_last_path")) ||
      (typeof localStorage !== "undefined" && localStorage.getItem("d4_last_path")) ||
      "/";
    const path = last.startsWith("/") ? last : `/${last}`;
    // Hash history on native APK; path history on web
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    const ua = navigator.userAgent || "";
    const native =
      Boolean(cap?.isNativePlatform?.()) ||
      (ua.includes("; wv)") && /Android/i.test(ua)) ||
      /Capacitor/i.test(ua);
    if (native) {
      window.location.hash = path.startsWith("#") ? path : `#${path}`;
      window.location.reload();
      return;
    }
    window.location.assign(path);
  } catch {
    try {
      window.location.reload();
    } catch {
      /* ignore */
    }
  }
}

function DefaultError({ error }: { error: Error }) {
  const msg = String(error?.message ?? "").toLowerCase();
  // Only show the hard offline wall when the device reports offline.
  // Transient fetch failures after app-lock unlock must NOT block the real app UI.
  const deviceOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  const networkMsg =
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("load failed") ||
    msg.includes("net::");
  const hardOffline = deviceOffline && (networkMsg || !isOnlineNow());

  if (hardOffline) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#0a1a3a] px-6 py-16 text-center">
        <div className="relative mb-7 grid h-[140px] w-[140px] place-items-center" aria-hidden>
          <span className="absolute left-2.5 top-2.5 h-[120px] w-[120px] rounded-full bg-blue-600/20" />
          <span className="absolute right-1.5 top-2 h-9 w-9 rounded-full bg-blue-500/25" />
          <span className="absolute right-0 top-10 h-4.5 w-4.5 rounded-full bg-blue-400/30" />
          <div className="relative z-10 grid h-24 w-24 place-items-center rounded-full bg-gradient-to-b from-[#1e3a6e] to-[#152a52] shadow-xl">
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none">
              <path d="M5.07 11.05a9 9 0 0 1 13.86 0" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" />
              <path d="M8.53 14.11a5 5 0 0 1 6.95 0" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" />
              <circle cx="12" cy="18" r="1.35" fill="#93c5fd" />
              <path d="M4.5 5.5 L19.5 18.5" stroke="#ef4444" strokeWidth="2.25" strokeLinecap="round" />
            </svg>
          </div>
        </div>
        <h1 className="mb-3 text-2xl font-bold tracking-tight text-white">
          You're <span className="text-blue-500">Offline</span>
        </h1>
        <p className="mb-7 max-w-xs text-[0.95rem] leading-relaxed text-slate-400">
          It looks like you're not connected to the internet.
          Please check your network connection and try again.
        </p>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-7 py-3.5 text-[0.95rem] font-semibold text-white shadow-lg shadow-blue-600/35 transition active:scale-[0.98] active:bg-blue-700"
          onClick={() => recoverAppShell()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M21 12a9 9 0 1 1-2.6-6.3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M21 4v5h-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Try Again
        </button>
        <div className="mt-9 flex max-w-[16rem] flex-col items-center gap-2 text-slate-500">
          <p className="text-xs leading-relaxed">
            D4EXAM will reconnect automatically
            <br />
            once you're back online.
          </p>
        </div>
      </div>
    );
  }

  // Soft recovery for post-lock / transient errors — get user back into the app
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-xl font-bold text-slate-500">
        D4
      </div>
      <h1 className="text-lg font-semibold text-slate-900">This page didn't load</h1>
      <p className="text-sm text-slate-500">
        Something went wrong. Try again or go back to your dashboard.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
          onClick={() => recoverAppShell()}
        >
          Try again
        </button>
        <button
          type="button"
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800"
          onClick={() => {
            try {
              window.location.hash = "#/";
              window.location.reload();
            } catch {
              window.location.assign("/");
            }
          }}
        >
          Go home
        </button>
      </div>
    </div>
  );
}

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        refetchOnMount: true,
        retry: (failureCount, error) => {
          if (typeof navigator !== "undefined" && !navigator.onLine) return false;
          const m = String((error as Error)?.message ?? "").toLowerCase();
          if (m.includes("failed to fetch") || m.includes("network")) return failureCount < 1;
          return failureCount < 1;
        },
        retryDelay: 400,
        networkMode: "offlineFirst",
        throwOnError: false,
      },
      mutations: {
        retry: 0,
        networkMode: "online",
      },
    },
  });

  // Android Capacitor APK always uses hash history (local bundled shell at localhost).
  // Public website in Chrome keeps path history (browser history default).
  let history: ReturnType<typeof createBrowserHistory> | ReturnType<typeof createHashHistory> | undefined;
  try {
    if (typeof window !== "undefined") {
      const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
      const ua = navigator.userAgent || "";
      const host = (window.location.hostname || "").toLowerCase();
      const native =
        Boolean(cap?.isNativePlatform?.()) ||
        (ua.includes("; wv)") && /Android/i.test(ua)) ||
        /Capacitor/i.test(ua);
      const localHost =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "" ||
        window.location.protocol === "file:";
      // Never use remote website hostname inside APK; always hash for native/local.
      if (native || localHost) {
        history = createHashHistory();
      }
    }
  } catch {
    /* default history for pure web */
  }

  const router = createRouter({
    routeTree,
    context: { queryClient },
    history,
    scrollRestoration: true,
    defaultPreloadStaleTime: 5 * 60_000,
    defaultPreload: "intent",
    defaultPendingMs: 0,
    defaultPendingMinMs: 120,
    defaultPendingComponent: DefaultPending,
    defaultErrorComponent: DefaultError as never,
  });

  try {
    bindAppRouter(router as never);
  } catch {
    /* ignore */
  }

  return router;
};
