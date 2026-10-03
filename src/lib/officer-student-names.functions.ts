/**
 * Resolve student display names for staff (bypasses client RLS gaps).
 * Matches by students.id, profile_id, student_id text, or matric.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ResolvedStudentName = {
  full_name: string;
  matric_number: string | null;
  student_id: string | null;
  department_name?: string | null;
  level_name?: string | null;
};

async function assertStaffOfSchool(
  admin: { from: (t: string) => any },
  userId: string,
  schoolId: string,
): Promise<boolean> {
  const { data: profile } = await admin
    .from("profiles")
    .select("id, school_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const pid = profile?.id ? String(profile.id) : null;
  if (profile && String(profile.school_id || "") === schoolId) return true;

  const ids = [userId, pid].filter(Boolean) as string[];
  for (const id of ids) {
    try {
      const [{ data: ur }, { data: eo }, { data: te }, saRes] = await Promise.all([
        admin.from("user_roles").select("id").eq("user_id", id).eq("school_id", schoolId).limit(1),
        admin.from("examination_officers").select("id").eq("profile_id", id).eq("school_id", schoolId).maybeSingle(),
        admin.from("teachers").select("id").eq("profile_id", id).eq("school_id", schoolId).maybeSingle(),
        admin.from("school_admins").select("id").eq("profile_id", id).eq("school_id", schoolId).maybeSingle(),
      ]);
      const sa = (saRes as { data?: { id?: string } | null })?.data;
      if ((ur && ur.length) || eo?.id || te?.id || sa?.id) return true;
    } catch {
      const [{ data: ur }, { data: eo }, { data: te }] = await Promise.all([
        admin.from("user_roles").select("id").eq("user_id", id).eq("school_id", schoolId).limit(1),
        admin.from("examination_officers").select("id").eq("profile_id", id).eq("school_id", schoolId).maybeSingle(),
        admin.from("teachers").select("id").eq("profile_id", id).eq("school_id", schoolId).maybeSingle(),
      ]);
      if ((ur && ur.length) || eo?.id || te?.id) return true;
    }
  }
  // Super admin
  const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", userId);
  if ((roles ?? []).some((r: { role?: string }) => r.role === "super_admin")) return true;
  return false;
}

export const resolveStudentNamesForOfficer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      data,
      context,
    }: {
      data: { schoolId: string; studentIds: string[] };
      context: { userId: string };
    }): Promise<Record<string, ResolvedStudentName>> => {
      const schoolId = String(data?.schoolId || "").trim();
      const studentIds = [...new Set((data?.studentIds || []).map(String).filter(Boolean))].slice(0, 400);
      if (!schoolId || !studentIds.length) return {};

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const userId = context.userId;

      const ok = await assertStaffOfSchool(supabaseAdmin, userId, schoolId);
      if (!ok) return {};

      // Plain columns only — nested joins can fail under some RLS/schema states
      // Production students has NO full_name — names come from profiles only
      const selectCols =
        "id, matric_number, student_id, profile_id, department_id, level_id";

      const { data: byId } = await supabaseAdmin
        .from("students")
        .select(selectCols)
        .eq("school_id", schoolId)
        .in("id", studentIds);

      const { data: byProf } = await supabaseAdmin
        .from("students")
        .select(selectCols)
        .eq("school_id", schoolId)
        .in("profile_id", studentIds);

      const { data: schoolSlice } = await supabaseAdmin
        .from("students")
        .select(selectCols)
        .eq("school_id", schoolId)
        .limit(2000);

      type Raw = {
        id: string;
        matric_number?: string | null;
        student_id?: string | null;
        profile_id?: string | null;
        department_id?: string | null;
        level_id?: string | null;
        departments?: { name?: string } | null;
        levels?: { name?: string } | null;
      };

      const pool = new Map<string, Raw>();
      for (const s of [...(byId ?? []), ...(byProf ?? []), ...(schoolSlice ?? [])] as Raw[]) {
        pool.set(String(s.id), s);
      }

      // Department / level names (separate queries — reliable)
      {
        const deptIds = [...new Set([...pool.values()].map((s) => s.department_id).filter(Boolean))] as string[];
        const levelIds = [...new Set([...pool.values()].map((s) => s.level_id).filter(Boolean))] as string[];
        const deptMap = new Map<string, string>();
        const levelMap = new Map<string, string>();
        if (deptIds.length) {
          const { data } = await supabaseAdmin.from("departments").select("id, name").in("id", deptIds.slice(0, 200));
          for (const d of data ?? []) deptMap.set(String(d.id), String(d.name || ""));
        }
        if (levelIds.length) {
          const { data } = await supabaseAdmin.from("levels").select("id, name").in("id", levelIds.slice(0, 200));
          for (const l of data ?? []) levelMap.set(String(l.id), String(l.name || ""));
        }
        for (const s of pool.values()) {
          if (s.department_id && deptMap.get(String(s.department_id))) {
            s.departments = { name: deptMap.get(String(s.department_id)) };
          }
          if (s.level_id && levelMap.get(String(s.level_id))) {
            s.levels = { name: levelMap.get(String(s.level_id)) };
          }
        }
      }

      const out: Record<string, ResolvedStudentName> = {};
      const needProfiles: { key: string; profileId: string }[] = [];

      function put(key: string, s: Raw) {
        const entry: ResolvedStudentName = {
          full_name: "",
          matric_number: s.matric_number ?? null,
          student_id: s.student_id ?? null,
          department_name: s.departments?.name ?? null,
          level_name: s.levels?.name ?? null,
        };
        out[key] = entry;
        out[String(s.id)] = entry;
        if (s.profile_id) out[String(s.profile_id)] = entry;
        if (s.student_id) out[String(s.student_id)] = entry;
        if (s.matric_number) out[String(s.matric_number)] = entry;
        // Always resolve name from profiles
        if (s.profile_id) needProfiles.push({ key, profileId: String(s.profile_id) });
      }

      for (const id of studentIds) {
        const direct = pool.get(id);
        if (direct) {
          put(id, direct);
          continue;
        }
        // profile_id match
        let hit: Raw | undefined;
        for (const s of pool.values()) {
          if (String(s.profile_id || "") === id) {
            hit = s;
            break;
          }
          if (String(s.student_id || "") === id || String(s.matric_number || "") === id) {
            hit = s;
            break;
          }
        }
        if (hit) put(id, hit);
      }

      if (needProfiles.length) {
        const pids = [...new Set(needProfiles.map((x) => x.profileId))];
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("id, full_name")
          .in("id", pids.slice(0, 400));
        const pmap = new Map(
          (profiles ?? []).map((p: { id: string; full_name?: string | null }) => [
            p.id,
            String(p.full_name || "").trim(),
          ]),
        );
        for (const key of Object.keys(out)) {
          const entry = out[key];
          // Re-find student row for this key in pool
          const row = pool.get(key);
          const pid = row?.profile_id
            ? String(row.profile_id)
            : needProfiles.find((x) => x.key === key)?.profileId;
          if (!pid) continue;
          const n = pmap.get(pid);
          if (n) {
            out[key] = { ...entry, full_name: entry.full_name?.trim() ? entry.full_name : n };
          }
        }
        // Ensure every requested id has a name if we found a profile
        for (const { key, profileId } of needProfiles) {
          const n = pmap.get(profileId);
          if (n && out[key] && !String(out[key].full_name || "").trim()) {
            out[key] = { ...out[key], full_name: n };
          }
        }
      }

      // Final pass: any empty full_name → try profiles by student profile_id in pool
      {
        const emptyKeys = Object.entries(out)
          .filter(([, v]) => !String(v.full_name || "").trim())
          .map(([k]) => k);
        if (emptyKeys.length) {
          const pids = [
            ...new Set(
              emptyKeys
                .map((k) => {
                  const row = [...pool.values()].find(
                    (s) =>
                      String(s.id) === k ||
                      String(s.profile_id || "") === k ||
                      String(s.student_id || "") === k ||
                      String(s.matric_number || "") === k,
                  );
                  return row?.profile_id ? String(row.profile_id) : null;
                })
                .filter(Boolean),
            ),
          ] as string[];
          if (pids.length) {
            const { data: profiles } = await supabaseAdmin
              .from("profiles")
              .select("id, full_name")
              .in("id", pids.slice(0, 400));
            const pmap = new Map(
              (profiles ?? []).map((p: { id: string; full_name?: string | null }) => [
                String(p.id),
                String(p.full_name || "").trim(),
              ]),
            );
            for (const k of emptyKeys) {
              const row = [...pool.values()].find(
                (s) =>
                  String(s.id) === k ||
                  String(s.profile_id || "") === k ||
                  String(s.student_id || "") === k ||
                  String(s.matric_number || "") === k,
              );
              const n = row?.profile_id ? pmap.get(String(row.profile_id)) : null;
              if (n && out[k]) out[k] = { ...out[k], full_name: n };
            }
          }
        }
      }

      return out;
    },
  );
