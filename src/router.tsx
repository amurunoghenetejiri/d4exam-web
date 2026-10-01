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
    return (
      Boolean(cap?.isNativePlatform?.()) ||
      (/; wv\)/i.test(ua) && /Android/i.test(ua)) ||
      /Capacitor/i.test(ua)
    );
  } catch {
    return false;
  }
}

/** APK: navy + animated D4EXAM text. Website: keep light spinner. */
function DefaultPending() {
  if (isApkShell()) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#0b1b3a] px-6 py-16">
        <p
          className="select-none text-2xl font-extrabold tracking-[0.2em] text-white"
          style={{
            background: "linear-gradient(90deg, #94a3b8 0%, #ffffff 40%, #60a5fa 50%, #ffffff 60%, #94a3b8 100%)",
            backgroundSize: "200% 100%",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            animation: "d4LoadShine 2.2s ease-in-out infinite",
          }}
        >
          D4EXAM
        </p>
        <p className="mt-3 text-[10px] font-semibold tracking-[0.28em] text-slate-500">
          SMART. SECURE. SEAMLESS.
        </p>
        <style>{`@keyframes d4LoadShine { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }`}</style>
      </div>
    );
  }
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 bg-white py-12">
      <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-slate-200 border-t-blue-600" />
      <p className="text-sm font-medium text-slate-500">Loading…</p>
    </div>
  );
}

function recoverAppShell() {
  try {
    const last =
      (typeof sessionStorage !== "undefined" && sessionStorage.getItem("d4_last_path")) ||
      (typeof localStorage !== "undefined" && localStorage.getItem("d4_last_path")) ||
      "/";
    const path = last.startsWith("/") ? last : `/${last}`;
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    const ua = navigator.userAgent || "";
    const native =
      Boolean(cap?.isNativePlatform?.()) ||
      (/; wv\)/i.test(ua) && /Android/i.test(ua)) ||
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
        <h1 className="mb-3 text-2xl font-bold tracking-tight text-white">
          You're <span className="text-blue-500">Offline</span>
        </h1>
        <p className="mb-7 max-w-xs text-[0.95rem] leading-relaxed text-slate-400">
          It looks like you're not connected to the internet. Please check your network connection and try again.
        </p>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-7 py-3.5 text-[0.95rem] font-semibold text-white"
          onClick={() => recoverAppShell()}
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">This page didn't load</h1>
      <p className="text-sm text-slate-500">Something went wrong. Try again or go back to your dashboard.</p>
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
  let clientOnly = false;
  try {
    if (typeof window !== "undefined") {
      const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
      const ua = navigator.userAgent || "";
      const host = (window.location.hostname || "").toLowerCase();
      const native =
        Boolean(cap?.isNativePlatform?.()) ||
        (/; wv\)/i.test(ua) && /Android/i.test(ua)) ||
        /Capacitor/i.test(ua);
      const localHost =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "" ||
        window.location.protocol === "file:";
      const capSpa = Boolean((window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA);
      // Never use remote website hostname inside APK; always hash for native/local.
      if (native || localHost || capSpa) {
        history = createHashHistory();
      }
      clientOnly = capSpa || native;
    }
  } catch {
    /* default history for pure web */
  }

  const router = createRouter({
    routeTree,
    context: { queryClient },
    history,
    scrollRestoration: !clientOnly,
    defaultPreloadStaleTime: 5 * 60_000,
    // APK: no hover/touch preloading — it raced taps and stalled the WebView.
    defaultPreload: clientOnly ? false : "intent",
    defaultPendingMs: clientOnly ? 150 : 0,
    defaultPendingMinMs: clientOnly ? 0 : 120,
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
