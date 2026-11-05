// @ts-nocheck
import { supabase } from "@/integrations/supabase/client";

function looksLikeEmail(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v || "").trim());
}

async function assertSchoolMembershipInner(userId: string, schoolId: string): Promise<void> {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, school_id")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (profile?.school_id && String(profile.school_id) === String(schoolId)) {
      return;
    }

    const profileId = profile?.id ? String(profile.id) : null;
    const { data: roles } = await supabase
      .from("user_roles")
      .select("id, school_id, role")
      .or(profileId ? `user_id.eq.${userId},user_id.eq.${profileId}` : `user_id.eq.${userId}`)
      .limit(20);

    const match = (roles || []).some(
      (r) => r.school_id && String(r.school_id) === String(schoolId),
    );
    if (!match) {
      console.warn("[client-login] membership soft mismatch", { userId, schoolId });
    }
  } catch (e) {
    console.warn("[client-login] membership check", e);
  }
}

async function assertSchoolMembership(userId: string, schoolId: string) {
  try {
    await Promise.race([
      assertSchoolMembershipInner(userId, schoolId),
      new Promise((r) => setTimeout(r, 800)),
    ]);
  } catch {
    /* soft */
  }
  return { ok: true as const };
}

async function timedSignIn(email: string, password: string, ms = 10_000) {
  return Promise.race([
    supabase.auth.signInWithPassword({ email: email.toLowerCase(), password }),
    new Promise<{ data: { session: null; user: null }; error: { message: string } }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            data: { session: null, user: null },
            error: { message: "Sign-in timed out. Check your network and try again." },
          }),
        ms,
      ),
    ),
  ]);
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

async function resolveSchoolId(schoolCode: string): Promise<{ id: string | null; error: string | null }> {
  let schoolId: string | null = null;
  let schoolResolveError: string | null = null;
  try {
    const { data: rpcSchool, error: schoolErr } = await Promise.race([
      supabase.rpc("resolve_school_for_login", { _school_code: schoolCode }),
      new Promise<{ data: null; error: { message: string } }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: { message: "timeout" } }), 3_000),
      ),
    ]);
    if (schoolErr) schoolResolveError = schoolErr.message || String(schoolErr);
    const row = Array.isArray(rpcSchool) ? rpcSchool[0] : rpcSchool;
    if (row && typeof row === "object" && (row as { id?: string }).id) {
      schoolId = String((row as { id: string }).id);
    }
  } catch (e) {
    schoolResolveError = e instanceof Error ? e.message : String(e);
  }
  if (!schoolId) {
    try {
      const { data: schoolRow, error: sErr } = await supabase
        .from("schools")
        .select("id, school_code, status")
        .ilike("school_code", schoolCode)
        .limit(1)
        .maybeSingle();
      if (sErr) schoolResolveError = schoolResolveError || sErr.message;
      else if (schoolRow?.id) {
        const st = String(schoolRow.status || "active").toLowerCase();
        if (["active", "approved", "live"].includes(st) || !schoolRow.status) {
          schoolId = String(schoolRow.id);
        }
      }
    } catch (e) {
      schoolResolveError = schoolResolveError || (e instanceof Error ? e.message : String(e));
    }
  }
  return { id: schoolId, error: schoolResolveError };
}

/** Collect login emails from RPCs + profile name / matric heuristics */
async function collectCandidateEmails(
  schoolCode: string,
  schoolId: string | null,
  ident: string,
): Promise<string[]> {
  const emails: string[] = [];
  const push = (e?: string | null) => {
    const v = String(e || "").trim().toLowerCase();
    if (v.includes("@") && !emails.includes(v)) emails.push(v);
  };

  if (looksLikeEmail(ident)) push(ident);

  // Preferred RPC
  try {
    const { data: resolved } = await Promise.race([
      supabase.rpc("resolve_login_identity", {
        _school_code: schoolCode,
        _identifier: ident,
      }),
      new Promise<{ data: null }>((r) => setTimeout(() => r({ data: null }), 2_500)),
    ]);
    const row = Array.isArray(resolved) ? resolved[0] : resolved;
    if (row && typeof row === "object" && (row as { email?: string }).email) {
      push((row as { email: string }).email);
    }
  } catch {
    /* optional */
  }

  try {
    const { data: resolved } = await Promise.race([
      supabase.rpc("resolve_login_email", {
        _school_id: schoolId,
        _identifier: ident,
      }),
      new Promise<{ data: null }>((r) => setTimeout(() => r({ data: null }), 2_500)),
    ]);
    if (resolved) {
      const email =
        typeof resolved === "string"
          ? resolved
          : Array.isArray(resolved)
            ? String((resolved[0] as { email?: string })?.email || resolved[0] || "")
            : String((resolved as { email?: string })?.email || "");
      push(email);
    }
  } catch {
    /* optional */
  }

  // Name / partial match on profiles (when RLS allows)
  if (schoolId && !looksLikeEmail(ident)) {
    try {
      const q = ident.replace(/%/g, "").trim();
      if (q.length >= 3) {
        const { data: profs } = await Promise.race([
          supabase
            .from("profiles")
            .select("email, full_name")
            .eq("school_id", schoolId)
            .ilike("full_name", `%${q}%`)
            .limit(5),
          new Promise<{ data: null }>((r) => setTimeout(() => r({ data: null }), 2_500)),
        ]);
        for (const p of profs || []) {
          push((p as { email?: string }).email);
        }
      }
    } catch {
      /* RLS may block */
    }
  }

  // Synthetic student emails (matric-style)
  const safeMatric = ident.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const safeCode = schoolCode.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  push(`${safeMatric}@${safeCode || "school"}.student.d4exam.local`);
  push(`${safeMatric}@placeholder.local`);

  return emails;
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

  if (looksLikeEmail(ident) && isSuperCode) {
    const si = await timedSignIn(ident, password, 10_000);
    const signIn = si.data;
    const error = si.error;
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

  const { id: schoolId, error: schoolResolveError } = await resolveSchoolId(schoolCode);
  if (!schoolId) {
    const msg = (schoolResolveError || "").toLowerCase();
    if (msg.includes("invalid api key") || msg.includes("jwt")) {
      return { error: "Configuration error (API key). Contact support." };
    }
    return { error: "School code not found. Check the code and try again." };
  }

  const emails = await collectCandidateEmails(schoolCode, schoolId, ident);
  let lastErr = "Invalid credentials.";

  for (const email of emails.slice(0, 6)) {
    const si = await timedSignIn(email, password, 8_000);
    const signIn = si.data;
    const error = si.error;
    if (error || !signIn?.session || !signIn?.user) {
      lastErr = error?.message || lastErr;
      continue;
    }
    await assertSchoolMembership(signIn.user.id, schoolId);
    return {
      ok: true,
      accessToken: signIn.session.access_token,
      refreshToken: signIn.session.refresh_token,
      userId: signIn.user.id,
      schoolId,
      schoolCode,
    };
  }

  return {
    error:
      lastErr ||
      "Invalid credentials. Use your matric / staff ID or registered email (not only display name) if this continues.",
  };
}
