/**
 * Device-local fingerprint unlock preferences.
 * Never stores biometric templates — only whether unlock is enabled for a userId.
 *
 * Persistence model:
 * - PREF_KEY (localStorage): enabled + userId — survives app kill / device reboot
 * - LOCKED_KEY (localStorage): currently locked — survives process death
 * - SESSION_UNLOCKED (sessionStorage + in-memory): unlocked for this JS process only
 * - BG_AT (sessionStorage): when app last went to background
 *
 * On cold start / process recreate: session unlocked is gone → require fingerprint again
 * if the preference is still enabled for the current user.
 */
import { isNativeShell } from "@/native/platform";

const PREF_KEY = "d4_fp_lock_v1";
const LOCKED_KEY = "d4_fp_locked_v1";
const BG_AT_KEY = "d4_fp_bg_at_v1";
const SESSION_UNLOCKED_KEY = "d4_fp_session_unlocked_v1";

/** Grace period (ms) after background before requiring fingerprint again */
/** App must be in background this long before unlock is required again */
export const FP_LOCK_GRACE_MS = 10_000;

export type FingerprintLockPref = {
  enabled: boolean;
  userId: string;
  enabledAt: number;
};

/** In-memory flag for the current JS process (cleared on kill / full reload) */
let processUnlocked = false;

function safeParse(raw: string | null): FingerprintLockPref | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as FingerprintLockPref;
    if (!v || typeof v.userId !== "string") return null;
    return v;
  } catch {
    return null;
  }
}

export function readFingerprintPref(): FingerprintLockPref | null {
  if (typeof window === "undefined") return null;
  try {
    return safeParse(window.localStorage.getItem(PREF_KEY));
  } catch {
    return null;
  }
}

export function isFingerprintEnabledFor(userId: string | null | undefined): boolean {
  if (!userId || !isNativeShell()) return false;
  const p = readFingerprintPref();
  return Boolean(p?.enabled && p.userId === userId);
}

export function enableFingerprintFor(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  const pref: FingerprintLockPref = {
    enabled: true,
    userId,
    enabledAt: Date.now(),
  };
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(pref));
    setFingerprintLocked(false);
    markSessionUnlocked();
  } catch {
    /* quota */
  }
}

export function disableFingerprint(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREF_KEY);
    window.localStorage.removeItem(LOCKED_KEY);
    window.localStorage.removeItem(BG_AT_KEY);
    window.sessionStorage.removeItem(SESSION_UNLOCKED_KEY);
    window.sessionStorage.removeItem(BG_AT_KEY);
    processUnlocked = false;
  } catch {
    /* ignore */
  }
}

/** Clear fingerprint pref when the associated user logs out or is switched away */
export function clearFingerprintIfUser(userId: string | null | undefined): void {
  const p = readFingerprintPref();
  if (!p) return;
  if (!userId || p.userId === userId) {
    disableFingerprint();
  }
}

export function isFingerprintLocked(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LOCKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setFingerprintLocked(locked: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (locked) {
      window.localStorage.setItem(LOCKED_KEY, "1");
      processUnlocked = false;
      try {
        window.sessionStorage.removeItem(SESSION_UNLOCKED_KEY);
      } catch {
        /* ignore */
      }
    } else {
      window.localStorage.removeItem(LOCKED_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function markAppBackgrounded(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(BG_AT_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

export function markSessionUnlocked(): void {
  processUnlocked = true;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_UNLOCKED_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function isSessionUnlocked(): boolean {
  if (processUnlocked) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(SESSION_UNLOCKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearSessionUnlocked(): void {
  processUnlocked = false;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SESSION_UNLOCKED_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Decide whether the app should be locked when returning from background
 * or on cold start.
 *
 * - If already marked locked in localStorage → lock
 * - If we have a background timestamp and grace elapsed → lock
 * - If this JS process was never unlocked (cold start) → lock
 * - Otherwise stay unlocked within the grace window
 */
export function shouldLockAfterBackground(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // If the user already unlocked this session and we are still inside the grace
    // window (or never left the app), do NOT lock — in-app page changes must stay free.
    const raw = window.sessionStorage.getItem(BG_AT_KEY);
    if (raw) {
      const at = Number(raw);
      if (Number.isFinite(at) && Date.now() - at >= FP_LOCK_GRACE_MS) {
        // Away for 10+ seconds → lock
        return true;
      }
      // Still within 10s of leaving the app → stay unlocked (also clear stale lock flag)
      if (isFingerprintLocked()) setFingerprintLocked(false);
      return false;
    }

    // No background timestamp:
    // - If this JS session was unlocked, keep unlocked (fixes lock-on-every-page bug)
    if (isSessionUnlocked()) {
      if (isFingerprintLocked()) setFingerprintLocked(false);
      return false;
    }
    // Cold start / process kill with no unlock yet → require unlock
    return true;
  } catch {
    // Prefer not locking on errors so in-app navigation is never blocked
    return false;
  }
}

export function clearBackgroundMark(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(BG_AT_KEY);
  } catch {
    /* ignore */
  }
}

export function isActiveCbtExamPath(pathname?: string): boolean {
  try {
    const path = pathname || (typeof window !== "undefined" ? window.location.pathname : "");
    if (/\/student\/exam\/[^/]+/i.test(path)) return true;
    if (typeof window !== "undefined") {
      const flag = window.sessionStorage.getItem("d4_exam_active");
      if (flag === "1") return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function setExamActiveFlag(active: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (active) window.sessionStorage.setItem("d4_exam_active", "1");
    else window.sessionStorage.removeItem("d4_exam_active");
  } catch {
    /* ignore */
  }
}
