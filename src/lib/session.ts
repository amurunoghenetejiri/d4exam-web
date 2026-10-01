import { useQuery, useQueryClient } from "@tanstack/react-query";
import { offlineSet, OfflineKeys } from "@/lib/offline-cache";
import { rememberLastUserId, readLastUserId, withOfflineCache } from "@/lib/offline-query";
import { mirrorSessionUser } from "@/lib/local-db/mirror";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

// EMERGENCY MINIMAL SESSION — full file restored in follow-up if needed
export type AppRole =
  | "student"
  | "teacher"
  | "school_admin"
  | "examination_officer"
  | "super_admin";

export const roleHome: Record<AppRole, string> = {
  student: "/student",
  teacher: "/teacher",
  school_admin: "/admin",
  examination_officer: "/officer",
  super_admin: "/super-admin",
};

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
    if (!p || p === "/" || p === "/login") return;
    window.localStorage.setItem("d4exam_last_path_v1", p);
    const r = role || roleFromPath(p);
    if (r) {
      window.localStorage.setItem("d4exam_last_role_v1", r);
      window.localStorage.setItem("d4exam_preferred_role_v1", r);
    }
  } catch {}
}

export function readLastPath(): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem("d4exam_last_path_v1") : null;
  } catch {
    return null;
  }
}

export function readLastRole(): AppRole | null {
  try {
    const r = typeof window !== "undefined" ? window.localStorage.getItem("d4exam_last_role_v1") : null;
    return r as AppRole | null;
  } catch {
    return null;
  }
}

export function setPreferredRole(role: AppRole | string | null | undefined): void {
  if (typeof window === "undefined" || !role) return;
  try {
    window.localStorage.setItem("d4exam_preferred_role_v1", String(role));
  } catch {}
}

export function readPreferredRole(): AppRole | null {
  try {
    return (typeof window !== "undefined"
      ? window.localStorage.getItem("d4exam_preferred_role_v1")
      : null) as AppRole | null;
  } catch {
    return null;
  }
}

export function clearPreferredRole(): void {
  try {
    window.localStorage.removeItem("d4exam_preferred_role_v1");
  } catch {}
}

export function seedPendingLoginRole(role: AppRole | string | null | undefined): void {
  if (typeof window === "undefined" || !role) return;
  const value = String(role);
  const ts = String(Date.now());
  try {
    window.sessionStorage.setItem("d4_pending_role", value);
    window.sessionStorage.setItem("d4_pending_role_ts", ts);
    window.localStorage.setItem("d4_pending_role", value);
    window.localStorage.setItem("d4_pending_role_ts", ts);
  } catch {}
}

export function readPendingLoginRole(maxAgeMs = 90_000): AppRole | null {
  if (typeof window === "undefined") return null;
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      const role = store.getItem("d4_pending_role");
      const ts = Number(store.getItem("d4_pending_role_ts") || 0);
      if (role && ts && Date.now() - ts <= maxAgeMs && role in roleHome) return role as AppRole;
    } catch {}
  }
  return null;
}

export function clearPendingLoginRole(): void {
  if (typeof window === "undefined") return;
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      store.removeItem("d4_pending_role");
      store.removeItem("d4_pending_role_ts");
    } catch {}
  }
}

export function seedLoginSchoolContext(schoolId: string | null | undefined, schoolCode?: string | null) {
  if (typeof window === "undefined" || !schoolId) return;
  try {
    window.localStorage.setItem(
      "d4exam_login_school_v1",
      JSON.stringify({ schoolId: String(schoolId), schoolCode: schoolCode || null, ts: Date.now() }),
    );
  } catch {}
}

export function readLoginSchoolContext(): { schoolId: string; schoolCode: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("d4exam_login_school_v1");
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.schoolId) return null;
    return { schoolId: String(p.schoolId), schoolCode: p.schoolCode || null };
  } catch {
    return null;
  }
}

export function clearLoginSchoolContext() {
  try {
    window.localStorage.removeItem("d4exam_login_school_v1");
  } catch {}
}

export function readCachedSchoolBrand() {
  return null;
}

export async function confirmSessionReady(maxAttempts = 12): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token && data.session.user?.id) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100 * (i + 1)));
  }
  return false;
}

export async function fetchSessionUser(): Promise<SessionUser | null> {
  const { data: sessData } = await supabase.auth.getSession();
  let user = sessData.session?.user;
  if (!user) {
    const { data } = await supabase.auth.getUser();
    user = data.user ?? undefined;
  }
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, status, school_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  let roles: AppRole[] = [];
  const { data: roleRows } = await supabase.from("user_roles").select("role, school_id").eq("user_id", user.id);
  for (const r of roleRows ?? []) {
    if (r.role) roles.push(String(r.role).toLowerCase() as AppRole);
  }
  if (profile?.id && profile.id !== user.id) {
    const { data: roleRows2 } = await supabase.from("user_roles").select("role, school_id").eq("user_id", profile.id);
    for (const r of roleRows2 ?? []) {
      if (r.role) roles.push(String(r.role).toLowerCase() as AppRole);
    }
  }

  try {
    const { data: isSuper } = await supabase.rpc("is_super_admin");
    if (isSuper === true && !roles.includes("super_admin")) roles = ["super_admin", ...roles];
  } catch {}

  // Only short-lived pending login may expand roles — never invent from preferredRole alone
  const pending = readPendingLoginRole(90_000);
  if (pending && !roles.includes(pending)) roles = [...roles, pending];

  roles = [...new Set(roles)];

  const preferred = readPreferredRole();
  const priority: AppRole[] = ["super_admin", "school_admin", "examination_officer", "teacher", "student"];
  const primaryRole =
    (preferred && roles.includes(preferred) ? preferred : null) ||
    priority.find((r) => roles.includes(r)) ||
    null;

  let schoolId = (profile?.school_id as string | null) || null;
  for (const r of roleRows ?? []) {
    if (!schoolId && r.school_id) schoolId = String(r.school_id);
  }
  const loginSchool = readLoginSchoolContext();
  if (!schoolId && loginSchool?.schoolId) schoolId = loginSchool.schoolId;

  let schoolName: string | null = null;
  let schoolCode: string | null = null;
  let schoolLogoUrl: string | null = null;
  if (schoolId) {
    const { data: school } = await supabase
      .from("schools")
      .select("name, school_code, logo_url")
      .eq("id", schoolId)
      .maybeSingle();
    schoolName = school?.name ?? null;
    schoolCode = (school as { school_code?: string } | null)?.school_code ?? null;
    schoolLogoUrl = (school as { logo_url?: string } | null)?.logo_url ?? null;
  }

  if (primaryRole) clearPendingLoginRole();

  return {
    userId: user.id,
    profileId: profile?.id ? String(profile.id) : user.id,
    email: (profile?.email as string) || user.email || "",
    fullName: (profile?.full_name as string) || user.email || "User",
    status: (profile?.status as string) || "active",
    schoolId,
    schoolName,
    schoolCode,
    schoolLogoUrl,
    roles,
    role: primaryRole,
    identifier: null,
    identifierLabel: "",
  };
}

export function useSessionUser() {
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
  if (typeof window !== "undefined") window.location.href = "/login";
}

export async function switchActiveRole(role: AppRole | string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const target = String(role || "").trim() as AppRole;
  if (!(target in roleHome)) return { ok: false, error: "Unknown role." };
  const user = await fetchSessionUser();
  if (user && Array.isArray(user.roles) && user.roles.length > 0 && !user.roles.includes(target)) {
    return { ok: false, error: "This account does not have that role." };
  }
  setPreferredRole(target);
  seedPendingLoginRole(target);
  const path = roleHome[target];
  if (typeof window !== "undefined") window.location.replace(path);
  return { ok: true, path };
}
