import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function looksLikeEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function generateTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export const reviewSchoolApplication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        applicationId: z.string().uuid(),
        decision: z.enum(["approved", "rejected", "under_review", "more_information_required"]),
        notes: z.string().max(2000).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { data: isSuper } = await context.supabase.rpc("is_super_admin");
    if (!isSuper) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: app, error: appError } = await supabaseAdmin
      .from("school_applications")
      .select("*")
      .eq("id", data.applicationId)
      .maybeSingle();
    if (appError || !app) throw new Error("Application not found");

    if (data.decision !== "approved") {
      await supabaseAdmin
        .from("school_applications")
        .update({
          status: data.decision,
          review_notes: data.notes ?? null,
          reviewed_by: context.userId,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", data.applicationId);

      await supabaseAdmin.from("audit_logs").insert({
        actor_user_id: context.userId,
        actor_role: "super_admin",
        action: `application_${data.decision}`,
        entity_type: "school_application",
        entity_id: app.id,
        description: `Application for ${app.school_name} marked ${data.decision}`,
      });

      try {
        const email = String(app.applicant_email || app.official_email || "").trim().toLowerCase();
        const schoolName = String(app.school_name || "School");
        if (data.decision === "rejected") {
          const { notifyApplicantApplicationRejected } = await import("@/lib/notify-applicants");
          void notifyApplicantApplicationRejected({
            applicantEmail: email,
            schoolName,
            applicationId: data.applicationId,
            reason: data.notes || "Your application was not approved.",
          });
          if (email.includes("@")) {
            try {
              const { sendSchoolApplicationRejectedEmail } = await import("@/lib/email.server");
              void sendSchoolApplicationRejectedEmail({
                to: email,
                applicantName: String(app.applicant_name || "Applicant"),
                schoolName,
                reason: data.notes || null,
              });
            } catch { /* ignore */ }
          }
        } else if (data.decision === "more_information_required") {
          const { notifyApplicantNeedsChanges } = await import("@/lib/notify-applicants");
          void notifyApplicantNeedsChanges({
            applicantEmail: email,
            schoolName,
            applicationId: data.applicationId,
            reason: data.notes || "Please update your application with the requested information.",
          });
          if (email.includes("@")) {
            try {
              const { sendSchoolApplicationNeedsInfoEmail } = await import("@/lib/email.server");
              void sendSchoolApplicationNeedsInfoEmail({
                to: email,
                applicantName: String(app.applicant_name || "Applicant"),
                schoolName,
                reason: data.notes || null,
              });
            } catch { /* ignore */ }
          }
        } else if (data.decision === "under_review") {
          if (email.includes("@")) {
            try {
              const { sendSchoolApplicationUnderReviewEmail } = await import("@/lib/email.server");
              void sendSchoolApplicationUnderReviewEmail({
                to: email,
                applicantName: String(app.applicant_name || "Applicant"),
                schoolName,
              });
            } catch { /* ignore */ }
          }
        }
      } catch {
        /* best-effort */
      }

      return {
        ok: true,
        schoolCode: null,
        adminEmail: null,
        adminPassword: null,
        schoolName: app.school_name as string,
        emailSent: false,
        emailError: null,
      };
    }

    const schoolName = String(app.school_name || "School").trim();
    const applicantName = String(app.applicant_name || "Applicant").trim();
    const applicantEmail = String(app.applicant_email || app.official_email || "").trim().toLowerCase();
    if (!applicantEmail || !looksLikeEmail(applicantEmail)) {
      throw new Error("Application is missing a valid applicant email");
    }

    const base =
      schoolName.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase() || "SCHOOL";
    let schoolCode = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const suffix = Math.floor(1000 + Math.random() * 9000);
      const candidate = `${base}${suffix}`.slice(0, 12);
      const { data: existing } = await supabaseAdmin
        .from("schools")
        .select("id")
        .ilike("school_code", candidate)
        .maybeSingle();
      if (!existing) {
        schoolCode = candidate;
        break;
      }
    }
    if (!schoolCode) throw new Error("Could not generate a unique school code");

    const adminPassword = generateTempPassword();
    const adminEmail = applicantEmail;

    const { data: school, error: schoolErr } = await supabaseAdmin
      .from("schools")
      .insert({
        name: schoolName,
        school_code: schoolCode,
        official_email: app.official_email || applicantEmail,
        official_phone: app.official_phone || app.applicant_phone || null,
        address: app.address || null,
        city: app.city || null,
        state: app.state || null,
        country: app.country || null,
        school_type: app.school_type || null,
        status: "active",
        subscription_plan: "standard",
        subscription_status: "active",
        approved_at: new Date().toISOString(),
        approved_by: context.userId,
      } as never)
      .select("id")
      .single();
    if (schoolErr || !school) throw new Error(schoolErr?.message || "Could not create school");

    const nameParts = applicantName.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || "School";
    const lastName = nameParts.slice(1).join(" ") || "Admin";

    let authUserId: string | null = null;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
      user_metadata: { full_name: applicantName, role: "school_admin" },
    });
    authUserId = created?.user?.id ?? null;
    if (createErr || !authUserId) {
      const { data: listed } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const found = (listed?.users ?? []).find((u) => (u.email || "").toLowerCase() === adminEmail);
      if (found) {
        authUserId = found.id;
        await supabaseAdmin.auth.admin.updateUserById(found.id, { password: adminPassword });
      } else {
        throw new Error(createErr?.message || "Could not create school admin account");
      }
    }

    const { data: existingProfile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (!existingProfile) {
      await supabaseAdmin.from("profiles").insert({
        auth_user_id: authUserId,
        school_id: school.id,
        first_name: firstName,
        last_name: lastName,
        full_name: applicantName,
        email: adminEmail,
        status: "active",
      } as never);
    } else {
      await supabaseAdmin
        .from("profiles")
        .update({
          school_id: school.id,
          first_name: firstName,
          last_name: lastName,
          full_name: applicantName,
          email: adminEmail,
          status: "active",
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", existingProfile.id);
    }

    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("id")
      .eq("user_id", authUserId)
      .eq("role", "school_admin")
      .eq("school_id", school.id)
      .maybeSingle();
    if (!roleRow) {
      await supabaseAdmin.from("user_roles").insert({
        user_id: authUserId,
        role: "school_admin",
        school_id: school.id,
      } as never);
    }

    await supabaseAdmin
      .from("school_applications")
      .update({
        status: "approved",
        review_notes: data.notes ?? null,
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
        issued_school_code: schoolCode,
        issued_admin_email: adminEmail,
        issued_admin_password: adminPassword,
      } as never)
      .eq("id", data.applicationId);

    await supabaseAdmin.from("audit_logs").insert({
      actor_user_id: context.userId,
      actor_role: "super_admin",
      action: "application_approved",
      entity_type: "school_application",
      entity_id: app.id,
      description: `Approved ${schoolName} → school ${schoolCode}`,
    } as never);

    let emailSent = false;
    let emailError: string | null = null;
    try {
      const { sendSchoolApprovalEmail } = await import("@/lib/email.server");
      const er = await sendSchoolApprovalEmail({
        to: adminEmail,
        applicantName,
        schoolName,
        schoolCode,
        adminEmail,
        adminPassword,
        officialEmail: (app.official_email as string) || null,
        phone: (app.applicant_phone as string) || null,
      });
      emailSent = Boolean(er?.ok);
      emailError = er?.ok ? null : er?.error || null;
    } catch (e) {
      emailError = (e as Error).message || "Email failed";
    }

    try {
      const { notifyApplicantApplicationApproved } = await import("@/lib/notify-applicants");
      void notifyApplicantApplicationApproved({
        recipientUserId: authUserId,
        applicantEmail: adminEmail,
        schoolName,
        schoolId: schoolCode,
        applicationId: data.applicationId,
        loginHint: `School ID: ${schoolCode}. Sign in at /login with your email.`,
      });
    } catch {
      /* best-effort */
    }

    return {
      ok: true,
      schoolCode,
      adminEmail,
      adminPassword,
      schoolName,
      emailSent,
      emailError,
    };
  });

const personSchema = z.object({
  role: z.enum(["student", "teacher", "examination_officer", "school_admin"]),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().optional(),
  identifier: z.string().min(1),
  matricNumber: z.string().optional(),
  departmentId: z.string().nullable().optional(),
  facultyId: z.string().nullable().optional(),
  levelId: z.string().nullable().optional(),
});

export const createSchoolUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => personSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: profileRow } = await context.supabase
      .from("profiles")
      .select("school_id")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    const schoolId = profileRow?.school_id;
    if (!schoolId) throw new Error("No school context");

    const { data: canManage } = await context.supabase.rpc("can_manage_school", {
      _school: schoolId,
    });
    if (!canManage) throw new Error("Forbidden");

    const { createPerson } = await import("@/lib/users.server");
    const result = await createPerson(schoolId, data as unknown as Parameters<typeof createPerson>[1], { db: context.supabase as never });

    // Welcome email (never block account creation)
    try {
      const email = String((result as { email?: string }).email || (data as { email?: string }).email || "").trim();
      if (email && email.includes("@") && !email.endsWith(".local")) {
        const { data: school } = await context.supabase
          .from("schools")
          .select("name, school_code, code")
          .eq("id", schoolId)
          .maybeSingle();
        const sch = school as { name?: string; school_code?: string; code?: string } | null;
        const { sendStaffWelcomeEmail } = await import("@/lib/email.server");
        void sendStaffWelcomeEmail({
          to: email,
          fullName: `${(data as { firstName?: string }).firstName || ""} ${(data as { lastName?: string }).lastName || ""}`.trim() || "Staff",
          role: String((data as { role?: string }).role || "teacher"),
          schoolName: sch?.name || null,
          schoolCode: sch?.school_code || sch?.code || null,
          identifier: String((result as { identifier?: string }).identifier || (data as { identifier?: string }).identifier || ""),
          password: String((result as { password?: string }).password || (data as { identifier?: string }).identifier || ""),
        });
      }
    } catch (e) {
      console.warn("[email] staff welcome skipped", e);
    }

    try {
      await context.supabase.from("audit_logs").insert({
        school_id: schoolId,
        actor_user_id: context.userId,
        actor_role: "school_admin",
        action: `${data.role}_${result.action ?? "created"}`,
        entity_type: data.role,
        entity_id: result.id ?? null,
        description: `${data.firstName} ${data.lastName} (${data.identifier})`,
      } as never);
    } catch {
      /* ignore */
    }

    return result;
  });

export const importStudentsBulk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        rows: z.array(
          z.object({
            rowNumber: z.number().optional(),
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            email: z.string().optional(),
            identifier: z.string().optional(),
            matricNumber: z.string().optional(),
            departmentId: z.string().nullable().optional(),
            facultyId: z.string().nullable().optional(),
            levelId: z.string().nullable().optional(),
          }),
        ),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { data: profileRow } = await context.supabase
      .from("profiles")
      .select("school_id")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    const schoolId = profileRow?.school_id;
    if (!schoolId) throw new Error("No school context");

    const { data: canManage } = await context.supabase.rpc("can_manage_school", {
      _school: schoolId,
    });
    if (!canManage) throw new Error("Forbidden");

    const { upsertStudent } = await import("@/lib/users.server");

    let created = 0;
    let updated = 0;
    const failures: {
      rowNumber?: number;
      name: string;
      identifier: string;
      matricNumber: string;
      reason: string;
    }[] = [];

    for (let i = 0; i < data.rows.length; i++) {
      const row = data.rows[i];
      const rowNumber = row.rowNumber ?? i + 2;
      const matric = (row.matricNumber || row.identifier || "").trim();
      const identifier = (row.identifier || matric).trim();
      const firstName = (row.firstName || "Student").trim() || "Student";
      const lastName = (row.lastName || "Student").trim() || "Student";
      const name = `${firstName} ${lastName}`.trim();

      try {
        if (!identifier) throw new Error("Matric / student ID is required");
        if (identifier.length < 4) throw new Error("Matric / student ID must be at least 4 characters");

        let email = (row.email || "").trim().toLowerCase();
        if (email && !looksLikeEmail(email)) email = "";

        const person = await upsertStudent(schoolId, {
          role: "student",
          firstName,
          lastName,
          email: email || `${identifier.replace(/[^a-z0-9]+/gi, ".").toLowerCase()}@placeholder.local`,
          identifier,
          matricNumber: matric || identifier,
          departmentId: row.departmentId ?? null,
          facultyId: row.facultyId ?? null,
          levelId: row.levelId ?? null,
        });

        if (person.action === "updated") updated += 1;
        else created += 1;
      } catch (e) {
        failures.push({
          rowNumber,
          name,
          identifier: identifier || matric,
          matricNumber: matric || identifier,
          reason: (e as Error).message || "Unknown error",
        });
      }
    }

    try {
      await context.supabase.from("audit_logs").insert({
        school_id: schoolId,
        actor_user_id: context.userId,
        actor_role: "school_admin",
        action: "students_imported",
        entity_type: "student",
        description: `Imported students: ${created} created, ${updated} updated, ${failures.length} failed`,
      } as never);
    } catch {
      /* ignore */
    }

    try {
      if (created > 0) {
        const { notifySuperAdminsStudentsAdded } = await import("@/lib/notify");
        void notifySuperAdminsStudentsAdded({ schoolId, count: created });
      }
    } catch {
      /* never block import */
    }

    const processed = created + updated;
    return {
      total: data.rows.length,
      created,
      updated,
      failed: failures.length,
      processed,
      failures,
    };
  });

/** Superadmin: list all school applications (bypasses RLS via service role). */
export const listSchoolApplications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler((async ({ context }: { context: any }) => {
    const { data: isSuper } = await context.supabase.rpc("is_super_admin");
    if (!isSuper) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const colsWithDocs =
      "id, school_name, school_type, country, state, city, address, official_email, official_phone, applicant_name, applicant_email, applicant_phone, tracking_code, status, created_at, review_notes, documents";
    const colsNoDocs =
      "id, school_name, school_type, country, state, city, address, official_email, official_phone, applicant_name, applicant_email, applicant_phone, tracking_code, status, created_at, review_notes";

    let { data, error } = await supabaseAdmin
      .from("school_applications")
      .select(colsWithDocs)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.warn("[listSchoolApplications] with documents failed:", error.message);
      const retry = await supabaseAdmin
        .from("school_applications")
        .select(colsNoDocs)
        .order("created_at", { ascending: false })
        .limit(200);
      data = retry.data as typeof data;
      error = retry.error;
    }

    if (error) {
      const msg = String(error.message || "");
      const soft =
        /does not exist|relation|permission denied|schema cache|PGRST/i.test(msg) ||
        (error as { code?: string }).code === "42P01" ||
        (error as { code?: string }).code === "42703" ||
        (error as { code?: string }).code === "PGRST205";
      console.error("[listSchoolApplications]", error);
      if (soft) return [] as Array<Record<string, unknown>>;
      throw new Error(error.message || "Could not load applications");
    }
    return (data ?? []) as Array<Record<string, unknown>>;
  }) as never);
