/**
 * Platform detection for D4EXAM Capacitor Android/iOS shell.
 *
 * Critical: when capacitor.config server.url loads the live website inside the
 * WebView, Capacitor injects window.Capacitor asynchronously. Early checks can
 * falsely return "web" and skip ALL native plugins (biometric, notifications,
 * screen share). Always prefer waitForNativeShell() before native calls.
 */
export type RuntimePlatform = "web" | "ios" | "android" | "unknown";

type CapWindow = Window & {
  Capacitor?: {
    getPlatform?: () => string;
    isNativePlatform?: () => boolean;
    isPluginAvailable?: (name: string) => boolean;
    Plugins?: Record<string, unknown>;
  };
  android?: unknown;
  webkit?: { messageHandlers?: unknown };
  __D4_CAP_SPA?: boolean;
};

const NATIVE_FLAG_KEY = "d4exam_native_shell_v1";

function persistNativeFlag(platform?: string) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(NATIVE_FLAG_KEY, platform || "1");
    try {
      document.documentElement.setAttribute("data-d4-native", platform || "1");
    } catch {
      /* ignore */
    }
  } catch {
    /* private mode */
  }
}

function readNativeFlag(): boolean {
  try {
    return window.localStorage.getItem(NATIVE_FLAG_KEY) === "1" || Boolean(window.localStorage.getItem(NATIVE_FLAG_KEY));
  } catch {
    return false;
  }
}

function readCapacitor(): CapWindow["Capacitor"] | undefined {
  try {
    return (window as CapWindow).Capacitor;
  } catch {
    return undefined;
  }
}

function isCapSpaShell(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if ((window as CapWindow).__D4_CAP_SPA) return true;
    const host = (window.location.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "") return true;
    if (window.location.protocol === "file:") return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Synchronous detection — may be false before Capacitor bridge injects. */
export function getRuntimePlatform(): RuntimePlatform {
  if (typeof window === "undefined") return "unknown";
  const Cap = readCapacitor();
  try {
    if (Cap?.isNativePlatform?.()) {
      const p = (Cap.getPlatform?.() || "").toLowerCase();
      if (p === "ios") {
        persistNativeFlag("ios");
        return "ios";
      }
      persistNativeFlag("android");
      return "android";
    }
  } catch {
    /* ignore */
  }
  try {
    const p = (Cap?.getPlatform?.() || "").toLowerCase();
    if (p === "android") {
      persistNativeFlag("android");
      return "android";
    }
    if (p === "ios") {
      persistNativeFlag("ios");
      return "ios";
    }
  } catch {
    /* ignore */
  }
  try {
    const ua = navigator.userAgent || "";
    // Android System WebView used by Capacitor (not Chrome)
    if (ua.includes("; wv)") && /Android/i.test(ua)) {
      persistNativeFlag("android");
      return "android";
    }
    if (/Capacitor/i.test(ua) && /Android/i.test(ua)) {
      persistNativeFlag("android");
      return "android";
    }
    if (/Capacitor/i.test(ua) && /iPhone|iPad|iPod/i.test(ua)) {
      persistNativeFlag("ios");
      return "ios";
    }
  } catch {
    /* ignore */
  }
  // Bundled local SPA (no remote server.url)
  if (isCapSpaShell()) {
    persistNativeFlag("android");
    return "android";
  }
  // Plugins object present ⇒ Capacitor injected even if isNativePlatform lags
  try {
    if (Cap?.Plugins && typeof Cap.Plugins === "object") {
      persistNativeFlag("android");
      return "android";
    }
  } catch {
    /* ignore */
  }
  return "web";
}

export function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  if (isCapSpaShell()) return true;
  const p = getRuntimePlatform();
  if (p === "android" || p === "ios") return true;
  // Soft: Android WebView UA even without Capacitor yet
  try {
    const ua = navigator.userAgent || "";
    if (ua.includes("; wv)") && /Android/i.test(ua)) {
      persistNativeFlag("android");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Wait until Capacitor bridge is injected (up to timeoutMs).
 * Use before biometric / notifications / screen-share.
 */
export async function waitForNativeShell(timeoutMs = 8_000): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (isNativeShell() && readCapacitor()?.isNativePlatform?.()) return true;
  if (isNativeShell()) return true;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const Cap = readCapacitor();
    try {
      if (Cap?.isNativePlatform?.()) {
        persistNativeFlag(Cap.getPlatform?.() || "android");
        return true;
      }
      if (Cap?.getPlatform?.() === "android" || Cap?.getPlatform?.() === "ios") {
        persistNativeFlag(Cap.getPlatform());
        return true;
      }
      if (Cap?.Plugins) {
        persistNativeFlag("android");
        return true;
      }
    } catch {
      /* ignore */
    }
    // UA-based Android WebView (bridge may still be loading)
    try {
      const ua = navigator.userAgent || "";
      if (ua.includes("; wv)") && /Android/i.test(ua) && Cap) {
        persistNativeFlag("android");
        return true;
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return isNativeShell();
}

export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const mq =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches;
    const ios =
      "standalone" in navigator &&
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    return mq || ios;
  } catch {
    return false;
  }
}

export function isAppLikeShell(): boolean {
  if (isNativeShell()) return true;
  if (isStandalonePwa()) return true;
  if (readNativeFlag()) return true;
  return false;
}

/** Call once on app boot so native flag is set as soon as bridge appears. */
export function startNativeShellWatcher(): void {
  if (typeof window === "undefined") return;
  void waitForNativeShell(15_000).then((ok) => {
    if (ok) {
      try {
        window.dispatchEvent(new Event("d4-native-ready"));
      } catch {
        /* ignore */
      }
    }
  });
  // Poll briefly on visibility in case bridge injects late
  const id = window.setInterval(() => {
    if (isNativeShell()) {
      window.clearInterval(id);
      try {
        window.dispatchEvent(new Event("d4-native-ready"));
      } catch {
        /* ignore */
      }
    }
  }, 500);
  window.setTimeout(() => window.clearInterval(id), 20_000);
}

/** Confirm native bridge + D4NativeAuth plugin (APK with registerPlugin). */
export async function pingNativeAuth(timeoutMs = 4_000): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    await waitForNativeShell(Math.min(timeoutMs, 8_000));
    const { registerPlugin } = await import("@capacitor/core");
    const auth = registerPlugin<{ ping: () => Promise<{ ok?: boolean }> }>("D4NativeAuth");
    const r = await Promise.race([
      auth.ping(),
      new Promise<{ ok?: boolean }>((_, rej) =>
        window.setTimeout(() => rej(new Error("ping_timeout")), timeoutMs),
      ),
    ]);
    if (r?.ok) {
      try {
        window.localStorage.setItem("d4exam_native_shell_v1", "android");
      } catch { /* ignore */ }
      return true;
    }
  } catch {
    /* plugin missing or web */
  }
  return isNativeShell();
}
