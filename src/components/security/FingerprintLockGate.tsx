// @ts-nocheck
/**
 * Full-screen fingerprint unlock gate for the native D4EXAM shell.
 *
 * Flow: ONE splash → this page (full screen, school logo) → native biometric → dashboard.
 * No white loading gap between splash and this page.
 * School users: school logo. Super Admin only: D4EXAM logo.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Fingerprint,
  GraduationCap,
  Shield,
  ShieldCheck,
  UserRound,
  Building2,
  LogOut,
} from "lucide-react";
import { useRouterState } from "@tanstack/react-router";
import { App as CapApp } from "@capacitor/app";
import {
  useSessionUser,
  readCachedSchoolBrand,
  roleHome,
  readPreferredRole,
  readLastRole,
  readPendingLoginRole,
  type AppRole,
} from "@/lib/session";
import { isNativeShell, waitForNativeShell } from "@/native/platform";
import {
  authenticateWithFingerprint,
  checkFingerprintAvailable,
} from "@/native/fingerprintAuth";
import {
  clearBackgroundMark,
  isFingerprintEnabledFor,
  isFingerprintLocked,
  isSessionUnlocked,
  markAppBackgrounded,
  markSessionUnlocked,
  readFingerprintPref,
  setFingerprintLocked,
  shouldLockAfterBackground,
  isActiveCbtExamPath,
  enableFingerprintFor,
} from "@/lib/fingerprint-lock";
import { readLastUserId } from "@/lib/offline-query";
import { cn } from "@/lib/utils";
import { appNavigate } from "@/lib/app-navigate";

const SPLASH_SESSION_KEY = "d4exam_splash_shown_v6";
/** App theme navy — matches Capacitor status bar / splash */
const THEME_NAVY = "#0b1b3a";

function isSplashStillShowing(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.sessionStorage.getItem(SPLASH_SESSION_KEY) === "1") return false;
    const el = document.getElementById("d4-boot-splash");
    if (el) {
      const d = window.getComputedStyle(el).display;
      if (d && d !== "none") return true;
    }
    return false;
  } catch {
    return false;
  }
}

function roleLabel(role: AppRole | string | null | undefined): string {
  switch (role) {
    case "student":
      return "Student";
    case "teacher":
      return "Teacher";
    case "examination_officer":
      return "Departmental Officer";
    case "school_admin":
      return "School Admin";
    case "super_admin":
      return "Super Admin";
    default:
      return role ? String(role).replace(/_/g, " ") : "User";
  }
}

function roleIcon(role: AppRole | string | null | undefined) {
  switch (role) {
    case "student":
      return GraduationCap;
    case "teacher":
      return UserRound;
    case "examination_officer":
      return Shield;
    case "school_admin":
      return Building2;
    case "super_admin":
      return ShieldCheck;
    default:
      return UserRound;
  }
}

function unlockHint(): string {
  return "Verify your identity to unlock D4EXAM securely.";
}

/** Proper name casing (not ALL CAPS). */
function displayName(raw: string | null | undefined): string {
  let s = (raw || "").trim();
  // Never show role titles as the person's name on unlock
  if (/^(school\s*admin|examination\s*officer|departmental\s*officer|teacher|student|super\s*admin|user)$/i.test(s)) {
    s = "";
  }
  if (!s) return "D4EXAM User";
  // If already mixed case with spaces, keep as-is
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) return s;
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function lastKnownRole(): AppRole | null {
  try {
    const r =
      window.localStorage.getItem("d4exam_last_role_v1") ||
      window.localStorage.getItem("d4exam_preferred_role_v1");
    const known = ["student", "teacher", "school_admin", "examination_officer", "super_admin"];
    if (r && known.includes(r)) return r as AppRole;
  } catch {
    /* ignore */
  }
  return null;
}

export function FingerprintLockGate() {
  const [native, setNative] = useState(() => isNativeShell());
  const { data: session } = useSessionUser();

  useEffect(() => {
    if (native) return;
    let cancelled = false;
    void waitForNativeShell(10_000).then((ok) => {
      if (!cancelled && (ok || isNativeShell())) setNative(true);
    });
    const onReady = () => {
      if (isNativeShell()) setNative(true);
    };
    window.addEventListener("d4-native-ready", onReady);
    return () => {
      cancelled = true;
      window.removeEventListener("d4-native-ready", onReady);
    };
  }, [native]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [locked, setLocked] = useState(false);

  // Prevent password keystrokes from reaching focused inputs under the lock overlay
  useEffect(() => {
    if (!locked) {
      try {
        document.documentElement.removeAttribute("data-d4-unlock-inert");
        document.getElementById("root")?.removeAttribute("inert");
        document.getElementById("app")?.removeAttribute("inert");
        const main = document.querySelector("main");
        main?.removeAttribute("inert");
      } catch { /* ignore */ }
      return;
    }
    try {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && typeof ae.blur === "function" && ae !== document.body) {
        // blur everything except elements inside the lock portal
        const inLock = ae.closest?.("[data-d4-lock-gate]");
        if (!inLock) ae.blur();
      }
      document.documentElement.setAttribute("data-d4-unlock-inert", "1");
      // Mark app shell inert so inputs under the overlay cannot receive focus/input
      const root = document.getElementById("root") || document.getElementById("app");
      if (root) root.setAttribute("inert", "");
      document.querySelectorAll("main, [data-d4-shell]").forEach((el) => {
        try { el.setAttribute("inert", ""); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    return () => {
      try {
        document.documentElement.removeAttribute("data-d4-unlock-inert");
        document.getElementById("root")?.removeAttribute("inert");
        document.getElementById("app")?.removeAttribute("inert");
        document.querySelectorAll("[inert]").forEach((el) => {
          // only clear ones we likely set - if lock portal is not parent
          if (!(el as HTMLElement).closest?.("[data-d4-lock-gate]")) {
            try { el.removeAttribute("inert"); } catch { /* ignore */ }
          }
        });
      } catch { /* ignore */ }
    };
  }, [locked]);

  const [failedMsg, setFailedMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "scanning" | "success" | "failed">("idle");
  const [pageReady, setPageReady] = useState(false);
  const [splashDone, setSplashDone] = useState(() => {
    try {
      return (
        typeof window !== "undefined" &&
        window.sessionStorage.getItem(SPLASH_SESSION_KEY) === "1"
      );
    } catch {
      return false;
    }
  });
  const [logoBroken, setLogoBroken] = useState(false);
  const promptedRef = useRef(false);
  const runningRef = useRef(false);

  const pref = typeof window !== "undefined" ? readFingerprintPref() : null;
  const lastUid = typeof window !== "undefined" ? readLastUserId() : null;
  const userId = session?.userId ?? pref?.userId ?? lastUid ?? null;

  const isPublicAuthPath =
    pathname === "/login" ||
    pathname === "/" ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/forgot-app-password") ||
    pathname.startsWith("/reset-app-password") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/school-application") ||
    pathname.startsWith("/application-status") ||
    pathname.startsWith("/features") ||
    pathname.startsWith("/pricing") ||
    pathname.startsWith("/about") ||
    pathname.startsWith("/support") ||
    pathname.startsWith("/privacy");

  // Splash must finish before fingerprint page + OS prompt
  useEffect(() => {
    if (!native) {
      if (!splashDone) setSplashDone(true);
      return;
    }
    if (splashDone) return;
    if (!isSplashStillShowing()) {
      setSplashDone(true);
      return;
    }
    const id = window.setInterval(() => {
      try {
        if (window.sessionStorage.getItem(SPLASH_SESSION_KEY) === "1" || !isSplashStillShowing()) {
          setSplashDone(true);
          window.clearInterval(id);
        }
      } catch {
        setSplashDone(true);
        window.clearInterval(id);
      }
    }, 50);
    const cap = window.setTimeout(() => setSplashDone(true), 800);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(cap);
    };
  }, [native, splashDone]);

  const [mode, setMode] = useState<"fingerprint" | "password">("fingerprint"); // default: fingerprint
  const [appPw, setAppPw] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [hasAppPw, setHasAppPw] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  /** Device fingerprint capability: pending | yes | no */
  const [hwState, setHwState] = useState<"pending" | "yes" | "no">("pending");
  /** Soft prompt: enable fingerprint after password unlock */
  const [offerEnableFp, setOfferEnableFp] = useState(false);

  // Detect real device biometric support (was imported but never called — hwState stayed pending)
  useEffect(() => {
    if (!native) {
      setHwState("no");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const avail = await checkFingerprintAvailable();
        if (cancelled) return;
        if (avail.ok && avail.hasFingerprint !== false) {
          setHwState("yes");
        } else if (avail.reason === "timeout") {
          // Keep pending briefly — do not force password-only on slow devices
          setHwState("yes");
        } else {
          setHwState("no");
        }
      } catch {
        if (!cancelled) setHwState("yes"); // prefer FP UI; prompt will fail gracefully
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [native]);
  const [enableFpBusy, setEnableFpBusy] = useState(false);
  /** User explicitly chose password — do not auto-switch back until unlock cycle resets */
  const userPickedPasswordRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { hasAppUnlockFor } = await import("@/lib/app-unlock");
        const ok = await hasAppUnlockFor(userId);
        if (!cancelled) setHasAppPw(ok);
      } catch {
        if (!cancelled) setHasAppPw(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  function showPasswordMode() {
    userPickedPasswordRef.current = true;
    setMode("password");
    setAppPw("");
    setPwError(null);
    setStatus("idle");
    setFailedMsg(null);
  }

  function showFingerprintMode() {
    userPickedPasswordRef.current = false;
    setMode("fingerprint");
    setAppPw("");
    setPwError(null);
    setFailedMsg(null);
    promptedRef.current = false;
  }

  async function unlockWithAppPassword() {
    if (!userId || pwBusy) return;
    setPwBusy(true);
    setPwError(null);
    try {
      const { verifyAppUnlockPassword } = await import("@/lib/app-unlock");
      const ok = await verifyAppUnlockPassword(userId, appPw);
      if (!ok) {
        setPwError("Incorrect app password. Try again.");
        return;
      }
      finishUnlock({ fromPassword: true });
    } catch {
      setPwError("Could not verify password. Try again.");
    } finally {
      setPwBusy(false);
    }
  }

  async function confirmLogout() {
    try {
      const { clearAppUnlockFor } = await import("@/lib/app-unlock");
      await clearAppUnlockFor(userId);
    } catch {
      /* ignore */
    }
    try {
      const { clearFingerprintIfUser, setFingerprintLocked, clearSessionUnlocked } = await import(
        "@/lib/fingerprint-lock"
      );
      clearFingerprintIfUser(userId);
      setFingerprintLocked(false);
      clearSessionUnlocked();
    } catch {
      /* ignore */
    }
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      await supabase.auth.signOut();
    } catch {
      /* ignore */
    }
    setLocked(false);
    setLogoutConfirm(false);
    try {
      appNavigate("/login");
    } catch {
      try {
        window.location.href = "/login";
      } catch {
        window.location.assign("/login");
      }
    }
    // Hard fallback so unlock screen never traps the user
    window.setTimeout(() => {
      try {
        if (!String(window.location.href || "").includes("login")) {
          window.location.assign("/login");
        }
      } catch {
        /* ignore */
      }
    }, 400);
  }

  const evaluateLock = useCallback(() => {
    if (isPublicAuthPath) {
      setLocked(false);
      return;
    }
    // Never lock during an in-progress exam
    if (isActiveCbtExamPath(pathname)) {
      setLocked(false);
      return;
    }
    const uid = session?.userId ?? pref?.userId ?? lastUid;
    const fpEnabled = Boolean(uid && isFingerprintEnabledFor(uid)) || Boolean(pref?.enabled && pref.userId);
    // Device supports fingerprint (phone/laptop biometric)?
    // Show FP UI when device supports it AND user has enabled FP in app.
    // If device supports but user never enabled → password only, then offer enable.
    // Native + user enabled FP + device not proven without FP → fingerprint first
    // Web always password. hwState "pending" still allows FP UI so it does not flash away.
    const canFp = Boolean(native && hwState !== "no");
    const unlockConfigured = hasAppPw || fpEnabled || canFp;
    if (!native) {
      // Website / non-Capacitor: never full-screen lock (blocks menu & taps)
      setLocked(false);
      return;
    }
    if (!uid || !unlockConfigured) {
      setLocked(false);
      return;
    }
    if (isFingerprintLocked() || shouldLockAfterBackground()) {
      if (isSessionUnlocked() && !isFingerprintLocked() && !shouldLockAfterBackground()) {
        setLocked(false);
        return;
      }
      setFingerprintLocked(true);
      setLocked(true);
      setFailedMsg(null);
      setStatus("idle");
      promptedRef.current = false;
      userPickedPasswordRef.current = false;
      if (canFp) setMode("fingerprint");
      else setMode("password");
      return;
    }
    setLocked(false);
  }, [native, isPublicAuthPath, session?.userId, pathname, pref?.userId, pref?.enabled, lastUid, hasAppPw, hwState]);

  useEffect(() => {
    evaluateLock();
  }, [evaluateLock, session?.userId, splashDone, native]);
  // Never leave the user on a blank navy screen
  useEffect(() => {
    if (!locked) return;
    // Never keep a typed password across lock cycles / tab returns
    setAppPw("");
    setPwError(null);
    setSplashDone(true);
    const t = window.setTimeout(() => setPageReady(true), 150);
    return () => window.clearTimeout(t);
  }, [locked]);

  useEffect(() => {
    if (!locked) return;
    if (userPickedPasswordRef.current) {
      setMode("password");
      return;
    }
    const fpEnabled = isFingerprintEnabledFor(userId) || Boolean(pref?.enabled && pref.userId);
    // Only force password when device is known to lack fingerprint
    const canFp = Boolean(native && hwState !== "no");
    if (canFp) setMode("fingerprint");
    else setMode("password");
  }, [locked, userId, pref?.enabled, hwState, native]);


  // Background / resume
  useEffect(() => {
    if (!native) return;
    let handle: { remove: () => Promise<void> } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        handle = await CapApp.addListener("appStateChange", ({ isActive }) => {
          if (cancelled) return;
          if (!isActive) {
            markAppBackgrounded();
            return;
          }
          const uid = session?.userId ?? pref?.userId ?? lastUid;
          const fpEnabled = isFingerprintEnabledFor(uid) || Boolean(pref?.enabled && pref.userId);
          const canFp = Boolean(hwState !== "no");
          // Native APK: offer FP whenever hardware is available (do not require preference)
          const canLock = hasAppPw || fpEnabled || canFp;
          if (!canLock) return;
          if (isActiveCbtExamPath()) return;
          setFingerprintLocked(true);
          setLocked(true);
          setAppPw("");
          setPwError(null);
          setFailedMsg(null);
          setStatus("idle");
          promptedRef.current = false;
          runningRef.current = false;
          setPageReady(false);
          userPickedPasswordRef.current = false;
          setMode(canFp ? "fingerprint" : "password");
          clearBackgroundMark();
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [native, session?.userId, pref?.userId, lastUid]);


  // Website: lock with app password when user leaves the tab and returns
  useEffect(() => {
    if (native) return;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        markAppBackgrounded();
        return;
      }
      if (isPublicAuthPath || isActiveCbtExamPath()) return;
      const uid = session?.userId ?? pref?.userId ?? lastUid;
      if (!uid || !hasAppPw) return;
      if (isActiveCbtExamPath()) return;
      setFingerprintLocked(true);
      setLocked(true);
      setMode("password");
      setAppPw("");
      setPwError(null);
      setFailedMsg(null);
      setStatus("idle");
      setPageReady(true);
      clearBackgroundMark();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [native, isPublicAuthPath, session?.userId, pref?.userId, lastUid, hasAppPw]);

  // Page visible → ready for OS prompt (never over splash)
  useEffect(() => {
    if (!locked) {
      setPageReady(false);
      return;
    }
    if (!native) {
      setPageReady(true);
      return;
    }
    if (!splashDone) {
      setPageReady(false);
      return;
    }
    setPageReady(false);
    const t = window.setTimeout(() => setPageReady(true), 200);
    return () => window.clearTimeout(t);
  }, [locked, splashDone, native]);

  function finishUnlock(opts?: { fromPassword?: boolean }) {
    setFingerprintLocked(false);
    clearBackgroundMark();
    markSessionUnlocked();
    setFailedMsg(null);
    setStatus("success");
    setLocked(false);
    promptedRef.current = false;
    runningRef.current = false;
    // Refresh school-linked session after unlock (fixes officer "not linked to school")
    void (async () => {
      try {
        const { repairMySessionSchool } = await import("@/lib/repair-session-school.functions");
        const fixed = await repairMySessionSchool();
        if (fixed?.schoolId) {
          const { seedLoginSchoolContext } = await import("@/lib/session");
          seedLoginSchoolContext(fixed.schoolId, fixed.schoolCode);
        }
      } catch {
        /* ignore */
      }
      try {
        window.dispatchEvent(new Event("d4-session-refresh"));
      } catch {
        /* ignore */
      }
    })();
    // Unlock while still on /login (SPA race): go to role dashboard
    try {
      const path = pathname || "";
      if (path === "/login" || path === "/") {
        const role = readPreferredRole() || readLastRole() || readPendingLoginRole();
        if (role && roleHome[role]) {
          appNavigate(roleHome[role]);
        }
      }
    } catch {
      /* ignore */
    }
    // After password unlock on a fingerprint-capable device that is not yet enabled → offer enable
    if (
      opts?.fromPassword &&
      native &&
      hwState === "yes" &&
      userId &&
      !isFingerprintEnabledFor(userId)
    ) {
      window.setTimeout(() => setOfferEnableFp(true), 400);
    }
  }

  async function tryUnlock() {
    if (runningRef.current) return;
    if (!splashDone || isSplashStillShowing()) return;
    runningRef.current = true;
    setFailedMsg(null);
    setStatus("scanning");

    const safety = window.setTimeout(() => {
      if (runningRef.current) {
        runningRef.current = false;
        setStatus("failed");
        setFailedMsg("Fingerprint timed out. Tap the fingerprint to try again, or use your app password.");
      }
    }, 90_000);

    try {
      const avail = await checkFingerprintAvailable();
      if (!avail.ok) {
        setHwState("no");
        setMode("password");
        setStatus("failed");
        setFailedMsg(avail.message || "Fingerprint is not available on this device. Use your app password.");
        return;
      }
      setHwState("yes");
      const result = await authenticateWithFingerprint({
        reason: "Unlock D4EXAM",
        title: "D4EXAM",
        subtitle: "Use your fingerprint to continue",
      });
      if (result.ok) {
        setStatus("success");
        window.setTimeout(() => finishUnlock(), 280);
        return;
      }
      if (result.code === "cancelled") {
        setStatus("idle");
        setFailedMsg(null);
      } else {
        setStatus("failed");
        setFailedMsg(result.message || "Fingerprint not recognised. Tap to try again.");
      }
    } catch (e) {
      setStatus("failed");
      setFailedMsg((e as Error)?.message || "Could not verify fingerprint. Tap to try again.");
    } finally {
      window.clearTimeout(safety);
      runningRef.current = false;
    }
  }

  useEffect(() => {
    if (!locked || !splashDone || !pageReady || !native) return;
    if (mode !== "fingerprint") return;
    // Native APK: prompt FP whenever hardware is available (do not require preference)
    if (promptedRef.current || runningRef.current) return;
    promptedRef.current = true;
    void tryUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, splashDone, pageReady, native, mode, userId]);

  useEffect(() => {
    if (!locked || !native) return;
    let handle: { remove: () => Promise<void> } | null = null;
    let cancelled = false;
    void (async () => {
      try {
        handle = await CapApp.addListener("backButton", () => {
          /* stay on fingerprint page */
        });
        if (cancelled) await handle?.remove();
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [locked, native]);


  // Hide boot splash when fingerprint page is about to show (seamless navy)
  useEffect(() => {
    if (!native || !locked || !splashDone) return;
    try {
      window.dispatchEvent(new Event("d4-hide-boot-splash"));
    } catch {
      /* ignore */
    }
  }, [native, locked, splashDone]);

  // Cover the app as soon as splash is done and we need unlock — no white gap
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.classList.add("d4-fp-lock-active");
    return () => {
      document.body.style.overflow = prev;
      document.documentElement.style.overflow = "";
      document.body.classList.remove("d4-fp-lock-active");
    };
  }, [locked]);

  if (!locked || isPublicAuthPath) {
    try {
      document.body.classList.remove("d4-fp-lock-active");
      document.body.style.pointerEvents = "";
      document.documentElement.style.pointerEvents = "";
    } catch {
      /* ignore */
    }
    return null;
  }
  // Never return a blank navy: if splash is slow, still render unlock UI

  const role = (session?.role || lastKnownRole()) as AppRole | null;
  const isSuperAdmin = role === "super_admin";
  const RoleIcon = roleIcon(role);
  const label = roleLabel(role);

  const cachedBrand = readCachedSchoolBrand(session?.schoolId);
  const schoolName = isSuperAdmin
    ? null
    : session?.schoolName || cachedBrand?.name || null;
  const schoolLogo =
    !isSuperAdmin && !logoBroken
      ? session?.schoolLogoUrl || cachedBrand?.logoUrl || null
      : null;

  const name = displayName(session?.fullName);


  return createPortal(
    <div
      data-d4-lock-gate=""
      className="d4-fp-lock-overlay"
      onMouseDown={(e) => {
        const el = e.target as HTMLElement | null;
        if (el && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "BUTTON") {
          const input = e.currentTarget.querySelector<HTMLInputElement>('input[data-d4-lock-input]');
          input?.focus();
        }
      }}
      onKeyDownCapture={(e) => {
        const ae = document.activeElement as HTMLElement | null;
        if (ae && !ae.closest?.("[data-d4-lock-gate]")) {
          e.preventDefault();
          e.stopPropagation();
          const input = (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input[data-d4-lock-input]");
          input?.focus();
        }
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: "100%",
        height: "100%",
        minWidth: "100vw",
        minHeight: "100vh",
        maxWidth: "100vw",
        maxHeight: "100vh",
        inset: 0,
        margin: 0,
        padding: 0,
        zIndex: 2147483000,
        backgroundColor: THEME_NAVY,
        background: THEME_NAVY,
        WebkitBackfaceVisibility: "hidden",
        boxSizing: "border-box",
        overflowY: "auto",
        overflowX: "hidden",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        WebkitOverflowScrolling: "touch",
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Unlock with fingerprint"
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 30%, rgba(37,99,235,0.22) 0%, transparent 58%)",
        }}
      />

      <div
        className="relative z-10 flex w-full max-w-lg flex-col items-center justify-between md:max-w-xl lg:max-w-2xl"
        style={{
          flex: 1,
          width: "100%",
          minHeight: "100%",
          paddingTop: "max(1.25rem, env(safe-area-inset-top, 0px))",
          paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))",
          paddingLeft: "max(1.25rem, env(safe-area-inset-left, 0px))",
          paddingRight: "max(1.25rem, env(safe-area-inset-right, 0px))",
          boxSizing: "border-box",
        }}
      >
        <div className="flex w-full flex-col items-center pt-4 md:pt-8">
          {/* Logo — no white plate */}
          <div className="flex shrink-0 justify-center">
            {schoolLogo ? (
              <img
                src={schoolLogo}
                alt={schoolName || "School"}
                className="h-[min(22vw,92px)] w-[min(22vw,92px)] object-contain md:h-28 md:w-28 lg:h-32 lg:w-32"
                style={{ background: "transparent" }}
                onError={() => setLogoBroken(true)}
              />
            ) : (
              <div
                className="grid h-[min(22vw,92px)] w-[min(22vw,92px)] place-items-center rounded-full border border-[#2563eb]/40 md:h-28 md:w-28 lg:h-32 lg:w-32"
                style={{ backgroundColor: "transparent" }}
              >
                <img src="/logo.png" alt="D4EXAM" className="h-[70%] w-[70%] object-contain" />
              </div>
            )}
          </div>

          {/* School name directly under logo */}
          {!isSuperAdmin && schoolName ? (
            <p className="mt-3 max-w-[18rem] text-center text-sm font-medium leading-snug text-slate-300 md:max-w-md md:text-base">
              {schoolName}
            </p>
          ) : null}

          {/* Role badge */}
          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-slate-100 backdrop-blur-sm md:px-4 md:py-2 md:text-sm">
            <RoleIcon className="h-3.5 w-3.5 text-blue-300 md:h-4 md:w-4" aria-hidden />
            {label}
          </div>

          {/* User name */}
          <h1 className="mt-2 max-w-[90vw] text-center text-[clamp(1rem,4.2vw,1.5rem)] font-bold leading-snug tracking-tight text-white md:text-2xl lg:text-3xl">
            {name}
          </h1>
        </div>

        {mode === "password" ? (
          <div className="flex w-full max-w-sm flex-col items-center px-2 py-4 md:max-w-md md:py-6">
            <h2 className="text-lg font-bold text-white sm:text-xl md:text-2xl">Unlock D4EXAM</h2>
            <p className="mt-1 text-center text-sm text-slate-400 md:text-base">Enter your app password</p>
            <input
              data-d4-lock-input=""
              type="password"
              name="d4-app-unlock"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={appPw}
              onChange={(e) => setAppPw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void unlockWithAppPassword();
              }}
              className="mt-5 w-full rounded-xl border border-white/15 bg-white/10 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-blue-400 md:py-3.5 md:text-base"
              placeholder="App password"
            />
            {pwError ? <p className="mt-2 text-center text-xs font-semibold text-amber-300 md:text-sm">{pwError}</p> : null}
            <button
              type="button"
              disabled={pwBusy || !appPw}
              onClick={() => void unlockWithAppPassword()}
              className="mt-4 w-full rounded-xl bg-blue-600 py-3 text-sm font-bold text-white disabled:opacity-50 md:py-3.5 md:text-base"
            >
              {pwBusy ? "Unlocking…" : "Unlock"}
            </button>
            <button
              type="button"
              onClick={() => {
                // Release lock so the forgot page is not covered / bounced away
                setLocked(false);
                setFingerprintLocked(false);
                try {
                  window.location.assign("/forgot-app-password");
                } catch {
                  window.location.href = "/forgot-app-password";
                }
              }}
              className="mt-3 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
            >
              Forgot app password?
            </button>
            {hwState !== "no" ? (
              <button
                type="button"
                onClick={showFingerprintMode}
                className="mt-2 text-sm font-medium text-slate-400 hover:text-white"
              >
                Use fingerprint
              </button>
            ) : null}
          </div>
        ) : (
        <div className="flex flex-col items-center justify-center py-4 sm:py-6">
          <button
            type="button"
            aria-label="Use fingerprint"
            onClick={() => {
              if (runningRef.current) return;
              promptedRef.current = false;
              void tryUnlock();
            }}
            className="d4-fp-btn-3d relative grid h-[min(132px,30vw)] w-[min(132px,30vw)] place-items-center rounded-full focus:outline-none"
            style={{
              background: "radial-gradient(circle at 50% 40%, #1e3a8a 0%, #0b1b3a 70%)",
              border: "2px solid rgba(59,130,246,0.55)",
            }}
          >
            {/* Always-on expanding rings (show clickable) */}
            <span className="d4-fp-ring-anim pointer-events-none absolute inset-[-6px] rounded-full border-2 border-[#3b82f6]/50" />
            <span className="d4-fp-ring-anim-delay pointer-events-none absolute inset-[-14px] rounded-full border border-[#60a5fa]/35" />
            <span
              className={cn(
                "absolute inset-0 rounded-full border-[2.5px] border-[#2563eb]/50",
              )}
            />
            <span className="absolute inset-[12px] rounded-full border border-[#3b82f6]/40" />
            <span
              className="absolute inset-[22px] rounded-full"
              style={{
                backgroundColor: "rgba(11,27,58,0.92)",
                boxShadow: "inset 0 2px 8px rgba(0,0,0,0.45), 0 0 36px rgba(37,99,235,0.4)",
              }}
            />
            {/* Scan beam only while OS prompt is active */}
            {status === "scanning" ? (
              <span
                className="pointer-events-none absolute left-[26px] right-[26px] z-20 h-1.5 rounded-full bg-gradient-to-r from-transparent via-sky-300 to-transparent"
                style={{ animation: "d4-fp-scan 1.35s ease-in-out infinite" }}
              />
            ) : null}
            <Fingerprint
              className={cn(
                "relative z-10 h-[min(56px,14vw)] w-[min(56px,14vw)]",
                status === "success"
                  ? "text-emerald-400"
                  : status === "failed"
                    ? "text-amber-300"
                    : "text-[#60a5fa]",
              )}
              strokeWidth={1.4}
            />
          </button>

          <p className="mt-7 text-center text-lg font-semibold text-white">
            {status === "success"
              ? "Fingerprint verified"
              : status === "scanning"
                ? "Waiting for fingerprint…"
                : "Use your fingerprint"}
          </p>
          <p className="mt-2 max-w-[17rem] text-center text-sm leading-relaxed text-slate-400">
            {failedMsg || unlockHint()}
          </p>
        </div>

        )}

        <div className="flex w-full shrink-0 items-center justify-between gap-2 px-1 pb-2">
          <button
            type="button"
            onClick={() => setLogoutConfirm(true)}
            className="inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/15 hover:text-red-300 md:px-4 md:py-2.5 md:text-base"
          >
            <LogOut className="h-4 w-4 md:h-5 md:w-5" aria-hidden />
            Log out
          </button>
          {mode === "fingerprint" ? (
            <button
              type="button"
              onClick={showPasswordMode}
              className="inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white md:px-4 md:py-2.5 md:text-base"
            >
              Use password
            </button>
          ) : hwState !== "no" ? (
            <button
              type="button"
              onClick={showFingerprintMode}
              className="inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white md:px-4 md:py-2.5 md:text-base"
            >
              Use fingerprint
            </button>
          ) : (
            <span />
          )}
        </div>


        {offerEnableFp ? (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0f1f3d] p-5 text-center shadow-2xl">
              <p className="text-base font-bold text-white">Enable fingerprint unlock?</p>
              <p className="mt-2 text-sm text-slate-400">
                Unlock D4EXAM faster next time with your fingerprint. You can change this later in Settings.
              </p>
              <div className="mt-5 flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm font-semibold text-slate-200"
                  disabled={enableFpBusy}
                  onClick={() => setOfferEnableFp(false)}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={enableFpBusy}
                  onClick={() => {
                    void (async () => {
                      if (!userId) return;
                      setEnableFpBusy(true);
                      try {
                        const auth = await authenticateWithFingerprint({
                          reason: "Enable fingerprint unlock for D4EXAM",
                          title: "D4EXAM",
                          subtitle: "Confirm with your fingerprint",
                        });
                        if (auth.ok) {
                          enableFingerprintFor(userId);
                          setOfferEnableFp(false);
                        }
                      } finally {
                        setEnableFpBusy(false);
                      }
                    })();
                  }}
                >
                  {enableFpBusy ? "…" : "Enable"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {logoutConfirm ? (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0f1f3d] p-5 text-center shadow-2xl">
              <p className="text-base font-bold text-white">Log out of D4EXAM?</p>
              <p className="mt-2 text-sm text-slate-400">
                You will need your school credentials to sign in again.
              </p>
              <div className="mt-5 flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm font-semibold text-slate-200"
                  onClick={() => setLogoutConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white"
                  onClick={() => void confirmLogout()}
                >
                  Log out
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <style>{`
        @keyframes d4-fp-scan {
          0% { top: 26%; opacity: 0.35; }
          50% { top: 70%; opacity: 1; }
          100% { top: 26%; opacity: 0.35; }
        }
        @keyframes d4-fp-ring {
          0% { transform: scale(1); opacity: 0.55; }
          70% { transform: scale(1.2); opacity: 0; }
          100% { transform: scale(1.2); opacity: 0; }
        }
        @keyframes d4-fp-pulse3d {
          0% { transform: scale(1); box-shadow: 0 10px 0 #1e3a8a, 0 14px 32px rgba(37,99,235,0.4); }
          50% { transform: scale(0.96); box-shadow: 0 4px 0 #1e3a8a, 0 8px 18px rgba(37,99,235,0.5); }
          100% { transform: scale(1); box-shadow: 0 10px 0 #1e3a8a, 0 14px 32px rgba(37,99,235,0.4); }
        }
        .d4-fp-ring-anim { animation: d4-fp-ring 2.2s ease-out infinite; }
        .d4-fp-ring-anim-delay { animation: d4-fp-ring 2.2s ease-out 0.75s infinite; }
        .d4-fp-btn-3d {
          animation: d4-fp-pulse3d 1.85s ease-in-out infinite;
        }
        .d4-fp-btn-3d:active {
          animation: none !important;
          transform: scale(0.92) translateY(5px) !important;
          box-shadow: 0 2px 0 #1e3a8a, 0 4px 12px rgba(37,99,235,0.35) !important;
        }
      `}</style>
    </div>,
    document.body,
  );
}
