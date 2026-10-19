/**
 * Online-required action guards. Minimal UX — no full-page blockers.
 */
import { isOnlineNow, requireOnlineMessage } from "@/lib/offline-sync";
import { resolveConnectivity } from "@/lib/sync/connectivity";

export { requireOnlineMessage, isOnlineNow };

/** True if we believe the device can reach the network. */
export function canReachNetwork(): boolean {
  return isOnlineNow();
}

/**
 * Returns null if online, or the user-facing message if offline.
 * Use before exam start, submit, approvals, etc.
 */
export async function assertOnlineAction(): Promise<string | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return requireOnlineMessage();
  }
  if (typeof navigator !== "undefined" && navigator.onLine === true) {
    return null;
  }
  if (!isOnlineNow()) return requireOnlineMessage();
  return null;
}

export function assertOnlineActionSync(): string | null {
  // Website / browser: only block when the browser itself reports offline
  if (typeof navigator !== "undefined") {
    if (navigator.onLine === false) return requireOnlineMessage();
    return null;
  }
  if (!isOnlineNow()) return requireOnlineMessage();
  return null;
}

/** Features available offline (cached). Documentation helper. */
export const OFFLINE_SUPPORTED = [
  "dashboard_lists",
  "exam_metadata",
  "notifications_read",
  "results_view",
  "materials_cached",
  "profile_display",
] as const;

/** Features that always need internet. */
export const ONLINE_REQUIRED = [
  "exam_start",
  "exam_submit",
  "live_monitoring",
  "approvals",
  "admin_mutations",
  "push_delivery",
  "auth_login",
] as const;
