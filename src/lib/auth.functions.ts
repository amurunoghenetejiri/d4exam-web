import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function looksLikeEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function studentSyntheticEmail(schoolCode: string, matric: string) {
  const safeMatric = matric.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const safeCode = schoolCode.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${safeMatric}@${safeCode || "school"}.student.d4exam.local`;
}

function resolveServiceKey() {
  return (
    process.env["SUPABASE_SERVICE_ROLE_KEY"] ||
    process.env["SUPABASE_SECRET_KEY"] ||
    process.env["SUPABASE_SERVICE_KEY"] ||
    process.env["SB_SERVICE_ROLE_KEY"] ||
    ""
  );
}

function isNewSupabaseApiKey(value: string) {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    if (isNewSupabaseApiKey(supabaseKey) && headers.get("Authorization") === `Bearer ${supabaseKey}`) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function makeClient(url: string, key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    global: {
      fetch: createSupabaseFetch(key),
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const loginInputSchema = z.object({
  schoolCode: z.preprocess((v) => (v == null ? "" : String(v).trim()), z.string().max(32)),
  identifier: z.preprocess((v) => (v == null ? "" : String(v).trim()), z.string().min(1).max(120)),
  password: z.preprocess((v) => (v == null ? "" : String(v)), z.string().min(1).max(120)),
});

export const loginWithSchoolCode = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    try {
      const raw =
        data &&
        typeof data === "object" &&
        "data" in (data as object) &&
        (data as { data: unknown }).data &&
        typeof (data as { data: unknown }).data === "object"
          ? (data as { data: unknown }).data
          : data;
      return loginInputSchema.parse(raw);
    } catch {
      return { schoolCode: "", identifier: "", password: "" };
    }
  })
  .handler(async ({ data }) => {
    try {
      const loginServer = await import("@/lib/login.server").catch(() => null);
      const hasAdminKey = loginServer?.hasAdminKey ?? (() => false);
      const provisionStudentLogin = loginServer?.provisionStudentLogin ?? (async () => null);
      const writeLoginAudit = loginServer?.writeLoginAudit ?? (async () => undefined);

      const url =
        process.env["SUPABASE_URL"] ??
        process.env["VITE_SUPABASE_URL"] ??
        process.env["NEXT_PUBLIC_SUPABASE_URL"];
      const anonKey =
        process.env["SUPABASE_PUBLISHABLE_KEY"] ??
        process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
        process.env["SUPABASE_ANON_KEY"] ??
        process.env["VITE_SUPABASE_ANON_KEY"] ??
        process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
      const serviceKey = resolveServiceKey();

      if (!url || !anonKey) {
        return { error: "Server configuration error. Contact support." };
      }

      const client = makeClient(url, anonKey);

      const schoolCode = (data.schoolCode ?? "").trim().toUpperCase();
      const ident = (data.identifier || "").trim();
      const password = data.password || "";
      if (!ident || !password) {
        return { error: "Enter your email / matric / staff ID and password." };
      }
      const emailLower = looksLikeEmail(ident) ? ident.toLowerCase() : "";

      const isSuperCode =
        schoolCode === "" || schoolCode === "SUPER" || schoolCode === "PLATFORM";
      if (looksLikeEmail(ident) && isSuperCode) {
        const { data: signIn, error } = await client.auth.signInWithPassword({
          email: emailLower,
          password,
        });
        if (error || !signIn?.session || !signIn?.user) {
          return { error: error?.message || "Invalid email or password." };
        }

        const token = signIn.session.access_token;
        const uid = signIn.user.id;
        let isSuper = false;

        try {
          const authed = makeClient(url, anonKey, token);
          const { data: rpcSuper } = await authed.rpc("is_super_admin");
          if (rpcSuper === true) isSuper = true;
          if (!isSuper) {
            const { data: myRoles } = await authed.rpc("get_my_roles");
            const list = Array.isArray(myRoles)
              ? myRoles.map((r: { role?: string } | string) =>
                  typeof r === "string" ? r : String((r as { role?: string }).role || ""),
                )
              : [];
            isSuper = list.some((r) => r.toLowerCase() === "super_admin");
          }
          if (!isSuper) {
            const { data: roles } = await authed.from("user_roles").select("role").eq("user_id", uid);
            isSuper = (roles ?? []).some(
              (r: { role: string }) => String(r.role).toLowerCase() === "super_admin",
            );
          }
        } catch {
          /* continue */
        }

        if (!isSuper && serviceKey) {
          try {
            const admin = makeClient(url, serviceKey);
            const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", uid);
            isSuper = (roles ?? []).some(
              (r: { role: string }) => String(r.role).toLowerCase() === "super_admin",
            );
          } catch {
            /* ignore */
          }
        }

        if (!isSuper) {
          return {
            error:
              "This account is not a platform super admin. Enter your school code to sign in as a school user.",
          };
        }

        try {
          await writeLoginAudit({
            schoolId: null,
            userId: uid,
            description: "Super admin / platform sign-in",
          });
        } catch {
          /* ignore */
        }

        return {
          session: {
            access_token: signIn.session.access_token,
            refresh_token: signIn.session.refresh_token,
          },
          role: "super_admin" as const,
        };
      }

      if (!schoolCode) {
        return { error: "School code is required for school accounts." };
      }

      let schoolId: string | null = null;
      let schoolStatus: string | null = null;

      try {
        const { data: rpcSchool, error: schoolErr } = await client.rpc("resolve_school_for_login", {
          _school_code: schoolCode,
        });
        if (schoolErr) console.warn("[login] resolve_school_for_login", schoolErr.message);
        const row = Array.isArray(rpcSchool) ? rpcSchool[0] : rpcSchool;
        if (row && typeof row === "object" && (row as { id?: string }).id) {
          schoolId = String((row as { id: string }).id);
          schoolStatus = String((row as { status?: string }).status || "");
        }
      } catch (e) {
        console.warn("[login] school rpc failed", e);
      }

      if (!schoolId && serviceKey) {
        try {
          const admin = makeClient(url, serviceKey);
          const { data: exact } = await admin
            .from("schools")
            .select("id, status")
            .ilike("school_code", schoolCode)
            .maybeSingle();
          if (exact?.id) {
            schoolId = exact.id as string;
            schoolStatus = String(exact.status || "");
          }
        } catch {
          /* ignore */
        }
      }

      if (schoolStatus && schoolStatus.toLowerCase() === "suspended") {
        return { error: "This school account is suspended. Contact support." };
      }

      let resolvedKind: string | null = null;
      const candidateEmails: string[] = [];

      if (looksLikeEmail(ident)) {
        candidateEmails.push(ident.toLowerCase());
      }

      try {
        const { data: resolved, error: idErr } = await client.rpc("resolve_login_identity", {
          _school_code: schoolCode,
          _identifier: ident,
        });
        if (idErr) console.warn("[login] resolve_login_identity", idErr.message);
        const row = Array.isArray(resolved) ? resolved[0] : resolved;
        if (row && typeof row === "object") {
          if ((row as { kind?: string }).kind === "school_inactive") {
            return { error: "This school is not active." };
          }
          if ((row as { email?: string }).email) {
            const em = String((row as { email: string }).email).toLowerCase();
            if (!candidateEmails.includes(em)) candidateEmails.push(em);
            resolvedKind = String((row as { kind?: string }).kind || "user");
          }
        }
      } catch {
        /* optional */
      }

      // Staff: resolve teacher/officer by staff_id or officer_id (RPC often missing on production)
      if (!looksLikeEmail(ident) && serviceKey && schoolId) {
        try {
          const admin = makeClient(url, serviceKey);
          const idLower = ident.toLowerCase();

          const { data: teachers } = await admin
            .from("teachers")
            .select("staff_id, profiles(email, auth_user_id)")
            .eq("school_id", schoolId)
            .limit(500);
          for (const t of teachers ?? []) {
            const sid = String((t as { staff_id?: string }).staff_id || "").trim();
            if (sid.toLowerCase() === idLower) {
              const em = String(
                ((t as { profiles?: { email?: string } | null }).profiles?.email || ""),
              )
                .trim()
                .toLowerCase();
              if (em && !candidateEmails.includes(em)) candidateEmails.unshift(em);
              resolvedKind = "teacher";
              const authId = (t as { profiles?: { auth_user_id?: string } | null }).profiles
                ?.auth_user_id;
              if (authId && password.trim().toLowerCase() === sid.toLowerCase()) {
                try {
                  await admin.auth.admin.updateUserById(authId, {
                    password,
                    email_confirm: true,
                  });
                } catch {
                  /* ignore */
                }
              }
              break;
            }
          }

          if (resolvedKind !== "teacher") {
            const { data: officers } = await admin
              .from("examination_officers")
              .select("officer_id, profiles(email, auth_user_id)")
              .eq("school_id", schoolId)
              .limit(500);
            for (const o of officers ?? []) {
              const oid = String((o as { officer_id?: string }).officer_id || "").trim();
              if (oid.toLowerCase() === idLower) {
                const em = String(
                  ((o as { profiles?: { email?: string } | null }).profiles?.email || ""),
                )
                  .trim()
                  .toLowerCase();
                if (em && !candidateEmails.includes(em)) candidateEmails.unshift(em);
                resolvedKind = "officer";
                const authId = (o as { profiles?: { auth_user_id?: string } | null }).profiles
                  ?.auth_user_id;
                if (authId && password.trim().toLowerCase() === oid.toLowerCase()) {
                  try {
                    await admin.auth.admin.updateUserById(authId, {
                      password,
                      email_confirm: true,
                    });
                  } catch {
                    /* ignore */
                  }
                }
                break;
              }
            }
          }
        } catch (e) {
          console.warn("[login] staff lookup", e);
        }
      }

      if (!looksLikeEmail(ident)) {
        const synth = studentSyntheticEmail(schoolCode, ident);
        if (!candidateEmails.includes(synth)) candidateEmails.push(synth);
        const safeMatric = ident.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const safeCode = schoolCode.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
        const alts = [
          `${safeMatric}@${safeCode || "school"}.student.d4exam.local`,
          `${ident.replace(/[^a-z0-9]+/gi, ".").toLowerCase()}@placeholder.local`,
          `${safeMatric.replace(/-/g, ".")}@placeholder.local`,
        ];
        for (const a of alts) {
          if (a && !candidateEmails.includes(a)) candidateEmails.push(a);
        }
      }

      if (!schoolId && candidateEmails.length === 0 && !looksLikeEmail(ident)) {
        return {
          error:
            "Invalid school code or user not found. Check school code and matric / email / staff ID.",
        };
      }

      if (!looksLikeEmail(ident) && hasAdminKey() && schoolId) {
        try {
          const provisioned = await provisionStudentLogin({
            schoolId,
            schoolCode,
            identifier: ident,
            password,
          });
          if (provisioned && "email" in provisioned && provisioned.email) {
            const em = String(provisioned.email).toLowerCase();
            if (!candidateEmails.includes(em)) candidateEmails.unshift(em);
            resolvedKind = "student";
          }
        } catch {
          /* skip */
        }
      }

      if (candidateEmails.length === 0) {
        return {
          error:
            "Could not find this user in the school. Check school code and email / matric / staff ID.",
        };
      }

      type SignInResult = {
        session: { access_token: string; refresh_token: string } | null;
        user: { id: string } | null;
      };
      let signIn: SignInResult | null = null;
      let lastError: string | null = null;

      for (const email of candidateEmails) {
        const attempt = await client.auth.signInWithPassword({ email, password });
        if (attempt.data?.session && attempt.data.user) {
          signIn = attempt.data as SignInResult;
          lastError = null;
          break;
        }
        lastError = attempt.error?.message || "Invalid credentials";
      }

      if (!signIn?.session && !looksLikeEmail(ident) && hasAdminKey() && schoolId) {
        try {
          const provisioned = await provisionStudentLogin({
            schoolId,
            schoolCode,
            identifier: ident,
            password,
          });
          if (provisioned && "email" in provisioned && provisioned.email && provisioned.password) {
            const retry = await client.auth.signInWithPassword({
              email: provisioned.email,
              password: provisioned.password,
            });
            if (retry.data?.session) {
              signIn = retry.data as SignInResult;
              lastError = null;
              resolvedKind = "student";
            } else {
              lastError = retry.error?.message || lastError;
            }
          } else if (provisioned && "error" in provisioned && provisioned.error) {
            return { error: String(provisioned.error) };
          }
        } catch (e) {
          console.error("[login] provision retry", e);
        }
      }

      if (!signIn?.session || !signIn.user) {
        return {
          error:
            lastError ||
            "Invalid credentials. Students: password is usually your matric number. Staff: password is your staff/officer ID.",
        };
      }

      try {
        await writeLoginAudit({
          schoolId,
          userId: signIn.user.id,
          description: resolvedKind ? `User signed in (${resolvedKind})` : "User signed in",
        });
      } catch {
        /* ignore */
      }

      const uid = signIn.user.id;
      const token = signIn.session.access_token;

      // Require real membership for school logins — never auto-link strangers to a school code
      if (schoolId && serviceKey) {
        try {
          const admin = makeClient(url, serviceKey);
          const { data: byAuth } = await admin
            .from("profiles")
            .select("id, school_id")
            .eq("auth_user_id", uid)
            .maybeSingle();
          const profileId = byAuth?.id ? String(byAuth.id) : null;
          const profileSchoolOk =
            byAuth?.school_id && String(byAuth.school_id) === String(schoolId);

          let roleOk = false;
          for (const rid of [uid, profileId].filter(Boolean) as string[]) {
            const { data: roles } = await admin
              .from("user_roles")
              .select("id, school_id, role")
              .eq("user_id", rid)
              .limit(20);
            if ((roles || []).some((r) => r.school_id && String(r.school_id) === String(schoolId))) {
              roleOk = true;
              break;
            }
          }

          if (!profileSchoolOk && !roleOk) {
            try {
              await client.auth.signOut();
            } catch {
              /* ignore */
            }
            return {
              error:
                "Invalid login details for this school. Check school code, email / ID, and password.",
            };
          }
        } catch (e) {
          console.warn("[login] membership check", e);
        }
      }

      const priority = ["super_admin", "school_admin", "examination_officer", "teacher", "student"];
      let primaryRole: string | null = null;

      const pickRole = (roles: string[]) => {
        const list = roles.map((r) => r.toLowerCase().trim()).filter(Boolean);
        return priority.find((r) => list.includes(r)) ?? list[0] ?? null;
      };

      try {
        const authed = makeClient(url, anonKey, token);
        try {
          const { data: myRoles } = await authed.rpc("get_my_roles");
          const list = Array.isArray(myRoles)
            ? myRoles.map((r: { role?: string } | string) =>
                typeof r === "string" ? r : String((r as { role?: string }).role || ""),
              )
            : [];
          primaryRole = pickRole(list);
        } catch {
          /* ignore */
        }
        if (!primaryRole) {
          const { data: roles } = await authed.from("user_roles").select("role").eq("user_id", uid);
          primaryRole = pickRole((roles ?? []).map((r: { role: string }) => String(r.role)));
        }
        if (!primaryRole) {
          const { data: rpcSuper } = await authed.rpc("is_super_admin");
          if (rpcSuper === true) primaryRole = "super_admin";
        }
        if (!primaryRole && resolvedKind) {
          const kindMap: Record<string, string> = {
            student: "student",
            teacher: "teacher",
            officer: "examination_officer",
            school_admin: "school_admin",
          };
          if (kindMap[resolvedKind]) primaryRole = kindMap[resolvedKind];
        }
      } catch (e) {
        console.warn("[login] role lookup failed", e);
      }

      if (!primaryRole && serviceKey) {
        try {
          const admin = makeClient(url, serviceKey);
          // Roles may be keyed by auth uid OR profiles.id
          const { data: prof } = await admin
            .from("profiles")
            .select("id")
            .eq("auth_user_id", uid)
            .maybeSingle();
          const ids = [uid, prof?.id ? String(prof.id) : ""].filter(Boolean);
          const roleList: string[] = [];
          for (const id of ids) {
            const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", id);
            for (const r of roles ?? []) {
              if (r?.role) roleList.push(String(r.role));
            }
          }
          primaryRole = pickRole(roleList);

          // Staff tables as authoritative role signal
          if (!primaryRole && prof?.id) {
            const pid = String(prof.id);
            const [{ data: eo }, { data: te }, { data: st }] = await Promise.all([
              admin.from("examination_officers").select("id").eq("profile_id", pid).limit(1),
              admin.from("teachers").select("id").eq("profile_id", pid).limit(1),
              admin.from("students").select("id").eq("profile_id", pid).limit(1),
            ]);
            if ((eo ?? []).length) primaryRole = "examination_officer";
            else if ((te ?? []).length) primaryRole = "teacher";
            else if ((st ?? []).length) primaryRole = "student";
            else {
              try {
                const { data: sa } = await admin
                  .from("school_admins")
                  .select("id")
                  .eq("profile_id", pid)
                  .limit(1);
                if ((sa ?? []).length) primaryRole = "school_admin";
              } catch {
                /* optional table */
              }
            }
          }
        } catch {
          /* ignore */
        }
      }

      if (!primaryRole && resolvedKind === "student") primaryRole = "student";
      if (!primaryRole && resolvedKind === "teacher") primaryRole = "teacher";
      if (!primaryRole && resolvedKind === "officer") primaryRole = "examination_officer";
      if (!primaryRole && resolvedKind === "school_admin") primaryRole = "school_admin";

      if (!primaryRole) {
        return {
          session: {
            access_token: signIn.session.access_token,
            refresh_token: signIn.session.refresh_token,
          },
          role: null,
          schoolId: schoolId || null,
          schoolCode: schoolCode || null,
          error:
            "Signed in, but no role is assigned. Ask your school admin to create/import this user again.",
        };
      }

      return {
        session: {
          access_token: signIn.session.access_token,
          refresh_token: signIn.session.refresh_token,
        },
        role: primaryRole,
        schoolId: schoolId || null,
        schoolCode: schoolCode || null,
      };
    } catch (e) {
      console.error("[login] unhandled", e);
      const msg = e instanceof Error ? e.message : "Unable to sign in right now.";
      if (typeof msg === "string" && (msg.includes("<!doctype") || msg.includes("<html") || msg.length > 400)) {
        return { error: "Unable to sign in right now. Please try again in a moment." };
      }
      return { error: msg || "Unable to sign in right now. Please try again." };
    }
  });

export const signInWithSchoolCode = loginWithSchoolCode;
