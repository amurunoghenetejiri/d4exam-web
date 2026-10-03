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

export function roleFromPath(path: string | null | undefined): AppRole | null {
  const p = String(path || "").split("?")[0];
  if (p.startsWith("/student")) return "student";
  if (p.startsWith("/teacher")) return "teacher";
  if (p.startsWith("/officer")) return "examination_officer";
  if (p.startsWith("/admin")) return "school_admin";
  if (p.startsWith("/super-admin")) return "super_admin";
  return null;
}

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
  } catch {
    /* ignore */
  }
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
  } catch {
    /* ignore */
  }
  return null;
}

const KNOWN_ROLES: AppRole[] = [
  "student",
  "teacher",
  "school_admin",
  "examination_officer",
  "super_admin",
];

export function setPreferredRole(role: AppRole | string | null | undefined): void {
  if (typeof window === "undefined") return;
  try {
    const r = String(role || "").trim();
    if (r && KNOWN_ROLES.includes(r as AppRole)) {
      window.localStorage.setItem(PREFERRED_ROLE_KEY, r);
      window.localStorage.setItem(LAST_ROLE_KEY, r);
    }
  } catch {
    /* ignore */
  }
}

export function readPreferredRole(): AppRole | null {
  if (typeof window === "undefined") return null;
  try {
    const r = window.localStorage.getItem(PREFERRED_ROLE_KEY);
    if (r && KNOWN_ROLES.includes(r as AppRole)) return r as AppRole;
  } catch {
    /* ignore */
  }
  return null;
}

export function clearPreferredRole(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREFERRED_ROLE_KEY);
  } catch {
    /* ignore */
  }
}

export async function switchActiveRole(
  role: AppRole | string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const target = String(role || "").trim() as AppRole;
  if (!KNOWN_ROLES.includes(target)) {
    return { ok: false, error: "Unknown role." };
  }
  const path = roleHome[target];
  if (!path) return { ok: false, error: "Unknown role." };

  setPreferredRole(target);
  seedPendingLoginRole(target);

  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(LAST_PATH_KEY);
    }
  } catch {
    /* ignore */
  }

  try {
    const user = await fetchSessionUser();
    if (user && Array.isArray(user.roles) && user.roles.length > 0 && !user.roles.includes(target)) {
      return { ok: false, error: "This account does not have that role." };
    }
  } catch {
    /* allow switch offline */
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
function seedSchoolBrandFromSession(
  schoolId?: string | null,
  name?: string | null,
  logoUrl?: string | null,
) {
  if (typeof window === "undefined" || !schoolId) return;
  if (!name && !logoUrl) return;
  try {
    window.localStorage.setItem(
      SCHOOL_BRAND_KEY,
      JSON.stringify({ id: schoolId, name: name || null, logoUrl: logoUrl || null, ts: Date.now() }),
    );
  } catch {}
}

export function readCachedSchoolBrand(
  schoolId?: string | null,
): { id?: string; name?: string | null; logoUrl?: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SCHOOL_BRAND_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      id?: string;
      name?: string | null;
      logoUrl?: string | null;
      ts?: number;
    };
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

  let rpcCtx: SessionContextRpc | null = null;
  let profileByAuth: { data: Record<string, unknown> | null } = { data: null };
  let profileById: { data: Record<string, unknown> | null } = { data: null };
  let roleRes: { data: { role: string; school_id: string | null; user_id: string }[] | null } = {
    data: null,
  };
  try {
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
          if (
            rpcCtx.school_id ||
            (Array.isArray(rpcCtx.roles) && rpcCtx.roles.length) ||
            rpcCtx.profile_id
          ) {
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
          .select("id, full_name, first_name, last_name, email, status, school_id, auth_user_id")
          .eq("auth_user_id", user.id)
          .maybeSingle(),
        supabase
          .from("profiles")
          .select("id, full_name, first_name, last_name, email, status, school_id, auth_user_id")
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
    } catch {}
  }

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
            ...new Set([...roles, ...roleRows.map((r) => r.role as AppRole).filter(Boolean)]),
          ];
          if (!schoolId) {
            schoolId = roleRows.map((r) => r.school_id).find(Boolean) || schoolId;
          }
        }
      }
    } catch {}
  }

  if (!schoolId && resolvedPid) {
    try {
      const [{ data: eo }, { data: te }, { data: st }] = await Promise.all([
        supabase
          .from("examination_officers")
          .select("school_id")
          .eq("profile_id", resolvedPid)
          .maybeSingle(),
        supabase.from("teachers").select("school_id").eq("profile_id", resolvedPid).maybeSingle(),
        supabase.from("students").select("school_id").eq("profile_id", resolvedPid).maybeSingle(),
      ]);
      schoolId =
        (eo?.school_id ? String(eo.school_id) : null) ||
        (te?.school_id ? String(te.school_id) : null) ||
        (st?.school_id ? String(st.school_id) : null) ||
        schoolId;
      if (eo?.school_id && !roles.includes("examination_officer"))
        roles = [...roles, "examination_officer"];
      if (te?.school_id && !roles.includes("teacher")) roles = [...roles, "teacher"];
      if (st?.school_id && !roles.includes("student")) roles = [...roles, "student"];
    } catch {}
  }

  const loginSchool = readLoginSchoolContext();
  if (!schoolId && loginSchool?.schoolId) schoolId = loginSchool.schoolId;

  // Only short-lived pending login may expand roles — do not invent from preferredRole alone
  {
    const pending = readPendingLoginRole(90_000);
    if (
      pending &&
      !roles.includes(pending) &&
      ["school_admin", "examination_officer", "teacher", "super_admin", "student"].includes(pending)
    ) {
      roles = [...roles, pending];
    }
  }

  roles = [...new Set(roles)];

  const preferred = readPreferredRole() || readPendingLoginRole();
  const priority: AppRole[] = [
    "super_admin",
    "school_admin",
    "examination_officer",
    "teacher",
    "student",
  ];
  const primaryRole =
    (preferred && roles.includes(preferred) ? preferred : null) ||
    priority.find((r) => roles.includes(r)) ||
    null;

  let schoolName: string | null = null;
  let schoolCode: string | null = null;
  let schoolLogoUrl: string | null = null;
  if (schoolId) {
    try {
      const { data: school } = await supabase
        .from("schools")
        .select("name, school_code, code, logo_url")
        .eq("id", schoolId)
        .maybeSingle();
      schoolName = (school?.name as string) ?? null;
      schoolCode =
        ((school as { school_code?: string } | null)?.school_code as string) ||
        ((school as { code?: string } | null)?.code as string) ||
        null;
      schoolLogoUrl = ((school as { logo_url?: string } | null)?.logo_url as string) ?? null;
      seedSchoolBrandFromSession(schoolId, schoolName, schoolLogoUrl);
    } catch {}
  }

  let identifier: string | null = null;
  let identifierLabel = "";
  if (resolvedPid && primaryRole === "student") {
    try {
      const { data: st } = await supabase
        .from("students")
        .select("matric_number, student_id")
        .eq("profile_id", resolvedPid)
        .maybeSingle();
      identifier = (st?.matric_number as string) || (st?.student_id as string) || null;
      identifierLabel = "Matric";
    } catch {}
  } else if (resolvedPid && primaryRole === "teacher") {
    try {
      const { data: te } = await supabase
        .from("teachers")
        .select("staff_id")
        .eq("profile_id", resolvedPid)
        .maybeSingle();
      identifier = (te?.staff_id as string) || null;
      identifierLabel = "Staff ID";
    } catch {}
  } else if (resolvedPid && primaryRole === "examination_officer") {
    try {
      const { data: eo } = await supabase
        .from("examination_officers")
        .select("officer_id, staff_id")
        .eq("profile_id", resolvedPid)
        .maybeSingle();
      identifier =
        ((eo as { officer_id?: string } | null)?.officer_id as string) ||
        ((eo as { staff_id?: string } | null)?.staff_id as string) ||
        null;
      identifierLabel = "Officer ID";
    } catch {}
  }

  if (primaryRole) clearPendingLoginRole();

  return {
    userId: user.id,
    profileId: resolvedPid || user.id,
    email: (profile?.email as string) || user.email || "",
    fullName: displayNameFromProfile(profile as never) || user.email || "User",
    status: (profile?.status as string) || "active",
    schoolId,
    schoolName,
    schoolCode,
    schoolLogoUrl,
    roles,
    role: primaryRole,
    identifier,
    identifierLabel,
  };
}

export function useSessionUser() {
  const qc = useQueryClient();
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void qc.invalidateQueries({ queryKey: ["session-user"] });
    });
    return () => subscription.unsubscribe();
  }, [qc]);

  return useQuery({
    queryKey: ["session-user"],
    queryFn: async () => {
      const u = await fetchSessionUser();
      if (u?.userId) {
        rememberLastUserId(u.userId);
        try {
          void offlineSet(u.userId, OfflineKeys.sessionUser, u, { schoolId: u.schoolId });
          void mirrorSessionUser(u.userId, u as never);
        } catch {}
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
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((n) => n[0]?.toUpperCase() ?? "")
      .join("") || "D4"
  );
}

export async function signOut() {
  await supabase.auth.signOut();
  clearPendingLoginRole();
  clearPreferredRole();
  if (typeof window !== "undefined") window.location.href = "/login";
}
