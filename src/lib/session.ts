// @ts-nocheck
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { offlineSet, OfflineKeys } from "@/lib/offline-cache";
import { rememberLastUserId, readLastUserId, withOfflineCache } from "@/lib/offline-query";
import { mirrorSessionUser } from "@/lib/local-db/mirror";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type AppRole =
  | "student"
  | "teacher"
  | "school_admin"
  | "examination_officer"
  | "super_admin";

const LAST_PATH_KEY = "d4exam_last_path_v1";
const LAST_ROLE_KEY = "d4exam_last_role_v1";
const PREFERRED_ROLE_KEY = "d4exam_preferred_role_v1";
/** School resolved at login (school code) — used when RPC/RLS lag on schoolId. */
const LOGIN_SCHOOL_KEY = "d4exam_login_school_v1";

export function seedLoginSchoolContext(schoolId: string | null | undefined, schoolCode?: string | null) {
  if (typeof window === "undefined" || !schoolId) return;
  try {
    window.localStorage.setItem(
      LOGIN_SCHOOL_KEY,
      JSON.stringify({
        schoolId: String(schoolId),
        schoolCode: schoolCode ? String(schoolCode).toUpperCase() : null,
        ts: Date.now(),
      }),
    );
  } catch {
    /* ignore */
  }
}

export function readLoginSchoolContext(): { schoolId: string; schoolCode: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOGIN_SCHOOL_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { schoolId?: string; schoolCode?: string | null; ts?: number };
    if (!p?.schoolId) return null;
    // Expire after 7 days
    if (p.ts && Date.now() - p.ts > 7 * 24 * 60 * 60 * 1000) return null;
    return { schoolId: String(p.schoolId), schoolCode: p.schoolCode ? String(p.schoolCode) : null };
  } catch {
    return null;
  }
}

export function clearLoginSchoolContext() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LOGIN_SCHOOL_KEY);
  } catch {
    /* ignore */
  }
}


/** Map an in-app pathname to AppRole when possible. */
export function roleFromPath(path: string | null | undefined): AppRole | null {
  const p = String(path || "").split("?")[0];
  if (p.startsWith("/student")) return "student";
  if (p.startsWith("/teacher")) return "teacher";
  if (p.startsWith("/officer")) return "examination_officer";
  if (p.startsWith("/admin")) return "school_admin";
  if (p.startsWith("/super-admin")) return "super_admin";
  return null;
}

/** Remember last in-app path so Capacitor relaunch restores role route. */
export function rememberLastPath(path: string, role?: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const p = (path || "").split("?")[0];
    if (
      !p ||
      p === "/" ||
      p === "/login" ||
      p.startsWith("/auth") ||
      p.startsWith("/about") ||
      p.startsWith("/pricing") ||
      p.startsWith("/privacy") ||
      p.startsWith("/support") ||
      p.startsWith("/features")
    ) {
      return;
    }
    window.localStorage.setItem(LAST_PATH_KEY, p);
    const known = ["student", "teacher", "school_admin", "examination_officer", "super_admin"];
    const fromArg = role && known.includes(String(role)) ? String(role) : null;
    const r = fromArg || roleFromPath(p);
    if (r) {
      window.localStorage.setItem(LAST_ROLE_KEY, r);
      window.localStorage.setItem(PREFERRED_ROLE_KEY, r);
    }
  } catch { /* ignore */ }
}

export function readLastPath(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const p = window.localStorage.getItem(LAST_PATH_KEY);
    if (!p || p === "/" || p === "/login") return null;
    return p;
  } catch {
    return null;
  }
}

export function readLastRole(): AppRole | null {
  if (typeof window === "undefined") return null;
  try {
    const r = window.localStorage.getItem(LAST_ROLE_KEY);
    const known = ["student", "teacher", "school_admin", "examination_officer", "super_admin"];
    if (r && known.includes(r)) return r as AppRole;
  } catch { /* ignore */ }
  return null;
}


const KNOWN_ROLES: AppRole[] = [
  "student",
  "teacher",
  "school_admin",
  "examination_officer",
  "super_admin",
];

/** Persist preferred role for multi-role accounts (does not change auth). */
export function setPreferredRole(role: AppRole | string | null | undefined): void {
  if (typeof window === "undefined") return;
  try {
    const r = String(role || "").trim();
    if (r && KNOWN_ROLES.includes(r as AppRole)) {
      window.localStorage.setItem(PREFERRED_ROLE_KEY, r);
      window.localStorage.setItem(LAST_ROLE_KEY, r);
    }
  } catch { /* ignore */ }
}

export function readPreferredRole(): AppRole | null {
  if (typeof window === "undefined") return null;
  try {
    const r = window.localStorage.getItem(PREFERRED_ROLE_KEY);
    if (r && KNOWN_ROLES.includes(r as AppRole)) return r as AppRole;
  } catch { /* ignore */ }
  return null;
}

export function clearPreferredRole(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREFERRED_ROLE_KEY);
  } catch { /* ignore */ }
}

/**
 * Switch active dashboard role for the current signed-in user.
 * Uses user_roles the account already has — no re-login.
 */
export async function switchActiveRole(role: AppRole | string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const target = String(role || "").trim() as AppRole;
  if (!KNOWN_ROLES.includes(target)) {
    return { ok: false, error: "Unknown role." };
  }
  const path = roleHome[target];
  if (!path) return { ok: false, error: "Unknown role." };

  setPreferredRole(target);
  seedPendingLoginRole(target);

  // Clear last path so we do not restore a different role's page
  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LAST_PATH_KEY);
    }
  } catch { /* ignore */ }

  // Soft-verify roles when online (non-blocking if offline)
  try {
    const user = await fetchSessionUser();
    if (user && Array.isArray(user.roles) && user.roles.length > 0 && !user.roles.includes(target)) {
      return { ok: false, error: "This account does not have that role." };
    }
  } catch {
    /* allow switch with preferred role even if network is slow */
  }

  if (typeof window !== "undefined") {
    window.location.replace(path);
  }
  return { ok: true, path };
}


export const roleHome: Record<AppRole, string> = {
  student: "/student",
  teacher: "/teacher",
  school_admin: "/admin",
  examination_officer: "/officer",
  super_admin: "/super-admin",
};

const SCHOOL_BRAND_KEY = "d4exam_school_brand_v1";
function seedSchoolBrandFromSession(schoolId?: string | null, name?: string | null, logoUrl?: string | null) {
  if (typeof window === "undefined" || !schoolId) return;
  if (!name && !logoUrl) return;
  try {
    window.localStorage.setItem(SCHOOL_BRAND_KEY, JSON.stringify({ id: schoolId, name: name || null, logoUrl: logoUrl || null, ts: Date.now() }));
  } catch {}
}

/** Cached school logo/name for offline / exam gate when live query is slow. */
export function readCachedSchoolBrand(schoolId?: string | null): { id?: string; name?: string | null; logoUrl?: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SCHOOL_BRAND_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: string; name?: string | null; logoUrl?: string | null; ts?: number };
    if (schoolId && parsed.id && parsed.id !== schoolId) return null;
    if (parsed.ts && Date.now() - parsed.ts > 30 * 24 * 60 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface SessionUser {
  userId: string;
  profileId: string;
  email: string;
  fullName: string;
  status: string;
  schoolId: string | null;
  schoolName: string | null;
  schoolCode: string | null;
  schoolLogoUrl: string | null;
  /** Public profile photo URL when set */
  avatarUrl: string | null;
  roles: AppRole[];
  role: AppRole | null;
  identifier: string | null;
  identifierLabel: string;
}

const PENDING_ROLE_KEY = "d4_pending_role";
const PENDING_ROLE_TS_KEY = "d4_pending_role_ts";

export function seedPendingLoginRole(role: AppRole | string | null | undefined): void {
  if (typeof window === "undefined" || !role) return;
  const value = String(role);
  const ts = String(Date.now());
  try {
    window.sessionStorage.setItem(PENDING_ROLE_KEY, value);
    window.sessionStorage.setItem(PENDING_ROLE_TS_KEY, ts);
  } catch {}
  try {
    window.localStorage.setItem(PENDING_ROLE_KEY, value);
    window.localStorage.setItem(PENDING_ROLE_TS_KEY, ts);
  } catch {}
}

function readPendingFrom(store: Storage | undefined, maxAgeMs: number): AppRole | null {
  if (!store) return null;
  try {
    const role = store.getItem(PENDING_ROLE_KEY);
    const ts = Number(store.getItem(PENDING_ROLE_TS_KEY) || 0);
    if (!role || !ts || Date.now() - ts > maxAgeMs) return null;
    if (role in roleHome) return role as AppRole;
  } catch {}
  return null;
}

export function readPendingLoginRole(maxAgeMs = 90_000): AppRole | null {
  if (typeof window === "undefined") return null;
  return readPendingFrom(window.sessionStorage, maxAgeMs) || readPendingFrom(window.localStorage, maxAgeMs);
}

export function clearPendingLoginRole(): void {
  if (typeof window === "undefined") return;
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      store.removeItem(PENDING_ROLE_KEY);
      store.removeItem(PENDING_ROLE_TS_KEY);
    } catch {}
  }
}

export async function confirmSessionReady(maxAttempts = 12): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { data: sess } = await supabase.auth.getSession();
      if (sess.session?.access_token && sess.session.user?.id) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100 * (i + 1)));
  }
  try {
    const { data } = await supabase.auth.getUser();
    return Boolean(data.user?.id);
  } catch {
    return false;
  }
}

type SessionContextRpc = {
  profile_id?: string | null;
  full_name?: string | null;
  email?: string | null;
  status?: string | null;
  school_id?: string | null;
  roles?: string[] | null;
  officer_id?: string | null;
  staff_id?: string | null;
  matric?: string | null;
};

function displayNameFromProfile(p: {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
} | null): string {
  if (!p) return "";
  const full = (p.full_name || "").trim();
  if (full) return full;
  return `${p.first_name || ""} ${p.last_name || ""}`.trim();
}

export async function fetchSessionUser(): Promise<SessionUser | null> {
  let user: { id: string; email?: string | null } | null = null;
  try {
    const { data: sessData } = await supabase.auth.getSession();
    if (sessData.session?.user) user = sessData.session.user;
  } catch {}
  if (!user) {
    try {
      const { data: userData } = await supabase.auth.getUser();
      user = userData.user;
    } catch {}
  }
  if (!user) {
    try {
      const { data: sessData } = await supabase.auth.getSession();
      if (sessData.session?.user) user = sessData.session.user;
    } catch {}
  }
  if (!user) return null;

  // FAST: RPC (retry) + profiles/roles in parallel — schoolId must resolve for dashboards
  let rpcCtx: SessionContextRpc | null = null;
  let profileByAuth: { data: Record<string, unknown> | null } = { data: null };
  let profileById: { data: Record<string, unknown> | null } = { data: null };
  let roleRes: { data: { role: string; school_id: string | null; user_id: string }[] | null } = { data: null };
  try {
    // Retry session RPC — first paint after login often races auth.uid()
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rpcData = await withTimeout(
          supabase.rpc("get_my_session_context" as never).then((r) => {
            if (r.error) console.warn("[session] rpc", r.error.message);
            return r.data;
          }),
          2500,
          "get_my_session_context",
        );
        if (rpcData && typeof rpcData === "object") {
          rpcCtx = rpcData as SessionContextRpc;
          if (rpcCtx.school_id || (Array.isArray(rpcCtx.roles) && rpcCtx.roles.length) || rpcCtx.profile_id) {
            break;
          }
        }
      } catch (e) {
        console.warn("[session] rpc attempt", attempt, e);
      }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }

    const triple = await withTimeout(
      Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, first_name, last_name, email, status, school_id, auth_user_id, profile_photo_url")
          .eq("auth_user_id", user.id)
          .maybeSingle(),
        supabase
          .from("profiles")
          .select("id, full_name, first_name, last_name, email, status, school_id, auth_user_id, profile_photo_url")
          .eq("id", user.id)
          .maybeSingle(),
        supabase.from("user_roles").select("role, school_id, user_id").eq("user_id", user.id),
      ]),
      2500,
      "profiles+roles",
    ).catch(() => null);
    if (triple) {
      profileByAuth = triple[0] as typeof profileByAuth;
      profileById = triple[1] as typeof profileById;
      roleRes = triple[2] as typeof roleRes;
    }
  } catch (e) {
    console.warn("[session] parallel resolve failed", e);
  }

  if (rpcCtx?.profile_id && !(profileByAuth.data || profileById.data)) {
    profileByAuth = {
      data: {
        id: rpcCtx.profile_id,
        full_name: rpcCtx.full_name ?? null,
        first_name: null,
        last_name: null,
        email: rpcCtx.email ?? user.email ?? null,
        status: rpcCtx.status ?? "active",
        school_id: rpcCtx.school_id ?? null,
        auth_user_id: user.id,
      },
    };
  }

  let profile = profileByAuth.data ?? profileById.data ?? null;
  if (!profile && rpcCtx?.profile_id) {
    profile = {
      id: rpcCtx.profile_id,
      full_name: rpcCtx.full_name ?? null,
      first_name: null,
      last_name: null,
      email: rpcCtx.email ?? user.email ?? null,
      status: rpcCtx.status ?? "active",
      school_id: rpcCtx.school_id ?? null,
      auth_user_id: user.id,
    } as never;
  }
  let roles = (roleRes.data ?? []).map((r) => r.role as AppRole).filter(Boolean);
  if (Array.isArray(rpcCtx?.roles) && rpcCtx.roles.length) {
    roles = [...new Set([...roles, ...(rpcCtx.roles as AppRole[])])];
  }

  if (roles.length === 0) {
    try {
      const { data: myRoles } = await supabase.rpc("get_my_roles");
      if (Array.isArray(myRoles) && myRoles.length) {
        roles = myRoles
          .map((r: { role?: string } | string) =>
            (typeof r === "string" ? r : String((r as { role?: string }).role || "")) as AppRole,
          )
          .filter(Boolean);
      }
    } catch {}
  }
  if (!roles.includes("super_admin")) {
    try {
      const { data: isSuper } = await supabase.rpc("is_super_admin");
      if (isSuper === true) {
        roles = ["super_admin", ...roles.filter((r) => r !== "super_admin")];
      }
    } catch {}
  }
  if (roles.length === 0) {
    const pending = readPendingLoginRole();
    if (pending) roles = [pending];
  }

  let schoolId: string | null =
    (rpcCtx?.school_id ? String(rpcCtx.school_id) : null) ||
    (profile?.school_id ? String(profile.school_id as string) : null) ||
    (roleRes.data ?? []).map((r) => (r as { school_id?: string | null }).school_id).find(Boolean) ||
    null;

  // Resolve profile id reliably (auth uid ≠ profiles.id in many rows)
  let resolvedPid: string | null =
    (rpcCtx?.profile_id ? String(rpcCtx.profile_id) : null) ||
    (profile?.id ? String(profile.id as string) : null) ||
    null;

  if (!resolvedPid) {
    try {
      const { data: p2 } = await supabase
        .from("profiles")
        .select("id, school_id, full_name, email, status")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (p2?.id) {
        resolvedPid = String(p2.id);
        if (!profile) profile = p2 as never;
        if (!schoolId && p2.school_id) schoolId = String(p2.school_id);
      }
    } catch {
      /* ignore */
    }
  }

  // user_roles may be keyed by auth uid OR profiles.id — query both
  if (!schoolId || roles.length === 0) {
    try {
      const ids = Array.from(new Set([user.id, resolvedPid].filter(Boolean))) as string[];
      for (const uid of ids) {
        const { data: roleRows } = await supabase
          .from("user_roles")
          .select("role, school_id, user_id")
          .eq("user_id", uid);
        if (roleRows?.length) {
          roles = [
            ...new Set([
              ...roles,
              ...roleRows.map((r) => r.role as AppRole).filter(Boolean),
            ]),
          ];
          if (!schoolId) {
            schoolId =
              roleRows.map((r) => r.school_id).find(Boolean) || schoolId;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Role tables always carry school_id for staff/students
  if (!schoolId && resolvedPid) {
    try {
      const [{ data: eo }, { data: te }, { data: st }] = await Promise.all([
        supabase
          .from("examination_officers")
          .select("school_id, officer_id, status")
          .eq("profile_id", resolvedPid)
          .maybeSingle(),
        supabase
          .from("teachers")
          .select("school_id, staff_id, employment_status")
          .eq("profile_id", resolvedPid)
          .maybeSingle(),
        supabase
          .from("students")
          .select("school_id, matric_number, student_id, status")
          .eq("profile_id", resolvedPid)
          .maybeSingle(),
      ]);
      if (eo?.school_id) {
        schoolId = String(eo.school_id);
        if (!roles.includes("examination_officer")) roles = [...roles, "examination_officer"];
      }
      if (te?.school_id) {
        if (!schoolId) schoolId = String(te.school_id);
        if (!roles.includes("teacher")) roles = [...roles, "teacher"];
      }
      if (st?.school_id) {
        if (!schoolId) schoolId = String(st.school_id);
        if (!roles.includes("student")) roles = [...roles, "student"];
      }
    } catch {
      /* ignore */
    }
  }

  // examination_officers: also match when profile_id equals auth user id (legacy rows)
  if (resolvedPid || user.id) {
    try {
      const ids = [...new Set([resolvedPid, user.id].filter(Boolean))] as string[];
      for (const pid of ids) {
        const { data: eo } = await supabase
          .from("examination_officers")
          .select("school_id, officer_id, status, profile_id")
          .eq("profile_id", pid)
          .maybeSingle();
        if (eo?.school_id) {
          if (!schoolId) schoolId = String(eo.school_id);
          if (!roles.includes("examination_officer")) roles = [...roles, "examination_officer"];
          break;
        }
      }
    } catch { /* ignore */ }
  }

  // school_admins table (optional) — try profile id + auth id
  if (!schoolId) {
    try {
      const ids = [...new Set([resolvedPid, user.id].filter(Boolean))] as string[];
      for (const pid of ids) {
        const { data: sa } = await supabase
          .from("school_admins")
          .select("school_id")
          .eq("profile_id", pid)
          .maybeSingle();
        if (sa?.school_id) {
          schoolId = String(sa.school_id);
          if (!roles.includes("school_admin")) roles = [...roles, "school_admin"];
          break;
        }
      }
    } catch {
      /* table may not exist */
    }
  }

  // Last-chance school from profiles row if still empty
  if (!schoolId && (profile as { school_id?: string | null } | null)?.school_id) {
    schoolId = String((profile as { school_id: string }).school_id);
  }

  // teachers / students / officers by auth id as profile_id (legacy)
  if (!schoolId) {
    try {
      const ids = [...new Set([resolvedPid, user.id].filter(Boolean))] as string[];
      for (const pid of ids) {
        const [{ data: te }, { data: st }, { data: eo }] = await Promise.all([
          supabase.from("teachers").select("school_id").eq("profile_id", pid).maybeSingle(),
          supabase.from("students").select("school_id").eq("profile_id", pid).maybeSingle(),
          supabase.from("examination_officers").select("school_id").eq("profile_id", pid).maybeSingle(),
        ]);
        if (eo?.school_id) {
          schoolId = String(eo.school_id);
          if (!roles.includes("examination_officer")) roles = [...roles, "examination_officer"];
          break;
        }
        if (te?.school_id) {
          schoolId = String(te.school_id);
          if (!roles.includes("teacher")) roles = [...roles, "teacher"];
          break;
        }
        if (st?.school_id) {
          schoolId = String(st.school_id);
          if (!roles.includes("student")) roles = [...roles, "student"];
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Re-call RPC once more if still no school (auth may have settled)
  if (!schoolId && !roles.includes("super_admin")) {
    try {
      const rpcData = await withTimeout(
        supabase.rpc("get_my_session_context" as never).then((r) => r.data),
        4000,
        "get_my_session_context_retry",
      );
      if (rpcData && typeof rpcData === "object") {
        const again = rpcData as SessionContextRpc;
        if (again.school_id) schoolId = String(again.school_id);
        if (Array.isArray(again.roles)) {
          roles = [...new Set([...roles, ...(again.roles as AppRole[])])];
        }
        if (!rpcCtx) rpcCtx = again;
        else rpcCtx = { ...rpcCtx, ...again };
      }
    } catch {
      /* ignore */
    }
  }

  // Login-school fallback (from school code at sign-in) when DB lag leaves schoolId null
  if (!schoolId) {
    const loginSchool = readLoginSchoolContext();
    if (loginSchool?.schoolId) {
      schoolId = loginSchool.schoolId;
    }
  }

  // Server repair when client RLS leaves schoolId empty (officers after unlock)
  if (!schoolId && !roles.includes("super_admin")) {
    try {
      const { repairMySessionSchool } = await import("@/lib/repair-session-school.functions");
      const fixed = await withTimeout(repairMySessionSchool(), 4000, "repair-school");
      if (fixed?.schoolId) {
        schoolId = String(fixed.schoolId);
        for (const r of fixed.roles || []) {
          if (r && !roles.includes(r as AppRole)) roles = [...roles, r as AppRole];
        }
        seedLoginSchoolContext(fixed.schoolId, fixed.schoolCode);
      }
    } catch (e) {
      console.warn("[session] repairMySessionSchool", e);
    }
  }

  // Inject preferred/pending role only AFTER school recovery attempts
  {
    const preferred = readPreferredRole() || readPendingLoginRole();
    if (
      preferred &&
      !roles.includes(preferred) &&
      ["school_admin", "examination_officer", "teacher", "super_admin", "student"].includes(preferred)
    ) {
      roles = [...roles, preferred];
    }
  }

  // FAST EXIT: RPC already resolved identity — only load school branding
  // Ensure pending/preferred staff role is present before early return
  {
    const pref = readPreferredRole() || readPendingLoginRole();
    if (pref && ["school_admin", "examination_officer", "teacher", "super_admin"].includes(pref) && !roles.includes(pref as AppRole)) {
      roles = [...roles, pref as AppRole];
    }
  }

  if (roles.length > 0 && (schoolId || roles.includes("super_admin"))) {
    let schoolName: string | null = null;
    let schoolCode: string | null = null;
    let schoolLogoUrl: string | null = null;
    if (schoolId) {
      try {
        const { data: school } = await withTimeout(
          supabase.from("schools").select("name, school_code, logo_url").eq("id", schoolId).maybeSingle().then((r) => r),
          2_000,
          "school",
        );
        schoolName = school?.name ?? null;
        schoolCode = school?.school_code ?? null;
        schoolLogoUrl = (school?.logo_url as string | null) ?? null;
      } catch {
        /* non-fatal */
      }
    }
    const priorityFast: AppRole[] = [
      "super_admin",
      "school_admin",
      "examination_officer",
      "teacher",
      "student",
    ];
    const preferredFast = readPreferredRole() || readPendingLoginRole();
    const primaryRoleFast =
      (preferredFast && roles.includes(preferredFast) ? preferredFast : null) ||
      priorityFast.find((r) => roles.includes(r)) ||
      null;
    let statusFast = (profile?.status as string | undefined) ?? (rpcCtx?.status as string | undefined) ?? "active";
    if (primaryRoleFast && (statusFast === "pending" || statusFast === "invited")) statusFast = "active";
    let fullNameFast =
      displayNameFromProfile(profile as { full_name?: string | null; first_name?: string | null; last_name?: string | null } | null) ||
      (rpcCtx?.full_name || "").trim() ||
      (typeof profile?.full_name === "string" ? profile.full_name.trim() : "") ||
      "";
    const roleLikeFast = /^(school\s*admin|examination\s*officer|departmental\s*officer|teacher|student|super\s*admin|user)$/i;
    if (fullNameFast && roleLikeFast.test(fullNameFast)) fullNameFast = "";
    if (!fullNameFast && profile?.id) {
      try {
        const { data: p2 } = await supabase.from("profiles").select("full_name, first_name, last_name").eq("id", profile.id).maybeSingle();
        fullNameFast = displayNameFromProfile(p2 as { full_name?: string | null; first_name?: string | null; last_name?: string | null } | null);
      } catch { /* ignore */ }
    }
    if (primaryRoleFast) clearPendingLoginRole();
    seedSchoolBrandFromSession(schoolId, schoolName, schoolLogoUrl);
    // Ensure profile photo is loaded (RPC path often omits it)
    let photoFast =
      (profile as { profile_photo_url?: string | null } | null)?.profile_photo_url || null;
    if (!photoFast) {
      try {
        const pid = (rpcCtx?.profile_id as string | undefined) || profile?.id || user.id;
        const { data: ph } = await supabase
          .from("profiles")
          .select("profile_photo_url")
          .or(`auth_user_id.eq.${user.id},id.eq.${pid}`)
          .not("profile_photo_url", "is", null)
          .limit(1)
          .maybeSingle();
        photoFast = (ph as { profile_photo_url?: string } | null)?.profile_photo_url || null;
      } catch { /* ignore */ }
    }
    return {
      userId: user.id,
      profileId: (rpcCtx?.profile_id as string | undefined) || profile?.id || user.id,
      email: (profile?.email as string | undefined) ?? rpcCtx?.email ?? user.email ?? "",
      fullName: fullNameFast,
      status: statusFast,
      schoolId,
      schoolName,
      schoolCode,
      schoolLogoUrl,
      avatarUrl: photoFast,
      roles: primaryRoleFast && !roles.includes(primaryRoleFast) ? [...roles, primaryRoleFast] : roles,
      role: primaryRoleFast,
      identifier: rpcCtx?.officer_id || rpcCtx?.staff_id || rpcCtx?.matric || (profile?.email as string | undefined) || user.email || null,
      identifierLabel: rpcCtx?.officer_id ? "Officer ID" : rpcCtx?.staff_id ? "Staff ID" : rpcCtx?.matric ? "Matric" : "Email",
    };
  }

  if (!schoolId && profile?.id) {
    try {
      const { data: extraRoles } = await supabase
        .from("user_roles")
        .select("role, school_id")
        .eq("user_id", profile.id);
      if (extraRoles?.length) {
        roles = [...new Set([...roles, ...extraRoles.map((r) => r.role as AppRole).filter(Boolean)])];
        schoolId = extraRoles.map((r) => r.school_id).find(Boolean) || schoolId;
      }
    } catch {}
  }

  if (!schoolId && profile?.id) {
    try {
      const { data: eo } = await supabase
        .from("examination_officers")
        .select("school_id, officer_id")
        .eq("profile_id", profile.id)
        .maybeSingle();
      if (eo?.school_id) schoolId = eo.school_id as string;
    } catch {}
  }

  // Recover school + roles if profile lag / RLS left gaps
  if (!profile?.id || !schoolId) {
    try {
      const { data: roleRows } = await supabase
        .from("user_roles")
        .select("role, school_id, user_id")
        .eq("user_id", user.id);
      if (roleRows?.length) {
        roles = [
          ...new Set([
            ...roles,
            ...roleRows.map((r) => r.role as AppRole).filter(Boolean),
          ]),
        ];
        if (!schoolId) {
          schoolId = roleRows.map((r) => r.school_id).find(Boolean) || schoolId;
        }
      }
    } catch {}
  }

  let schoolName: string | null = null;
  let schoolCode: string | null = null;
  let schoolLogoUrl: string | null = null;
  let identifier: string | null = rpcCtx?.officer_id || rpcCtx?.staff_id || rpcCtx?.matric || null;
  let identifierLabel = identifier ? "ID" : "Email";

  // Prefer real profiles.id (not auth uid) for downstream teacher/officer/student joins
  let resolvedProfileId: string | null =
    (rpcCtx?.profile_id as string | undefined) || profile?.id || null;

  if (profile?.id && !identifier) {
    try {
      const [{ data: eo }, { data: teacher }, { data: student }] = await Promise.all([
        supabase.from("examination_officers").select("officer_id, school_id").eq("profile_id", profile.id).maybeSingle(),
        supabase.from("teachers").select("staff_id, school_id").eq("profile_id", profile.id).maybeSingle(),
        supabase.from("students").select("matric_number, student_id, school_id").eq("profile_id", profile.id).maybeSingle(),
      ]);
      if (!schoolId) schoolId = (eo?.school_id || teacher?.school_id || student?.school_id || null) as string | null;
      identifier = (eo?.officer_id || teacher?.staff_id || student?.matric_number || student?.student_id || null) as string | null;
      if (eo?.officer_id) identifierLabel = "Officer ID";
      else if (teacher?.staff_id) identifierLabel = "Staff ID";
      else if (student?.matric_number || student?.student_id) identifierLabel = "Matric";
    } catch {}
  }

  // Last-chance: profiles by auth_user_id → staff tables
  if (!schoolId || !resolvedProfileId) {
    try {
      const { data: profByAuth } = await supabase
        .from("profiles")
        .select("id, school_id, full_name, email, status")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (profByAuth?.id) {
        resolvedProfileId = resolvedProfileId || profByAuth.id;
        if (!schoolId && profByAuth.school_id) schoolId = profByAuth.school_id as string;
        const [{ data: eo }, { data: teacher }, { data: student }] = await Promise.all([
          supabase.from("examination_officers").select("officer_id, school_id").eq("profile_id", profByAuth.id).maybeSingle(),
          supabase.from("teachers").select("staff_id, school_id").eq("profile_id", profByAuth.id).maybeSingle(),
          supabase.from("students").select("matric_number, student_id, school_id").eq("profile_id", profByAuth.id).maybeSingle(),
        ]);
        if (!schoolId) schoolId = (eo?.school_id || teacher?.school_id || student?.school_id || null) as string | null;
        if (!identifier) {
          identifier = (eo?.officer_id || teacher?.staff_id || student?.matric_number || student?.student_id || null) as string | null;
          if (eo?.officer_id) identifierLabel = "Officer ID";
          else if (teacher?.staff_id) identifierLabel = "Staff ID";
          else if (student?.matric_number || student?.student_id) identifierLabel = "Matric";
        }
      }
    } catch {}
  }

  if (schoolId) {
    const { data: school } = await supabase
      .from("schools")
      .select("name, school_code, logo_url")
      .eq("id", schoolId)
      .maybeSingle();
    schoolName = school?.name ?? null;
    schoolCode = school?.school_code ?? null;
    schoolLogoUrl = (school?.logo_url as string | null) ?? null;
  }

  const priority: AppRole[] = [
    "super_admin",
    "school_admin",
    "examination_officer",
    "teacher",
    "student",
  ];
  const preferred = readPreferredRole() || readPendingLoginRole();
  // Keep preferred staff role even if user_roles lag / RLS delays (prevents admin→login loop)
  if (preferred && !roles.includes(preferred) && ["school_admin", "examination_officer", "teacher", "super_admin"].includes(preferred)) {
    roles = [...roles, preferred];
  }
  const primaryRole =
    (preferred && roles.includes(preferred) ? preferred : null) ||
    priority.find((r) => roles.includes(r)) ||
    null;
  let status = (profile?.status as string | undefined) ?? "pending";
  if (primaryRole === "super_admin" && (status === "pending" || status === "invited" || !profile)) {
    status = "active";
  }
  if (primaryRole && (status === "pending" || status === "invited")) {
    status = "active";
  }

  let fullName =
    displayNameFromProfile(profile as { full_name?: string | null; first_name?: string | null; last_name?: string | null } | null) ||
    (rpcCtx?.full_name || "").trim() ||
    (typeof profile?.full_name === "string" ? profile.full_name.trim() : "") ||
    "";
  // Never treat role labels / codes as a person's name
  const roleLike = /^(school\s*admin|examination\s*officer|departmental\s*officer|teacher|student|super\s*admin|user)$/i;
  if (fullName && roleLike.test(fullName)) fullName = "";
  if (!fullName && resolvedProfileId) {
    try {
      const { data: p2 } = await supabase
        .from("profiles")
        .select("full_name, first_name, last_name")
        .eq("id", resolvedProfileId)
        .maybeSingle();
      fullName = displayNameFromProfile(p2 as { full_name?: string | null; first_name?: string | null; last_name?: string | null } | null);
    } catch { /* ignore */ }
  }
  if (!fullName) {
    // Last resort: email local-part only if it looks like a person (not role)
    const local = (user.email || "").split("@")[0] || "";
    if (local && !roleLike.test(local.replace(/[._]/g, " ")) && !/^\d+$/.test(local)) {
      fullName = local.replace(/[._]/g, " ");
    }
  }

  if (primaryRole) clearPendingLoginRole();

  // Final safety: login school code context (must never show "not linked" after valid school login)
  if (!schoolId) {
    const loginSchool = readLoginSchoolContext();
    if (loginSchool?.schoolId) {
      schoolId = loginSchool.schoolId;
      if (!schoolCode && loginSchool.schoolCode) schoolCode = loginSchool.schoolCode;
    }
  }
  if (schoolId && (!schoolName || !schoolLogoUrl)) {
    try {
      const { data: school } = await supabase
        .from("schools")
        .select("name, school_code, logo_url")
        .eq("id", schoolId)
        .maybeSingle();
      if (school) {
        schoolName = schoolName || school.name || null;
        schoolCode = schoolCode || school.school_code || null;
        schoolLogoUrl = schoolLogoUrl || (school.logo_url as string | null) || null;
      }
    } catch {
      /* ignore */
    }
  }

  seedSchoolBrandFromSession(schoolId, schoolName, schoolLogoUrl);
  // Final photo resolve
  let photoFinal =
    (profile as { profile_photo_url?: string | null } | null)?.profile_photo_url || null;
  if (!photoFinal) {
    try {
      const { data: ph } = await supabase
        .from("profiles")
        .select("profile_photo_url")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      photoFinal = (ph as { profile_photo_url?: string } | null)?.profile_photo_url || null;
    } catch { /* ignore */ }
  }

  return {
    userId: user.id,
    profileId: resolvedProfileId || (rpcCtx?.profile_id as string | undefined) || profile?.id || user.id,
    email: profile?.email ?? rpcCtx?.email ?? user.email ?? "",
    fullName,
    status,
    schoolId,
    schoolName,
    schoolCode,
    schoolLogoUrl,
    avatarUrl: photoFinal,
    roles,
    role: primaryRole,
    identifier: identifier ?? profile?.email ?? user.email ?? null,
    identifierLabel,
  };
}

export function useSessionUser() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        void queryClient.invalidateQueries({ queryKey: ["session-user"] });
      }
    });
    const onRefresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["session-user"] });
    };
    window.addEventListener("d4-session-refresh", onRefresh);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener("d4-session-refresh", onRefresh);
    };
  }, [queryClient]);

  return useQuery({
    queryKey: ["session-user"],
    queryFn: async () => {
      const last = readLastUserId();
      let u = await withTimeout(fetchSessionUser(), 6000, "session");
      // Merge login school if session still missing school (teacher/admin after unlock)
      if (u && !u.schoolId && u.role !== "super_admin") {
        const loginSchool = readLoginSchoolContext();
        if (loginSchool?.schoolId) {
          let schoolName = u.schoolName;
          let schoolCode = u.schoolCode || loginSchool.schoolCode;
          let schoolLogoUrl = u.schoolLogoUrl;
          try {
            const { data: school } = await supabase
              .from("schools")
              .select("name, school_code, logo_url")
              .eq("id", loginSchool.schoolId)
              .maybeSingle();
            if (school) {
              schoolName = school.name ?? schoolName;
              schoolCode = school.school_code ?? schoolCode;
              schoolLogoUrl = (school.logo_url as string | null) ?? schoolLogoUrl;
            }
          } catch {
            /* ignore */
          }
          u = {
            ...u,
            schoolId: loginSchool.schoolId,
            schoolName: schoolName ?? u.schoolName,
            schoolCode: schoolCode ?? u.schoolCode,
            schoolLogoUrl: schoolLogoUrl ?? u.schoolLogoUrl,
          };
        } else {
          // Last attempt: server repair
          try {
            const { repairMySessionSchool } = await import("@/lib/repair-session-school.functions");
            const fixed = await repairMySessionSchool();
            if (fixed?.schoolId) {
              seedLoginSchoolContext(fixed.schoolId, fixed.schoolCode);
              u = {
                ...u,
                schoolId: fixed.schoolId,
                schoolName: fixed.schoolName ?? u.schoolName,
                schoolCode: fixed.schoolCode ?? u.schoolCode,
                schoolLogoUrl: fixed.schoolLogoUrl ?? u.schoolLogoUrl,
                roles: [...new Set([...(u.roles || []), ...(fixed.roles || [])])] as AppRole[],
              };
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (u?.userId) {
        rememberLastUserId(u.userId);
        const complete = u.role === "super_admin" || Boolean(u.schoolId);
        if (complete) {
          void offlineSet(u.userId, OfflineKeys.sessionUser, u, { schoolId: u.schoolId });
          void mirrorSessionUser(u);
        }
      } else if (last) {
        try {
          const cached = await withOfflineCache(
            last,
            OfflineKeys.sessionUser,
            async () => null,
            { fallback: null },
          );
          if (cached && (cached.role === "super_admin" || cached.schoolId)) return cached;
        } catch {
          /* ignore */
        }
      }
      return u;
    },
    staleTime: 15_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    retry: 2,
    retryDelay: 400,
  });
}

export function initials(name: string) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  if (parts.length === 1) {
    const s = parts[0];
    // email-like local part → first 2 chars
    if (s.includes("@")) {
      const local = s.split("@")[0] || s;
      return local.slice(0, 2).toUpperCase() || "U";
    }
    return s.slice(0, 2).toUpperCase() || "U";
  }
  return "U";
}

export async function signOut() {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id;
    if (uid) {
      await supabase
        .from("push_devices")
        .update({ enabled: false, updated_at: new Date().toISOString() } as never)
        .eq("user_id", uid);
    }
  } catch {
    /* ignore */
  }
  await supabase.auth.signOut();
  clearPendingLoginRole();
  if (typeof window !== "undefined") window.location.href = "/login";
}
