import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";


/** Turn Postgres unique/FK errors into clear user-facing messages. */
function friendlyDbError(message: string, fallback = "Could not save. Please try again."): string {
  const m = String(message || "");
  if (/profiles_auth_user_id_key|auth_user_id/i.test(m) || /duplicate key.*auth_user/i.test(m)) {
    return "This person already has an account. Use a different email, or open their existing profile.";
  }
  if (/profiles_email|duplicate key.*email/i.test(m)) {
    return "This email is already registered. Use another email or update the existing user.";
  }
  if (/officer_id|staff_id|matric_number|student_id|duplicate key.*unique/i.test(m)) {
    return "This ID is already in use for someone in this school. Choose a different ID.";
  }
  if (/duplicate key|unique constraint|23505/i.test(m)) {
    return "This person or ID already exists. Check the list below or use a different email / ID.";
  }
  if (/foreign key|23503/i.test(m)) {
    return "Related record is missing (for example department). Create it first, then try again.";
  }
  if (/row-level security|42501/i.test(m)) {
    return "You do not have permission to do this. Sign in again as school admin.";
  }
  return m || fallback;
}

function hasServiceRoleKey(): boolean {
  return Boolean(
    process.env["SUPABASE_SERVICE_ROLE_KEY"] ||
      process.env["SUPABASE_SECRET_KEY"] ||
      process.env["SUPABASE_SERVICE_KEY"] ||
      process.env["SB_SERVICE_ROLE_KEY"],
  );
}

function publicSupabaseEnv() {
  const url =
    process.env["SUPABASE_URL"] ||
    process.env["VITE_SUPABASE_URL"] ||
    process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const key =
    process.env["SUPABASE_PUBLISHABLE_KEY"] ||
    process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
    process.env["SUPABASE_ANON_KEY"] ||
    process.env["VITE_SUPABASE_ANON_KEY"];
  return { url, key };
}

function serviceRoleKey(): string {
  return (
    process.env["SUPABASE_SERVICE_ROLE_KEY"] ||
    process.env["SUPABASE_SECRET_KEY"] ||
    process.env["SUPABASE_SERVICE_KEY"] ||
    process.env["SB_SERVICE_ROLE_KEY"] ||
    ""
  );
}

async function createStaffAuthUser(opts: {
  email: string;
  password: string;
  fullName: string;
  role: string;
}): Promise<{ id: string }> {
  const { url, key } = publicSupabaseEnv();
  if (!url) {
    throw new Error(
      "Missing SUPABASE_URL on the server. Check Vercel env (SUPABASE_URL / VITE_SUPABASE_URL).",
    );
  }

  const service = serviceRoleKey();
  const email = opts.email.trim().toLowerCase();

  if (service) {
    const admin = createClient<Database>(url, service, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    let existingId: string | null = null;
    try {
      for (let page = 1; page <= 5 && !existingId; page++) {
        const { data: listed } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        const found = listed?.users?.find((u) => (u.email || "").toLowerCase() === email);
        if (found?.id) existingId = found.id;
        if (!listed?.users?.length || listed.users.length < 200) break;
      }
    } catch {
      /* continue to create */
    }

    if (existingId) {
      const { error: updErr } = await admin.auth.admin.updateUserById(existingId, {
        password: opts.password,
        email_confirm: true,
        user_metadata: { full_name: opts.fullName, role: opts.role },
      });
      if (updErr) {
        throw new Error(updErr.message || "Could not update existing login for this email.");
      }
      return { id: existingId };
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: opts.password,
      email_confirm: true,
      user_metadata: { full_name: opts.fullName, role: opts.role },
    });
    if (createErr || !created.user?.id) {
      const msg = createErr?.message || "Could not create auth user";
      if (/already|registered|exists/i.test(msg)) {
        throw new Error(
          `An account with email ${email} already exists. Try a different email, or reuse the same Officer/Staff ID password after checking Auth users.`,
        );
      }
      throw new Error(msg);
    }
    return { id: created.user.id };
  }

  if (!key) {
    throw new Error(
      "Missing publishable key and service role key. Add SUPABASE_SERVICE_ROLE_KEY on Vercel (recommended) so officer/teacher create does not send emails.",
    );
  }

  const anon = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data, error } = await anon.auth.signUp({
    email,
    password: opts.password,
    options: {
      data: { full_name: opts.fullName, role: opts.role },
    },
  });

  if (error) {
    const msg = error.message || "Could not create auth user";
    if (/rate limit|email rate/i.test(msg)) {
      throw new Error(
        "Email rate limit exceeded. Add SUPABASE_SERVICE_ROLE_KEY on Vercel so staff accounts are created without sending emails, or wait a few minutes and try again. Also disable Confirm email in Supabase Auth settings.",
      );
    }
    if (/already|registered|exists/i.test(msg)) {
      throw new Error(
        `An account with email ${email} already exists. Use a different email, or delete the existing auth user in Supabase → Authentication → Users.`,
      );
    }
    throw new Error(msg);
  }
  if (!data.user?.id) {
    throw new Error(
      "Could not create auth user. Disable Confirm email in Supabase Auth, or add SUPABASE_SERVICE_ROLE_KEY on Vercel.",
    );
  }
  return { id: data.user.id };
}

export interface PersonInput {
  role: "student" | "teacher" | "examination_officer";
  firstName: string;
  lastName: string;
  email: string;
  identifier: string;
  matricNumber?: string | undefined;
  departmentId?: string | null | undefined;
  facultyId?: string | null | undefined;
  levelId?: string | null | undefined;
}

export interface CreatePersonResult {
  id: string;
  email: string;
  password: string;
  identifier: string;
  role: string;
  fullName: string;
  action: "created" | "updated";
}

function studentSyntheticEmail(schoolId: string, matric: string) {
  const safeMatric = matric.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const safeSchool = schoolId.replace(/-/g, "").slice(0, 12);
  return `${safeMatric}.${safeSchool}@student.d4exam.local`;
}

export async function createPerson(
  schoolId: string,
  data: PersonInput,
  opts?: { db?: SupabaseClient<Database> },
): Promise<CreatePersonResult> {
  if (data.role === "student") {
    return upsertStudent(schoolId, data);
  }

  const password = data.identifier.trim();
  if (password.length < 4) {
    throw new Error(
      "Identifier (matric/staff ID) must be at least 4 characters — it is also the login password.",
    );
  }

  const fullName = `${data.firstName} ${data.lastName}`.trim();

  const authUser = await createStaffAuthUser({
    email: data.email,
    password,
    fullName,
    role: data.role,
  });

  // Prefer service role so staff rows always land (avoids RLS half-creates)
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = (hasServiceRoleKey() ? supabaseAdmin : opts?.db) as SupabaseClient<Database> | undefined;
  if (!db) {
    throw new Error(
      "Cannot write staff records: no admin session. Sign in as school admin and try again.",
    );
  }

  // Reuse profile if this auth user / email already exists
  let profileId: string | null = null;
  let action: "created" | "updated" = "created";
  {
    const { data: byAuth } = await db
      .from("profiles")
      .select("id")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (byAuth?.id) {
      profileId = String(byAuth.id);
      action = "updated";
      const { error: upErr } = await db
        .from("profiles")
        .update({
          school_id: schoolId,
          first_name: data.firstName,
          last_name: data.lastName,
          full_name: fullName,
          email: data.email,
          status: "active",
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", profileId);
      if (upErr) throw new Error(friendlyDbError(upErr.message));
    } else {
      const { data: byEmail } = await db
        .from("profiles")
        .select("id")
        .ilike("email", data.email)
        .maybeSingle();
      if (byEmail?.id) {
        profileId = String(byEmail.id);
        action = "updated";
        const { error: upErr } = await db
          .from("profiles")
          .update({
            auth_user_id: authUser.id,
            school_id: schoolId,
            first_name: data.firstName,
            last_name: data.lastName,
            full_name: fullName,
            status: "active",
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id", profileId);
        if (upErr) throw new Error(friendlyDbError(upErr.message));
      }
    }
  }

  if (!profileId) {
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .insert({
        auth_user_id: authUser.id,
        school_id: schoolId,
        first_name: data.firstName,
        last_name: data.lastName,
        full_name: fullName,
        email: data.email,
        status: "active",
      } as never)
      .select("id")
      .single();
    if (profileError || !profile) {
      throw new Error(friendlyDbError(profileError?.message ?? "Could not create profile"));
    }
    profileId = String(profile.id);
  }

  // Ensure role row
  const { data: existingRole } = await db
    .from("user_roles")
    .select("id")
    .eq("user_id", authUser.id)
    .eq("role", data.role)
    .eq("school_id", schoolId)
    .maybeSingle();
  if (!existingRole) {
    const { error: roleErr } = await db
      .from("user_roles")
      .insert({ user_id: authUser.id, school_id: schoolId, role: data.role } as never);
    if (roleErr && !/duplicate|unique/i.test(roleErr.message)) {
      throw new Error(friendlyDbError(roleErr.message));
    }
  }

  if (data.role === "teacher") {
    const { data: existingT } = await db
      .from("teachers")
      .select("id")
      .eq("school_id", schoolId)
      .or(`staff_id.ilike.${data.identifier},profile_id.eq.${profileId}`)
      .limit(1)
      .maybeSingle();
    if (existingT?.id) {
      await db
        .from("teachers")
        .update({
          staff_id: data.identifier,
          department_id: data.departmentId ?? null,
          faculty_id: data.facultyId ?? null,
          employment_status: "active",
          profile_id: profileId,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", existingT.id);
      return {
        id: String(existingT.id),
        email: data.email,
        password,
        identifier: data.identifier,
        role: data.role,
        fullName,
        action: "updated",
      };
    }
    const { data: row, error } = await db
      .from("teachers")
      .insert({
        profile_id: profileId,
        school_id: schoolId,
        staff_id: data.identifier,
        department_id: data.departmentId ?? null,
        faculty_id: data.facultyId ?? null,
        employment_status: "active",
      } as never)
      .select("id")
      .single();
    if (error) throw new Error(friendlyDbError(error.message));
    return {
      id: row.id as string,
      email: data.email,
      password,
      identifier: data.identifier,
      role: data.role,
      fullName,
      action,
    };
  }

  // examination_officer
  const { data: existingO } = await db
    .from("examination_officers")
    .select("id")
    .eq("school_id", schoolId)
    .or(`officer_id.ilike.${data.identifier},profile_id.eq.${profileId}`)
    .limit(1)
    .maybeSingle();
  if (existingO?.id) {
    await db
      .from("examination_officers")
      .update({
        officer_id: data.identifier,
        status: "active",
        profile_id: profileId,
        department_id: data.departmentId ?? null,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", existingO.id);
    return {
      id: String(existingO.id),
      email: data.email,
      password,
      identifier: data.identifier,
      role: data.role,
      fullName,
      action: "updated",
    };
  }

  const insertPayload: Record<string, unknown> = {
    profile_id: profileId,
    school_id: schoolId,
    officer_id: data.identifier,
    status: "active",
  };
  if (data.departmentId) insertPayload.department_id = data.departmentId;

  const { data: row, error } = await db
    .from("examination_officers")
    .insert(insertPayload as never)
    .select("id")
    .single();
  if (error) throw new Error(friendlyDbError(error.message));
  return {
    id: row.id as string,
    email: data.email,
    password,
    identifier: data.identifier,
    role: data.role,
    fullName,
    action,
  };
}

export async function upsertStudent(
  schoolId: string,
  data: PersonInput,
): Promise<CreatePersonResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const matric = (data.matricNumber || data.identifier || "").trim();
  const identifier = (data.identifier || matric).trim();
  if (matric.length < 4) {
    throw new Error("Matric / student ID must be at least 4 characters.");
  }

  const fullName = `${data.firstName} ${data.lastName}`.trim();
  const emailRaw = (data.email || "").trim().toLowerCase();
  const hasRealEmail =
    Boolean(emailRaw) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) &&
    !emailRaw.endsWith(".local") &&
    !emailRaw.includes("placeholder");
  // Auth still needs an address; profile.email stays empty until the student adds one
  const authEmail = hasRealEmail ? emailRaw : studentSyntheticEmail(schoolId, matric);
  const profileEmail: string | null = hasRealEmail ? emailRaw : null;
  const email = hasRealEmail ? emailRaw : ""; // returned to UI — never show .local placeholders

  const { data: existingList, error: findErr } = await supabaseAdmin
    .from("students")
    .select("id, profile_id, student_id, matric_number, status")
    .eq("school_id", schoolId)
    .or(`matric_number.ilike.${matric},student_id.ilike.${identifier}`)
    .limit(5);

  if (findErr) throw new Error(friendlyDbError(findErr.message));

  const existing =
    (existingList ?? []).find(
      (s) =>
        (s.matric_number || "").trim().toLowerCase() === matric.toLowerCase() ||
        (s.student_id || "").trim().toLowerCase() === identifier.toLowerCase(),
    ) ?? null;

  if (existing) {
    const updatePayload: Record<string, unknown> = {
      student_id: identifier,
      matric_number: matric,
      status: existing.status === "suspended" ? "suspended" : "active",
      updated_at: new Date().toISOString(),
    };
    if (data.facultyId) updatePayload.faculty_id = data.facultyId;
    if (data.departmentId) updatePayload.department_id = data.departmentId;
    if (data.levelId) updatePayload.level_id = data.levelId;

    const { error: upStu } = await supabaseAdmin
      .from("students")
      .update(updatePayload as never)
      .eq("id", existing.id)
      .eq("school_id", schoolId);
    if (upStu) throw new Error(upStu.message);

    if (existing.profile_id) {
      const profilePatch: Record<string, unknown> = {
        first_name: data.firstName,
        last_name: data.lastName,
        full_name: fullName,
        updated_at: new Date().toISOString(),
      };
      if (hasRealEmail) profilePatch.email = profileEmail;
      await supabaseAdmin
        .from("profiles")
        .update(profilePatch as never)
        .eq("id", existing.profile_id);
    }

    return {
      id: existing.id as string,
      email,
      password: matric,
      identifier,
      role: "student",
      fullName,
      action: "updated",
    };
  }

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: authEmail,
    password: matric,
    email_confirm: true,
    user_metadata: { full_name: fullName, role: "student" },
  });

  let authUserId: string | null = created?.user?.id ?? null;
  if (createError || !authUserId) {
    const { data: listed } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = (listed?.users ?? []).find((u) => (u.email || "").toLowerCase() === authEmail.toLowerCase());
    if (found) {
      authUserId = found.id;
      try {
        await supabaseAdmin.auth.admin.updateUserById(found.id, { password: matric });
      } catch {
        /* ignore */
      }
    } else {
      throw new Error(createError?.message ?? "Could not create student auth user");
    }
  }

  const { data: existingProfile } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  let profileId = existingProfile?.id as string | undefined;
  if (!profileId) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .insert({
        auth_user_id: authUserId,
        school_id: schoolId,
        first_name: data.firstName,
        last_name: data.lastName,
        full_name: fullName,
        email: profileEmail,
        status: "active",
      })
      .select("id")
      .single();
    if (profileError || !profile) throw new Error(friendlyDbError(profileError?.message ?? "Could not create profile"));
    profileId = profile.id as string;
  }

  const { data: roleRow } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("user_id", authUserId)
    .eq("role", "student")
    .eq("school_id", schoolId)
    .maybeSingle();
  if (!roleRow) {
    await supabaseAdmin.from("user_roles").insert({
      user_id: authUserId,
      school_id: schoolId,
      role: "student",
    });
  }

  const { data: row, error } = await supabaseAdmin
    .from("students")
    .insert({
      profile_id: profileId,
      school_id: schoolId,
      student_id: identifier,
      matric_number: matric,
      faculty_id: data.facultyId ?? null,
      department_id: data.departmentId ?? null,
      level_id: data.levelId ?? null,
      status: "active",
    })
    .select("id")
    .single();

  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      const { data: raced } = await supabaseAdmin
        .from("students")
        .select("id")
        .eq("school_id", schoolId)
        .ilike("matric_number", matric)
        .maybeSingle();
      if (raced?.id) {
        return {
          id: raced.id as string,
          email,
          password: matric,
          identifier,
          role: "student",
          fullName,
          action: "updated",
        };
      }
    }
    throw new Error(error.message);
  }

  return {
    id: row.id as string,
    email,
    password: matric,
    identifier,
    role: "student",
    fullName,
    action: "created",
  };
}
