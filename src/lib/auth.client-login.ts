/**
 * Client-side school login for native Capacitor shell (no TanStack server fn).
 * Uses public Supabase anon key + RPCs already granted to anon/authenticated.
 */
import { supabase } from "@/integrations/supabase/client";

function looksLikeEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export type ClientLoginInput = {
  schoolCode: string;
  identifier: string;
  password: string;
};

export type ClientLoginResult =
  | { error: string }
  | {
      ok: true;
      accessToken?: string;
      refreshToken?: string;
      userId?: string;
      schoolId?: string | null;
      schoolCode?: string | null;
    };

async function resolveSchoolId(schoolCode: string): Promise<string | null> {
  const code = schoolCode.trim().toUpperCase();
  if (!code) return null;
  try {
    const { data: rpcSchool, error: schoolErr } = await supabase.rpc(
      "resolve_school_for_login",
      { _school_code: code },
    );
    if (schoolErr) console.warn("[client-login] resolve_school", schoolErr.message);
    const row = Array.isArray(rpcSchool) ? rpcSchool[0] : rpcSchool;
    if (row && typeof row === "object" && (row as { id?: string }).id) {
      return String((row as { id: string }).id);
    }
  } catch (e) {
    console.warn("[client-login] school rpc", e);
  }
  return null;
}

export async function clientSignInWithSchoolCode(
  data: ClientLoginInput,
): Promise<ClientLoginResult> {
  const schoolCode = (data.schoolCode ?? "").trim().toUpperCase();
  const ident = (data.identifier || "").trim();
  const password = data.password || "";
  if (!ident || !password) {
    return { error: "Enter your email / matric / staff ID and password." };
  }

  const isSuperCode =
    schoolCode === "" || schoolCode === "SUPER" || schoolCode === "PLATFORM";

  // Super admin / plain email path (no school code required)
  if (looksLikeEmail(ident) && isSuperCode) {
    const { data: signIn, error } = await supabase.auth.signInWithPassword({
      email: ident.toLowerCase(),
      password,
    });
    if (error || !signIn?.session || !signIn?.user) {
      return { error: error?.message || "Invalid email or password." };
    }
    return {
      ok: true,
      accessToken: signIn.session.access_token,
      refreshToken: signIn.session.refresh_token,
      userId: signIn.user.id,
      schoolId: null,
      schoolCode: null,
    };
  }

  if (!schoolCode) {
    return { error: "Enter your school code." };
  }

  let schoolId = await resolveSchoolId(schoolCode);

  // Email login within school — auth first even if school RPC is slow/missing;
  // school context is repaired after session from profile.
  if (looksLikeEmail(ident)) {
    const { data: signIn, error } = await supabase.auth.signInWithPassword({
      email: ident.toLowerCase(),
      password,
    });
    if (error || !signIn?.session) {
      return { error: error?.message || "Invalid email or password." };
    }
    // Prefer resolved school; else try again after auth (profile may reveal school)
    if (!schoolId) {
      schoolId = await resolveSchoolId(schoolCode);
    }
    return {
      ok: true,
      accessToken: signIn.session.access_token,
      refreshToken: signIn.session.refresh_token,
      userId: signIn.user.id,
      schoolId,
      schoolCode,
    };
  }

  // Matric / staff ID path needs a school id to resolve email
  if (!schoolId) {
    return { error: "School code not found. Check and try again." };
  }

  // Matric / staff ID → resolve login email via RPC if available
  try {
    const { data: resolved, error: rErr } = await supabase.rpc("resolve_login_email", {
      _school_id: schoolId,
      _identifier: ident,
    });
    if (!rErr && resolved) {
      const email =
        typeof resolved === "string"
          ? resolved
          : Array.isArray(resolved)
            ? String((resolved[0] as { email?: string })?.email || resolved[0] || "")
            : String((resolved as { email?: string })?.email || "");
      if (email.includes("@")) {
        const { data: signIn, error } = await supabase.auth.signInWithPassword({
          email: email.toLowerCase(),
          password,
        });
        if (error || !signIn?.session) {
          return { error: error?.message || "Invalid credentials." };
        }
        return {
          ok: true,
          accessToken: signIn.session.access_token,
          refreshToken: signIn.session.refresh_token,
          userId: signIn.user.id,
          schoolId,
          schoolCode,
        };
      }
    }
  } catch (e) {
    console.warn("[client-login] resolve_login_email", e);
  }

  // Fallback synthetic student email pattern used by the platform
  const safeMatric = ident.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const safeCode = schoolCode.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const synthetic = `${safeMatric}@${safeCode || "school"}.student.d4exam.local`;
  const { data: signIn, error } = await supabase.auth.signInWithPassword({
    email: synthetic,
    password,
  });
  if (error || !signIn?.session) {
    return {
      error:
        error?.message ||
        "Invalid credentials. If this is your first login, ask your school to provision your account online first.",
    };
  }
  return {
    ok: true,
    accessToken: signIn.session.access_token,
    refreshToken: signIn.session.refresh_token,
    userId: signIn.user.id,
    schoolId,
    schoolCode,
  };
}
