/**
 * D4EXAM fingerprint: prefer D4NativeAuth (BiometricPrompt in MainActivity),
 * then Capgo NativeBiometric. Never stores biometric data.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { isNativeShell, waitForNativeShell } from "@/native/platform";

export type FingerprintAvailability =
  | { ok: true; hasFingerprint: true }
  | {
      ok: false;
      reason: "web" | "no_plugin" | "no_hardware" | "not_enrolled" | "timeout" | "unknown";
      message: string;
    };

export type FingerprintAuthResult =
  | { ok: true }
  | {
      ok: false;
      code: "cancelled" | "failed" | "unavailable" | "error" | "timeout";
      message: string;
    };

type D4NativeAuthPlugin = {
  ping(): Promise<{ ok?: boolean }>;
  isBiometricAvailable(): Promise<{
    available?: boolean;
    status?: string;
    message?: string;
    canAuthenticate?: number;
  }>;
  authenticate(opts?: {
    title?: string;
    subtitle?: string;
    reason?: string;
    negativeButtonText?: string;
  }): Promise<{ ok?: boolean; code?: string; message?: string }>;
};

type CapgoPlugin = {
  isAvailable: (opts?: { useFallback?: boolean }) => Promise<{
    isAvailable?: boolean;
    errorCode?: number;
  }>;
  verifyIdentity: (opts?: Record<string, unknown>) => Promise<void>;
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const t = window.setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${label}_timeout`));
    }, ms);
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}


type D4AndroidBridge = {
  isBiometricAvailable?: () => string | boolean;
  authenticate?: (reason: string) => void;
  authenticateAsync?: (reason: string) => Promise<{ ok?: boolean; code?: string; message?: string }>;
};

function getD4Android(): D4AndroidBridge | null {
  try {
    return (window as unknown as { D4Android?: D4AndroidBridge }).D4Android || null;
  } catch {
    return null;
  }
}

async function ensureNative(): Promise<boolean> {
  if (getD4Android()) return true;
  if (isNativeShell()) return true;
  // Capacitor injects after WebView load — give the bridge more time on cold start
  if (await waitForNativeShell(12_000)) return true;
  await new Promise((r) => setTimeout(r, 1_500));
  return waitForNativeShell(8_000);
}

function d4Auth(): D4NativeAuthPlugin {
  return registerPlugin<D4NativeAuthPlugin>("D4NativeAuth");
}

async function tryD4Available(): Promise<FingerprintAvailability | null> {
  try {
    const p = d4Auth();
    await withTimeout(p.ping(), 8_000, "d4_ping");
    const info = await withTimeout(p.isBiometricAvailable(), 12_000, "d4_avail");
    if (info?.available) return { ok: true, hasFingerprint: true };
    if (info?.status === "not_enrolled") {
      return {
        ok: false,
        reason: "not_enrolled",
        message:
          info.message ||
          "No fingerprint enrolled. Open Settings → Security → Fingerprint and add one.",
      };
    }
    if (info?.status === "no_hardware") {
      return {
        ok: false,
        reason: "no_hardware",
        message: info.message || "This device has no fingerprint sensor.",
      };
    }
    return {
      ok: false,
      reason: "unknown",
      message: info?.message || "Fingerprint is not available on this device.",
    };
  } catch {
    return null;
  }
}

async function tryCapgoAvailable(): Promise<FingerprintAvailability | null> {
  try {
    const mod = await import("@capgo/capacitor-native-biometric");
    const plugin = (mod as { NativeBiometric?: CapgoPlugin }).NativeBiometric;
    if (!plugin?.isAvailable) return null;
    const info = await withTimeout(plugin.isAvailable({ useFallback: true }), 8_000, "capgo_avail");
    if (info?.isAvailable) return { ok: true, hasFingerprint: true };
    if (info?.errorCode === 3) {
      return {
        ok: false,
        reason: "not_enrolled",
        message: "No fingerprint enrolled on this phone.",
      };
    }
    return { ok: true, hasFingerprint: true };
  } catch {
    try {
      const plugin = registerPlugin<CapgoPlugin>("NativeBiometric");
      const info = await withTimeout(plugin.isAvailable({ useFallback: true }), 8_000, "capgo_reg");
      if (info?.isAvailable) return { ok: true, hasFingerprint: true };
    } catch {
      /* ignore */
    }
    return null;
  }
}

export async function checkFingerprintAvailable(): Promise<FingerprintAvailability> {
  if (typeof window === "undefined") {
    return { ok: false, reason: "web", message: "Not available." };
  }
  try {
    const bridge = getD4Android();
    if (bridge?.isBiometricAvailable) {
      const raw = bridge.isBiometricAvailable();
      const ok = raw === true || raw === "true" || (typeof raw === "string" && raw.includes("true"));
      if (ok) return { ok: true, hasFingerprint: true };
    }
  } catch { /* continue */ }
  const native = await ensureNative();
  if (!native && !isNativeShell()) {
    return {
      ok: false,
      reason: "web",
      message: "Fingerprint unlock is only available in the D4EXAM Android app.",
    };
  }

  const d4 = await tryD4Available();
  if (d4) return d4;

  const capgo = await tryCapgoAvailable();
  if (capgo) return capgo;

  return {
    ok: false,
    reason: "no_plugin",
    message:
      "Fingerprint is not available in this app build. Reinstall the latest D4EXAM APK from GitHub Releases.",
  };
}

export async function authenticateWithFingerprint(opts?: {
  reason?: string;
  title?: string;
  subtitle?: string;
}): Promise<FingerprintAuthResult> {
  // 0) D4EXAM standalone WebView bridge
  try {
    const bridge = getD4Android();
    if (bridge) {
      const reason = opts?.reason || "Unlock D4EXAM";
      if (typeof bridge.authenticateAsync === "function") {
        const r = await bridge.authenticateAsync(reason);
        if (r?.ok) return { ok: true };
        if (r?.code === "cancelled") return { ok: false, code: "cancelled", message: r.message || "Cancelled" };
        return { ok: false, code: "failed", message: r?.message || "Fingerprint not recognized." };
      }
      if (typeof bridge.authenticate === "function") {
        return await new Promise<FingerprintAuthResult>((resolve) => {
          const prev = (window as unknown as { __d4FpCb?: (r: FingerprintAuthResult) => void }).__d4FpCb;
          (window as unknown as { __d4FpResult?: (ok: boolean, code?: string, message?: string) => void }).__d4FpResult = (ok, code, message) => {
            if (ok) resolve({ ok: true });
            else resolve({ ok: false, code: (code as "cancelled") || "failed", message: message || "Failed" });
          };
          try {
            bridge.authenticate!(reason);
          } catch (e) {
            resolve({ ok: false, code: "error", message: e instanceof Error ? e.message : "error" });
          }
          window.setTimeout(() => resolve({ ok: false, code: "timeout", message: "Fingerprint timed out." }), 90_000);
        });
      }
    }
  } catch { /* fall through */ }

  const native = await ensureNative();
  if (!native && !isNativeShell()) {
    return { ok: false, code: "unavailable", message: "Not in native app." };
  }

  // 1) Preferred: D4NativeAuth (BiometricPrompt)
  try {
    const p = d4Auth();
    await withTimeout(p.ping(), 8_000, "d4_ping");
    const result = await withTimeout(
      p.authenticate({
        title: opts?.title || "D4EXAM",
        subtitle: opts?.subtitle || "Confirm with your fingerprint",
        reason: opts?.reason || "Unlock D4EXAM",
        negativeButtonText: "Use password",
      }),
      90_000,
      "d4_auth",
    );
    if (result?.ok) return { ok: true };
    if (result?.code === "cancelled") {
      return { ok: false, code: "cancelled", message: result.message || "Cancelled" }; // do NOT treat as hardware unavailable
    }
    return {
      ok: false,
      code: "failed",
      message: result?.message || "Fingerprint not recognized.",
    };
  } catch (e) {
    const msg = String((e as Error)?.message || e || "");
    if (msg.includes("timeout")) {
      // fall through to Capgo
    }
  }

  // 2) Capgo fallback
  try {
    let plugin: CapgoPlugin | null = null;
    try {
      const mod = await import("@capgo/capacitor-native-biometric");
      plugin = (mod as { NativeBiometric?: CapgoPlugin }).NativeBiometric || null;
    } catch {
      plugin = registerPlugin<CapgoPlugin>("NativeBiometric");
    }
    if (!plugin?.verifyIdentity) {
      return {
        ok: false,
        code: "unavailable",
        message: "Fingerprint plugin missing. Reinstall the latest D4EXAM APK.",
      };
    }
    await withTimeout(
      plugin.verifyIdentity({
        reason: opts?.reason || "Unlock D4EXAM",
        title: opts?.title || "D4EXAM",
        subtitle: opts?.subtitle || "Confirm with your fingerprint",
        description: opts?.reason || "Unlock D4EXAM",
        negativeButtonText: "Use password",
        maxAttempts: 5,
        useFallback: true,
      }),
      90_000,
      "capgo_auth",
    );
    return { ok: true };
  } catch (e) {
    const msg = String((e as Error)?.message || e || "").toLowerCase();
    if (msg.includes("cancel") || msg.includes("user")) {
      return { ok: false, code: "cancelled", message: "Cancelled" };
    }
    if (msg.includes("timeout")) {
      return {
        ok: false,
        code: "timeout",
        message: "Fingerprint prompt closed. Try again or use your app password.",
      };
    }
    return {
      ok: false,
      code: "error",
      message: (e as Error)?.message || "Fingerprint authentication failed.",
    };
  }
}
