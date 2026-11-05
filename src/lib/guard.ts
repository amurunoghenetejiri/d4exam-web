import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import {
  fetchSessionUser,
  readPendingLoginRole,
  readPreferredRole,
  clearPendingLoginRole,
  readLoginSchoolContext,
  roleHome,
  type AppRole,
  type SessionUser,
} from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { offlineGet, OfflineKeys } from "@/lib/offline-cache";
import { readLastUserId } from "@/lib/offline-query";

/**
 * Client-side gate for a role area.
 * Database RLS still enforces real access — this only prevents wrong dashboards.
 *
 * Uses the React Query cache when available so sibling navigations (e.g.
 * /student → /student/results) do not re-hit Supabase and stall the page.
 * Offline: falls back to last cached SessionUser so the student shell still opens.
 */
export async function requireRole(role: AppRole | AppRole[], queryClient?: QueryClient) {
  const allowed = Array.isArray(role) ? role : [role];

  let user: SessionUser | null | undefined;
  if (queryClient) {
    user = queryClient.getQueryData<SessionUser | null>(["session-user"]);
  }

  // Incomplete = school-bound role with no schoolId. NEVER trust that cache.
  const needsSchool = (u: SessionUser | null | undefined) =>
    Boolean(u?.role && u.role !== "super_admin" && !u.schoolId);
  const isIncomplete = (u: SessionUser | null | undefined) =>
    Boolean(u && (needsSchool(u) || (!u.fullName && !u.email)));

  // Offline-first: prefer local session cache immediately so menu navigations never stall.
  const online =
    typeof navigator === "undefined" ? true : navigator.onLine !== false;
  async function readOfflineSession(): Promise<SessionUser | null> {
    try {
      const last = readLastUserId();
      if (!last) return null;
      const env = await offlineGet<SessionUser>(last, OfflineKeys.sessionUser);
      if (env?.data && !isIncomplete(env.data)) return env.data;
    } catch {
      /* ignore */
    }
    return null;
  }

  if ((!user || isIncomplete(user)) && !online) {
    const cached = await readOfflineSession();
    if (cached) {
      user = cached;
      if (queryClient) queryClient.setQueryData(["session-user"], user);
    }
  }

  let hasAuthSession = false;
  try {
    const sessPromise = supabase.auth.getSession();
    const { data: sess } = await Promise.race([
      sessPromise,
      new Promise<{ data: { session: null } }>((resolve) =>
        setTimeout(() => resolve({ data: { session: null } }), online ? 2_500 : 400),
      ),
    ]);
    hasAuthSession = Boolean(sess.session?.access_token && sess.session.user?.id);
  } catch {
    hasAuthSession = false;
  }

  const mustResolve =
    user === undefined ||
    (user === null && hasAuthSession) ||
    (hasAuthSession && isIncomplete(user));

  if (mustResolve) {
    // When offline, never wait on network — use cache only.
    if (!online) {
      if (!user || isIncomplete(user)) {
        const cached = await readOfflineSession();
        if (cached) user = cached;
      }
    } else {
      try {
        user = await Promise.race([
          fetchSessionUser(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_500)),
        ]);
      } catch {
        user = null;
      }
      if ((!user || isIncomplete(user)) && hasAuthSession) {
        try {
          // Server repair: write profiles.school_id from officers/teachers/roles
          const { repairMySessionSchool } = await import("@/lib/repair-session-school.functions");
          const fixed = await Promise.race([
            repairMySessionSchool(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_500)),
          ]);
          if (fixed && (fixed as { schoolId?: string }).schoolId) {
            const { seedLoginSchoolContext } = await import("@/lib/session");
            seedLoginSchoolContext(
              String((fixed as { schoolId: string }).schoolId),
              (fixed as { schoolCode?: string | null }).schoolCode ?? null,
            );
          }
        } catch {
          /* ignore */
        }
        try {
          await new Promise((r) => setTimeout(r, 150));
          const again = await Promise.race([
            fetchSessionUser(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
          ]);
          if (again && (!user || !isIncomplete(again))) user = again;
          else if (again && isIncomplete(user) && !isIncomplete(again)) user = again;
          else if (again && !user) user = again;
          else if (again) user = again;
        } catch {
          /* ignore */
        }
      }
      if (!user || isIncomplete(user)) {
        const cached = await readOfflineSession();
        if (cached) user = cached;
      }
    }
    if (queryClient && user) {
      // Cache even incomplete staff sessions so login→dashboard does not bounce
      const roleOk =
        user.role === "super_admin" ||
        Boolean(user.schoolId) ||
        allowed.some((r) => user!.roles.includes(r) || user!.role === r);
      if (roleOk || !isIncomplete(user)) {
        queryClient.setQueryData(["session-user"], user);
      }
    }
  }

  if (!user) {
    // Valid auth session after login must NOT bounce to /login while profile hydrates
    try {
      const { data: sess } = await supabase.auth.getSession();
      const authUser = sess.session?.user;
      if (authUser?.id) {
        try {
          const hard = await Promise.race([
            fetchSessionUser(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
          ]);
          if (
            hard &&
            (hard.role === "super_admin" ||
              hard.schoolId ||
              (hard.role && allowed.includes(hard.role as never)) ||
              allowed.some((r) => hard.roles?.includes(r)))
          ) {
            if (queryClient) queryClient.setQueryData(["session-user"], hard);
            if (hard.role || hard.schoolId) clearPendingLoginRole();
            return { user: hard };
          }
          if (hard && queryClient) {
            // Accept full session user even if role still matching
            const roleMatch =
              (hard.role && allowed.includes(hard.role as never)) ||
              allowed.some((r) => hard.roles?.includes(r));
            if (roleMatch || hard.role === "super_admin") {
              queryClient.setQueryData(["session-user"], hard);
              return { user: hard };
            }
          }
        } catch {
          /* continue minimal */
        }
        // Minimal session so dashboard can open; layout will hydrate school/profile
        const pending = readPendingLoginRole() || readPreferredRole();
        const roleGuess =
          pending && allowed.includes(pending)
            ? pending
            : allowed[0];
        const loginSchool = readLoginSchoolContext();
        const minimal: SessionUser = {
          userId: authUser.id,
          profileId: authUser.id,
          email: String(authUser.email || ""),
          fullName: String(
            (authUser.user_metadata as { full_name?: string } | undefined)?.full_name ||
              authUser.email ||
              "User",
          ),
          status: "active",
          schoolId: loginSchool?.schoolId ?? null,
          schoolName: null,
          schoolCode: loginSchool?.schoolCode ?? null,
          schoolLogoUrl: null,
          avatarUrl: null,
          roles: [roleGuess],
          role: roleGuess,
          identifier: null,
          identifierLabel: "ID",
        };
        if (queryClient) queryClient.setQueryData(["session-user"], minimal);
        return { user: minimal };
      }
    } catch (e) {
      if (e && typeof e === "object" && "to" in e) throw e;
      /* ignore */
    }
    throw redirect({ to: "/login" });
  }

  const isSuper = user.roles.includes("super_admin") || user.role === "super_admin";

  if (user.status === "suspended" || user.status === "deactivated" || user.status === "locked") {
    throw redirect({ to: "/account-suspended" as never });
  }

  if (
    !isSuper &&
    (user.status === "pending" || user.status === "invited") &&
    !user.role &&
    user.roles.length === 0
  ) {
    throw redirect({ to: "/login", search: { pending: "1" } as never });
  }

  // STRICT: only roles from DB — never invent school_admin from preferred path/cache
  let hasRole = allowed.some((r) => user!.roles.includes(r) || user!.role === r);
  if (!hasRole) {
    const preferred = readPreferredRole() || readPendingLoginRole();
    if (
      preferred &&
      allowed.includes(preferred) &&
      (user!.roles.includes(preferred) || user!.role === preferred)
    ) {
      user = { ...user!, role: preferred };
      hasRole = true;
      if (queryClient) queryClient.setQueryData(["session-user"], user);
    }
  }
  if (!hasRole) {
    const home = user.role && user.role in roleHome ? roleHome[user.role] : "/login";
    throw redirect({ to: home as never });
  }

  if (
    user.status === "suspended" ||
    user.status === "deactivated" ||
    user.status === "locked"
  ) {
    throw redirect({ to: "/account-suspended" as never });
  }

  return { user };
}

/** Super admin only. */
export async function requireSuperAdmin(queryClient?: QueryClient) {
  return requireRole("super_admin", queryClient);
}

/** School-scoped staff (admin, officer, teacher). */
export async function requireStaff(queryClient?: QueryClient) {
  return requireRole(["school_admin", "examination_officer", "teacher"], queryClient);
}
