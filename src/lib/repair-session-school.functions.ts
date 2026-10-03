/**
 * Repair missing school_id on the signed-in user's profile using service role.
 * Fixes officer/teacher/admin "not linked to a school" after unlock.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type RepairSessionSchoolResult = {
  schoolId: string | null;
  schoolName: string | null;
  schoolCode: string | null;
  schoolLogoUrl: string | null;
  roles: string[];
  fullName: string | null;
  profileId: string | null;
};

export const repairMySessionSchool = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RepairSessionSchoolResult> => {
    const userId = context.userId as string;
    const empty: RepairSessionSchoolResult = {
      schoolId: null,
      schoolName: null,
      schoolCode: null,
      schoolLogoUrl: null,
      roles: [],
      fullName: null,
      profileId: null,
    };
    if (!userId) return empty;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (!supabaseAdmin) return empty;

    const { data: profileByAuth } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, school_id, email, status")
      .eq("auth_user_id", userId)
      .maybeSingle();
    let profile = profileByAuth;
    if (!profile?.id) {
      const { data: byId } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, school_id, email, status")
        .eq("id", userId)
        .maybeSingle();
      profile = byId;
    }

    const profileId = profile?.id ? String(profile.id) : userId;
    let schoolId = profile?.school_id ? String(profile.school_id) : null;
    const roles = new Set<string>();

    const ids = [...new Set([userId, profileId].filter(Boolean))];

    for (const id of ids) {
      const { data: urs } = await supabaseAdmin
        .from("user_roles")
        .select("role, school_id")
        .eq("user_id", id);
      for (const r of urs ?? []) {
        if (r.role) roles.add(String(r.role));
        if (!schoolId && r.school_id) schoolId = String(r.school_id);
      }
    }

    for (const id of ids) {
      const [eoRes, teRes, stRes] = await Promise.all([
        supabaseAdmin
          .from("examination_officers")
          .select("school_id, officer_id")
          .eq("profile_id", id)
          .limit(3),
        supabaseAdmin.from("teachers").select("school_id, staff_id").eq("profile_id", id).limit(3),
        supabaseAdmin
          .from("students")
          .select("school_id, matric_number")
          .eq("profile_id", id)
          .limit(3),
      ]);
      for (const eo of eoRes.data ?? []) {
        if (eo?.school_id) {
          if (!schoolId) schoolId = String(eo.school_id);
          roles.add("examination_officer");
        }
      }
      for (const te of teRes.data ?? []) {
        if (te?.school_id) {
          if (!schoolId) schoolId = String(te.school_id);
          roles.add("teacher");
        }
      }
      for (const st of stRes.data ?? []) {
        if (st?.school_id) {
          if (!schoolId) schoolId = String(st.school_id);
          roles.add("student");
        }
      }
      try {
        const { data: saRows } = await supabaseAdmin
          .from("school_admins")
          .select("school_id")
          .eq("profile_id", id)
          .limit(3);
        for (const sa of saRows ?? []) {
          if (sa?.school_id) {
            if (!schoolId) schoolId = String(sa.school_id);
            roles.add("school_admin");
          }
        }
      } catch {
        /* table may not exist */
      }
    }

    // Also match roles where user_id is auth id and school already known from roles
    if (!schoolId) {
      for (const id of ids) {
        const { data: urs } = await supabaseAdmin
          .from("user_roles")
          .select("role, school_id")
          .eq("user_id", id);
        for (const r of urs ?? []) {
          if (r.role) roles.add(String(r.role));
          if (!schoolId && r.school_id) schoolId = String(r.school_id);
        }
      }
    }

    // Persist school_id onto profile so future client sessions work
    if (schoolId && profileId) {
      try {
        await supabaseAdmin
          .from("profiles")
          .update({ school_id: schoolId, status: "active" } as never)
          .eq("id", profileId);
      } catch {
        /* ignore */
      }
      // Backfill school_id on any role rows missing it
      for (const rid of [profileId, userId]) {
        const { data: roleRows } = await supabaseAdmin
          .from("user_roles")
          .select("id, school_id, role")
          .eq("user_id", rid);
        for (const r of roleRows ?? []) {
          if (!(r as { school_id?: string }).school_id) {
            try {
              await supabaseAdmin
                .from("user_roles")
                .update({ school_id: schoolId } as never)
                .eq("id", (r as { id: string }).id);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }

    let schoolName: string | null = null;
    let schoolCode: string | null = null;
    let schoolLogoUrl: string | null = null;
    if (schoolId) {
      const { data: school } = await supabaseAdmin
        .from("schools")
        .select("name, school_code, logo_url")
        .eq("id", schoolId)
        .maybeSingle();
      schoolName = school?.name ?? null;
      schoolCode = school?.school_code ?? null;
      schoolLogoUrl = (school?.logo_url as string | null) ?? null;
    }

    return {
      schoolId,
      schoolName,
      schoolCode,
      schoolLogoUrl,
      roles: [...roles],
      fullName: (profile?.full_name as string | null) || null,
      profileId,
    };
  });
