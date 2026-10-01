import { supabase } from "@/integrations/supabase/client";
import { clientSignInWithSchoolCode } from "@/lib/auth.client-login";
import { isNativeShell } from "@/native/platform";
import { offlineRemove, OfflineKeys } from "@/lib/offline-cache";

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
      role?: string | null;
    }
  | { ok: false; error: string };

const ROLE_PRIORITY = [
  "super_admin",
  "school_admin",
  "examination_officer",
  "teacher",
  "student",
] as const;

/** After tokens exist, resolve primary role + school for instant redirect. */
export async function resolveRoleAfterSession(userId: string): Promise<{
  role: string;
  schoolId: string | null;
}> {
  const roles: string[] = [];
  let schoolId: string | null = null;

  try {
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("role, school_id")
      .eq("user_id", userId)
      .limit(20);
    for (const r of roleRows ?? []) {
      if (r.role) roles.push(String(r.role).toLowerCase());
      if (!schoolId && r.school_id) schoolId = String(r.school_id);
    }
  } catch {
    /* ignore */
  }

  try {
    const { data: prof } = await supabase
      .from("profiles")
      .select("id, school_id")
      .or(`auth_user_id.eq.${userId},id.eq.${userId}`)
      .maybeSingle();
    if (prof?.school_id && !schoolId) schoolId = String(prof.school_id);
    const pid = prof?.id ? String(prof.id) : null;
    if (pid && pid !== userId) {
      try {
        const { data: roleRows2 } = await supabase
          .from("user_roles")
          .select("role, school_id")
          .eq("user_id", pid)
          .limit(20);
        for (const r of roleRows2 ?? []) {
          if (r.role) roles.push(String(r.role).toLowerCase());
          if (!schoolId && r.school_id) schoolId = String(r.school_id);
        }
      } catch {
        /* ignore */
      }
    }
    if (pid) {
      try {
        const { data: eo } = await supabase
          .from("examination_officers")
          .select("school_id")
          .eq("profile_id", pid)
          .maybeSingle();
        if (eo?.school_id) {
          if (!schoolId) schoolId = String(eo.school_id);
          if (!roles.includes("examination_officer")) roles.push("examination_officer");
        }
      } catch {
        /* ignore */
      }
      try {
        const { data: te } = await supabase
          .from("teachers")
          .select("school_id")
          .eq("profile_id", pid)
          .maybeSingle();
        if (te?.school_id) {
          if (!schoolId) schoolId = String(te.school_id);
          if (!roles.includes("teacher")) roles.push("teacher");
        }
      } catch {
        /* ignore */
      }
      try {
        const { data: st } = await supabase
          .from("students")
          .select("school_id")
          .eq("profile_id", pid)
          .maybeSingle();
        if (st?.school_id) {
          if (!schoolId) schoolId = String(st.school_id);
          if (!roles.includes("student")) roles.push("student");
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const { data: myRoles } = await supabase.rpc("get_my_roles");
    if (Array.isArray(myRoles)) {
      for (const r of myRoles) {
        const role = typeof r === "string" ? r : String((r as { role?: string }).role || "");
        if (role) roles.push(role.toLowerCase());
      }
    }
  } catch {
    /* ignore */
  }

  const unique = [...new Set(roles.map((r) => r.toLowerCase()))];
  const role = ROLE_PRIORITY.find((r) => unique.includes(r)) || unique[0] || "examination_officer";
  return { role, schoolId };
}

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

  let accessToken = "";
  let refreshToken = "";
  let userId: string | undefined;
  let schoolId: string | null = null;
  let codeOut: string | null = schoolCode || null;

  const nativeResult = await clientSignInWithSchoolCode({
    schoolCode: schoolCode || "",
    identifier: ident,
    password: pass,
  });
  if (nativeResult && "ok" in nativeResult && nativeResult.ok && nativeResult.accessToken) {
    accessToken = nativeResult.accessToken;
    refreshToken = nativeResult.refreshToken || "";
    userId = nativeResult.userId;
    schoolId = nativeResult.schoolId ?? null;
    codeOut = nativeResult.schoolCode || schoolCode || null;
  } else if (looksEmail) {
    const { data: direct, error: directErr } = await supabase.auth.signInWithPassword({
      email: ident.toLowerCase(),
      password: pass,
    });
    if (directErr || !direct?.session?.access_token) {
      return {
        ok: false,
        error:
          directErr?.message ||
          (nativeResult && "error" in nativeResult ? String(nativeResult.error) : "") ||
          "Invalid credentials.",
      };
    }
    accessToken = direct.session.access_token;
    refreshToken = direct.session.refresh_token || "";
    userId = direct.user?.id;
  } else {
    return {
      ok: false,
      error:
        (nativeResult && "error" in nativeResult && nativeResult.error
          ? String(nativeResult.error)
          : "") || "Invalid credentials.",
    };
  }

  try {
    await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch {
    /* still return tokens */
  }

  // Drop stale offline null student context so dashboard can refill from network
  if (userId) {
    try {
      await offlineRemove(userId, OfflineKeys.studentContext);
      await offlineRemove(userId, OfflineKeys.studentResults);
      await offlineRemove(userId, OfflineKeys.studentExams);
      await offlineRemove(userId, OfflineKeys.sessionUser);
    } catch {
      /* ignore */
    }
  }

  let role: string | null = null;
  if (userId) {
    try {
      const resolved = await Promise.race([
        resolveRoleAfterSession(userId),
        new Promise<{ role: string; schoolId: string | null }>((resolve) =>
          setTimeout(() => resolve({ role: "student", schoolId }), 4_000),
        ),
      ]);
      role = resolved.role;
      if (!schoolId && resolved.schoolId) schoolId = resolved.schoolId;
    } catch {
      role = "student";
    }
  }

  return {
    ok: true,
    accessToken,
    refreshToken,
    schoolId,
    schoolCode: codeOut,
    userId,
    role,
  };
}
