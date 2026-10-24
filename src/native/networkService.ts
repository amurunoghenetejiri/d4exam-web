/**
 * Network status — browser online/offline + real connectivity probe.
 * Capacitor Network can replace this later without UI changes.
 */
import { D4_SUPABASE_URL } from "@/integrations/supabase/client";

export type NetworkStatus = {
  connected: boolean;
  connectionType: "wifi" | "cellular" | "none" | "unknown";
};

let lastProbeOk = true;
let lastProbeAt = 0;

export function getNetworkStatus(): NetworkStatus {
  if (typeof navigator === "undefined") {
    return { connected: true, connectionType: "unknown" };
  }
  // Browser online wins — stale failed probes must not block website exam start
  const online = navigator.onLine !== false;
  const conn = (navigator as Navigator & {
    connection?: { effectiveType?: string; type?: string };
  }).connection;
  let connectionType: NetworkStatus["connectionType"] = "unknown";
  if (!online) connectionType = "none";
  else if (conn?.type === "wifi" || conn?.effectiveType === "wifi") connectionType = "wifi";
  else if (conn?.effectiveType) connectionType = "cellular";
  return { connected: online, connectionType };
}

/**
 * Hit a same-origin lightweight URL to confirm real connectivity.
 * Falls back to navigator.onLine if the probe itself fails for CORS/path reasons.
 */
export async function probeConnectivity(timeoutMs = 4000): Promise<boolean> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    lastProbeOk = false;
    lastProbeAt = Date.now();
    return false;
  }
  if (typeof window === "undefined") return true;

  const now = Date.now();
  if (now - lastProbeAt < 3000) return lastProbeOk;

  // The bundled Android shell is served from https://localhost, so a same-origin
  // asset would always "succeed" and falsely report the device as online.
  // Probe the real remote backend origin in that case.
  const remoteBase =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_SUPABASE_URL || D4_SUPABASE_URL;
  let localShell = false;
  try {
    localShell = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(window.location.origin);
  } catch {
    localShell = false;
  }
  const useRemoteProbe = localShell && Boolean(remoteBase);
  const url = useRemoteProbe
    ? `${remoteBase}/auth/v1/health?_ping=${now}`
    : `${window.location.origin}/site.webmanifest?_ping=${now}`;

  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      mode: useRemoteProbe ? "cors" : "same-origin",
      signal: ctrl.signal,
    });
    window.clearTimeout(t);
    lastProbeOk = res.ok || res.status === 304 || res.status === 401 || res.type === "opaque";
  } catch {
    lastProbeOk = false;
  }
  lastProbeAt = Date.now();
  return lastProbeOk;
}

export function subscribeNetworkStatus(cb: (status: NetworkStatus) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const fire = () => cb(getNetworkStatus());
  const onOnline = () => {
    void probeConnectivity().then(() => fire());
  };
  const onOffline = () => {
    lastProbeOk = false;
    lastProbeAt = Date.now();
    fire();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  fire();
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}
