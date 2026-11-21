// Server-only helpers for the login flow.
// Works with production schema: students has NO full_name column (names live on profiles only).

export function hasAdminKey() {
  return Boolean(
    (process.env["SUPABASE_URL"] || process.env["VITE_SUPABASE_URL"] || process.env["NEXT_PUBLIC_SUPABASE_URL"]) &&
      (process.env["SUPABASE_SERVICE_ROLE_KEY"] ||
        process.env["SUPABASE_SECRET_KEY"] ||
        process.env["SUPABASE_SERVICE_KEY"] ||
        process.env["SB_SERVICE_ROLE_KEY"]),
  );
}

function normalizeMatric(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matricMatches(stored: string, password: string) {
  const a = normalizeMatric(stored);
  const b = normalizeMatric(password);
  return a.length > 0 && a === b;
}

function normalizePersonName(s: string) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if identifier looks like a person name (not email/matric). */
function looksLikePersonName(s: string) {
  const t = s.trim();
  if (!t || t.includes("@")) return false;
  if (/^\d+$/.test(t.replace(/[\s\-\/]/g, ""))) return false;
  // Has letters
  return /[a-zA-Z]/.test(t);
}

function namesMatch(fullName: string, identifier: string) {
  const full = normalizePersonName(fullName);
  const id = normalizePersonName(identifier);
  if (!full || !id) return false;
  if (full === id) return true;
  // identifier is first + last subset of full name tokens
  const ft = full.split(" ").filter(Boolean);
  const it = id.split(" ").filter(Boolean);
  if (it.length === 0) return false;
  // all identifier tokens appear in full name (order-independent)
  if (it.every((tok) => ft.some((f) => f === tok || f.startsWith(tok) || tok.startsWith(f)))) {
    return it.length >= 1 && (it.length >= 2 || ft.some((f) => f === it[0]));
  }
  // full name contains identifier string
  if (full.includes(id)) return true;
  return false;
}

/** All historical synthetic email formats used across import/login versions. */
export function studentAuthEmailCandidates(opts: {
  schoolId: string;
  schoolCode: string;
  matric: string;
}): string[] {
  const matric = opts.matric.trim();
  const safeMatric = matric.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const safeMatricDot = matric.toLowerCase().replace(/[^a-z0-9]+/g, ".");
  const safeCode = opts.schoolCode.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const safeSchool = opts.schoolId.replace(/-/g, "").slice(0, 12);
  const out = [
    `${safeMatric}@${safeCode || "school"}.student.d4exam.local`,
    `${safeMatric}.${safeSchool}@student.d4exam.local`,
    `${safeMatricDot}@placeholder.local`,
    `${safeMatric.replace(/-/g, ".")}@placeholder.local`,
    `${safeMatric}@placeholder.local`,
  ];
  return out.filter((e, i) => e && out.indexOf(e) === i);
}

export type ProvisionResult =
  | { email: string; password: string }
  | { error: string }
  | null;

type StudentLookupRow = {
  id: string;
  student_id: string;
  matric_number: string | null;
  status: string;
  profile_id: string | null;
};

// Production schema: no full_name on students
const STUDENT_COLS = "id, student_id, matric_number, status, profile_id";

/**
 * Student login: school code + (matric OR any identifier) + password = matric.
 * Finds student by matric/student_id (password or identifier).
 * Names are optional — production DB has no students.full_name.
 */
export async function provisionStudentLogin(params: {
  schoolId: string;
  schoolCode: string;
  identifier: string;
  password: string;
}): Promise<ProvisionResult> {
  if (!hasAdminKey()) {
    return {
      error:
        "Could not prepare student login. Ensure SUPABASE_SERVICE_ROLE_KEY is set on the server.",
    };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const schoolId = params.schoolId;
  const schoolCode = params.schoolCode.trim();
  const identifier = params.identifier.trim();
  const password = params.password.trim();

  if (!identifier || !password) return null;

  let student: StudentLookupRow | null = null;

  // Load students for this school (in-memory match so slashes never break filters)
  const { data: list, error: listErr } = await supabaseAdmin
    .from("students")
    .select(STUDENT_COLS)
    .eq("school_id", schoolId)
    .limit(5000);

  if (listErr) {
    console.error("[provisionStudentLogin] students select failed:", listErr.message);
    return { error: "Could not look up students. Contact support." };
  }

  const rows = (list ?? []) as StudentLookupRow[];
  const idNorm = normalizeMatric(identifier);
  const passNorm = normalizeMatric(password);
  const idLower = identifier.toLowerCase();

  // 1) Identifier is matric / student_id
  student =
    rows.find((s) => {
      const m = (s.matric_number || "").trim();
      const sid = (s.student_id || "").trim();
      return (
        m.toLowerCase() === idLower ||
        sid.toLowerCase() === idLower ||
        (idNorm.length >= 4 && (normalizeMatric(m) === idNorm || normalizeMatric(sid) === idNorm))
      );
    }) ?? null;

  // 2) Password is the matric — find student by password (works when user types name as identifier)
  if (!student && passNorm.length >= 4) {
    const byPass = rows.filter(
      (s) =>
        matricMatches(s.matric_number || "", password) ||
        matricMatches(s.student_id || "", password),
    );
    if (byPass.length === 1) {
      student = byPass[0]!;
    } else if (byPass.length > 1) {
      // Prefer the one whose profile name matches identifier
      let preferred: StudentLookupRow | null = null;
      if (looksLikePersonName(identifier)) {
        const profileIds = byPass.map((s) => s.profile_id).filter(Boolean) as string[];
        if (profileIds.length) {
          const { data: profs } = await supabaseAdmin
            .from("profiles")
            .select("id, full_name")
            .in("id", profileIds);
          const matchId = (profs || []).find((pr) =>
            namesMatch(String((pr as { full_name?: string }).full_name || ""), identifier),
          )?.id;
          if (matchId) preferred = byPass.find((s) => s.profile_id === matchId) ?? null;
        }
      }
      student =
        preferred ??
        byPass.find((s) => (s.matric_number || "").trim().toLowerCase() === password.toLowerCase()) ??
        byPass[0] ??
        null;
    }
  }

  // 3) Identifier is a name — match profiles.full_name, password must be that student's matric
  if (!student && looksLikePersonName(identifier) && passNorm.length >= 4) {
    const profileIds = rows.map((s) => s.profile_id).filter(Boolean) as string[];
    if (profileIds.length) {
      // Chunk in case of large schools
      const nameHits: { id: string; full_name: string | null }[] = [];
      for (let i = 0; i < profileIds.length; i += 200) {
        const slice = profileIds.slice(i, i + 200);
        const { data: profs } = await supabaseAdmin
          .from("profiles")
          .select("id, full_name")
          .in("id", slice);
        for (const pr of profs || []) {
          const fn = String((pr as { full_name?: string }).full_name || "");
          if (namesMatch(fn, identifier)) {
            nameHits.push({ id: String((pr as { id: string }).id), full_name: fn });
          }
        }
      }
      const matchedStudents = rows.filter((s) =>
        nameHits.some((h) => h.id === s.profile_id),
      );
      const withPass = matchedStudents.filter(
        (s) =>
          matricMatches(s.matric_number || "", password) ||
          matricMatches(s.student_id || "", password),
      );
      if (withPass.length === 1) student = withPass[0]!;
      else if (withPass.length > 1) {
        student =
          withPass.find((s) => (s.matric_number || "").trim().toLowerCase() === password.toLowerCase()) ??
          withPass[0]!;
      } else if (matchedStudents.length === 1) {
        // Name matched one student but password not matric — fail clearly later
        student = null;
      }
    }
  }

  if (!student) return null;

  if (String(student.status || "").toLowerCase() === "suspended") {
    return { error: "This student account is suspended. Contact your school." };
  }

  const matric = (student.matric_number || student.student_id || "").trim();
  if (!matric) return null;

  // Password must equal matric (slash/case ignored)
  if (!matricMatches(matric, password) && !matricMatches(student.student_id || "", password)) {
    return null;
  }

  const candidates = studentAuthEmailCandidates({ schoolId, schoolCode, matric });
  let fullName = identifier;
  if (matricMatches(identifier, matric) || normalizeMatric(identifier) === normalizeMatric(matric)) {
    fullName = matric;
  }

  let authUserId: string | null = null;
  let workingEmail = candidates[0]!;

  if (student.profile_id) {
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id, auth_user_id, email, full_name")
      .eq("id", student.profile_id)
      .maybeSingle();
    if (profile?.auth_user_id) {
      authUserId = profile.auth_user_id as string;
      const stored = ((profile.email as string) || "").trim().toLowerCase();
      if (stored) workingEmail = stored;
      const pn = ((profile.full_name as string) || "").trim();
      if (pn) fullName = pn;
      try {
        await supabaseAdmin.auth.admin.updateUserById(authUserId, {
          password: password,
          email_confirm: true,
        });
      } catch {
        /* ignore */
      }
      return { email: workingEmail, password: password };
    }
  }

  try {
    for (let page = 1; page <= 8 && !authUserId; page++) {
      const { data: listed } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      const users = listed?.users ?? [];
      const found = users.find((u) => {
        const em = (u.email || "").toLowerCase();
        return candidates.some((c) => c.toLowerCase() === em);
      });
      if (found?.id) {
        authUserId = found.id;
        workingEmail = (found.email || candidates[0]!).toLowerCase();
        break;
      }
      if (users.length < 200) break;
    }
  } catch {
    /* continue to create */
  }

  if (authUserId) {
    try {
      await supabaseAdmin.auth.admin.updateUserById(authUserId, {
        password: password,
        email_confirm: true,
        user_metadata: { full_name: fullName, role: "student", school_code: schoolCode },
      });
    } catch {
      /* ignore */
    }
  } else {
    const preferred =
      candidates.find((c) => c.includes("@student.d4exam.local") && c.includes(".")) ||
      candidates[0]!;
    workingEmail = preferred;
    const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: preferred,
      password: password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role: "student",
        school_code: schoolCode,
      },
    });
    if (createError || !created?.user) {
      let createdOk = false;
      for (const em of candidates) {
        if (em === preferred) continue;
        const { data: c2, error: e2 } = await supabaseAdmin.auth.admin.createUser({
          email: em,
          password: password,
          email_confirm: true,
          user_metadata: { full_name: fullName, role: "student", school_code: schoolCode },
        });
        if (!e2 && c2?.user) {
          authUserId = c2.user.id;
          workingEmail = em;
          createdOk = true;
          break;
        }
      }
      if (!createdOk) {
        console.error("[provisionStudentLogin] createUser failed", createError?.message);
        return {
          error:
            createError?.message ??
            "Could not prepare student login. Ensure SUPABASE_SERVICE_ROLE_KEY is set on the server.",
        };
      }
    } else {
      authUserId = created.user.id;
      workingEmail = preferred;
    }
  }

  if (!authUserId) return { error: "Could not resolve auth user." };

  const { data: existingProfile } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  let profileId = existingProfile?.id as string | undefined;
  if (!profileId) {
    const { data: newProfile, error: pErr } = await supabaseAdmin
      .from("profiles")
      .insert({
        auth_user_id: authUserId,
        school_id: schoolId,
        full_name: fullName,
        email: workingEmail,
        status: "active",
      })
      .select("id")
      .single();
    if (pErr || !newProfile) {
      return { error: pErr?.message ?? "Could not create student profile." };
    }
    profileId = newProfile.id as string;
  } else {
    await supabaseAdmin
      .from("profiles")
      .update({
        full_name: fullName,
        school_id: schoolId,
        email: workingEmail,
        status: "active",
      } as never)
      .eq("id", profileId);
  }

  await supabaseAdmin
    .from("students")
    .update({
      profile_id: profileId,
      status: "active",
    } as never)
    .eq("id", student.id);

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

  return { email: workingEmail, password: password };
}

export async function writeLoginAudit(params: {
  schoolId: string | null;
  userId: string | null;
  description: string;
}) {
  try {
    if (!hasAdminKey()) return;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("audit_logs").insert({
      school_id: params.schoolId,
      actor_user_id: params.userId,
      action: "login",
      entity_type: "profile",
      entity_id: null,
      description: params.description,
    } as never);
  } catch {
    /* never block sign-in */
  }
}
