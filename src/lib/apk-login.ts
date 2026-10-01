import { supabase } from "@/integrations/supabase/client";
import { clientSignInWithSchoolCode } from "@/lib/auth.client-login";
import { isNativeShell } from "@/native/platform";

/** APK / Capacitor SPA: never rely on stubbed server functions for login. */
export function shouldUseClientLoginOnly(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if ((window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA) return true;
  } catch {
    /* ignore */
  }
  try {
    const host = (window.location.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "") return true;
    if (window.location.protocol === "file:") return true;
  } catch {
    /* ignore */
  }
  try {
    if (isNativeShell()) return true;
  } catch {
    /* ignore */
  }
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (cap?.isNativePlatform?.()) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export type ApkLoginResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string;
      schoolId?: string | null;
      schoolCode?: string | null;
      userId?: string;
    }
  | { ok: false; error: string };

/** Pure client login for Capacitor SPA (server fns are stubs). */
export async function runApkClientLogin(input: {
  schoolCode: string;
  identifier: string;
  password: string;
}): Promise<ApkLoginResult> {
  const schoolCode = (input.schoolCode || "").trim().toUpperCase();
  const ident = (input.identifier || "").trim();
  const pass = input.password || "";
  const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ident);

  const nativeResult = await clientSignInWithSchoolCode({
    schoolCode: schoolCode || "",
    identifier: ident,
    password: pass,
  });
  if (nativeResult && "ok" in nativeResult && nativeResult.ok && nativeResult.accessToken) {
    return {
      ok: true,
      accessToken: nativeResult.accessToken,
      refreshToken: nativeResult.refreshToken || "",
      schoolId: nativeResult.schoolId,
      schoolCode: nativeResult.schoolCode || schoolCode,
      userId: nativeResult.userId,
    };
  }

  // Direct email Auth against d4exam-platform (same password grant as web)
  if (looksEmail) {
    const { data: direct, error: directErr } = await supabase.auth.signInWithPassword({
      email: ident.toLowerCase(),
      password: pass,
    });
    if (!directErr && direct?.session?.access_token) {
      return {
        ok: true,
        accessToken: direct.session.access_token,
        refreshToken: direct.session.refresh_token || "",
        schoolId: null,
        schoolCode: schoolCode || null,
        userId: direct.user?.id,
      };
    }
    return {
      ok: false,
      error:
        directErr?.message ||
        (nativeResult && "error" in nativeResult ? String(nativeResult.error) : "") ||
        "Invalid credentials.",
    };
  }

  return {
    ok: false,
    error:
      (nativeResult && "error" in nativeResult && nativeResult.error
        ? String(nativeResult.error)
        : "") || "Invalid credentials.",
  };
}
