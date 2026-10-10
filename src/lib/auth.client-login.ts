// @ts-nocheck
/**
 * Client-side school login for native Capacitor shell (no TanStack server fn).
 * Uses public Supabase anon key + RPCs already granted to anon/authenticated.
 */
import { supabase } from "@/integrations/supabase/client";

function looksLikeEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** After auth, user must belong to the resolved school (or be super admin). */
async function assertSchoolMembership(
  userId: string,
  schoolId: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, school_id")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (profile?.school_id && String(profile.school_id) === String(schoolId)) {
      return { ok: true };
    }

    const profileId = profile?.id ? String(profile.id) : null;
    const { data: roles } = await supabase
      .from("user_roles")
      .select("id, school_id, role")
      .or(
        profileId
          ? `user_id.eq.${userId},user_id.eq.${profileId}`
          : `user_id.eq.${userId}`,
      )
      .limit(20);

    const match = (roles || []).some(
      (r) => r.school_id && String(r.school_id) === String(schoolId),
    );
    if (match) return { ok: true };
  } catch (e) {
    console.warn("[client-login] membership check", e);
  }

  // Not a member of this school — reject
  try {
    await supabase.auth.signOut();
  } catch {
    /* ignore */
  }
  return {
    error:
      "Invalid login details for this school. Check school code, email / ID, and password.",
  };
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

  // Super admin / plain email path
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

  // Resolve school via public RPC (with direct-table fallback)
  let schoolId: string | null = null;
  let schoolResolveError: string | null = null;
  try {
    const { data: rpcSchool, error: schoolErr } = await supabase.rpc(
      "resolve_school_for_login",
      { _school_code: schoolCode },
    );
    if (schoolErr) {
      schoolResolveError = schoolErr.message || String(schoolErr);
      console.warn("[client-login] resolve_school", schoolResolveError);
    }
    const row = Array.isArray(rpcSchool) ? rpcSchool[0] : rpcSchool;
    if (row && typeof row === "object" && (row as { id?: string }).id) {
      schoolId = String((row as { id: string }).id);
    }
  } catch (e) {
    schoolResolveError = e instanceof Error ? e.message : String(e);
    console.warn("[client-login] school rpc", e);
  }

  // Fallback: direct schools lookup (RPC may fail if apikey was wrong mid-session)
  if (!schoolId) {
    try {
      const { data: schoolRow, error: sErr } = await supabase
        .from("schools")
        .select("id, school_code, status")
        .ilike("school_code", schoolCode)
        .limit(1)
        .maybeSingle();
      if (sErr) {
        schoolResolveError = schoolResolveError || sErr.message;
      } else if (schoolRow?.id) {
        const st = String(schoolRow.status || "active").toLowerCase();
        if (["active", "approved", "live"].includes(st)) {
          schoolId = String(schoolRow.id);
        }
      }
    } catch (e) {
      schoolResolveError =
        schoolResolveError || (e instanceof Error ? e.message : String(e));
    }
  }

  if (!schoolId) {
    const msg = (schoolResolveError || "").toLowerCase();
    if (msg.includes("invalid api key") || msg.includes("jwt") || msg.includes("apikey")) {
      return {
        error:
          "Connection error (Invalid API key). Force-close the app, clear cache, and try again.",
      };
    }
    if (schoolResolveError && !msg.includes("permission") && !msg.includes("rls")) {
      return { error: `Could not verify school code: ${schoolResolveError}` };
    }
    return { error: "School code not found. Check and try again." };
  }

  // Email login within school
  if (looksLikeEmail(ident)) {
    const { data: signIn, error } = await supabase.auth.signInWithPassword({
      email: ident.toLowerCase(),
      password,
    });
    if (error || !signIn?.session || !signIn.user) {
      return { error: error?.message || "Invalid email or password." };
    }
    const member = await assertSchoolMembership(signIn.user.id, schoolId);
    if ("error" in member) return member;
    return {
      ok: true,
      accessToken: signIn.session.access_token,
      refreshToken: signIn.session.refresh_token,
      userId: signIn.user.id,
      schoolId,
      schoolCode,
    };
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
        if (error || !signIn?.session || !signIn.user) {
          return { error: error?.message || "Invalid credentials." };
        }
        const member = await assertSchoolMembership(signIn.user.id, schoolId);
        if ("error" in member) return member;
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
  if (error || !signIn?.session || !signIn.user) {
    return {
      error:
        error?.message ||
        "Invalid credentials. If this is your first login, ask your school to provision your account online first.",
    };
  }
  const member = await assertSchoolMembership(signIn.user.id, schoolId);
  if ("error" in member) return member;
  return {
    ok: true,
    accessToken: signIn.session.access_token,
    refreshToken: signIn.session.refresh_token,
    userId: signIn.user.id,
    schoolId,
    schoolCode,
  };
}
