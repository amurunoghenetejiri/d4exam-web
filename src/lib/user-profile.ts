import { supabase } from "@/integrations/supabase/client";

export type PublicUserProfile = {
  authUserId: string;
  profileId: string | null;
  fullName: string;
  avatarUrl: string | null;
  phone: string | null;
  schoolId: string | null;
  matricNumber: string | null;
  departmentId: string | null;
  departmentName: string | null;
  levelId: string | null;
  levelName: string | null;
  studentId: string | null;
  status: string | null;
  isMe: boolean;
  isBlockedByMe: boolean;
  isBlockedMe: boolean;
};

function mapRow(
  row: Record<string, unknown>,
  targetUserId: string,
  myUserId?: string | null,
  extras?: { departmentName?: string | null; levelName?: string | null },
): PublicUserProfile {
  const authUserId = String(row.auth_user_id || targetUserId);
  return {
    authUserId,
    profileId: (row.profile_id as string) || (row.id as string) || null,
    fullName:
      String(row.full_name || "").trim() ||
      [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
      "Student",
    avatarUrl:
      (row.avatar_url as string) ||
      (row.profile_photo_url as string) ||
      null,
    phone: (row.phone as string) || null,
    schoolId: (row.school_id as string) || null,
    matricNumber: (row.matric_number as string) || null,
    departmentId: (row.department_id as string) || null,
    departmentName:
      extras?.departmentName ??
      ((row.department_name as string) || (row.department as string) || null),
    levelId: (row.level_id as string) || null,
    levelName:
      extras?.levelName ?? ((row.level_name as string) || (row.level as string) || null),
    studentId: (row.student_id as string) || null,
    status: (row.status as string) || null,
    isMe: Boolean(myUserId && myUserId === authUserId),
    isBlockedByMe: false,
    isBlockedMe: false,
  };
}

async function enrichDeptLevel(p: PublicUserProfile): Promise<PublicUserProfile> {
  let departmentName = p.departmentName;
  let levelName = p.levelName;
  let matricNumber = p.matricNumber;
  let departmentId = p.departmentId;
  let levelId = p.levelId;

  // Prefer SECURITY DEFINER list RPC (returns department/level text + matric)
  if ((!departmentName || !levelName || !matricNumber) && p.authUserId) {
    try {
      const { data: rows } = await supabase.rpc("list_school_students_for_messaging", {
        p_query: null,
        p_department_id: null,
        p_limit: 200,
      });
      const hit = (Array.isArray(rows) ? rows : []).find(
        (r: Record<string, unknown>) =>
          String(r.auth_user_id || "") === p.authUserId ||
          String(r.profile_id || "") === (p.profileId || ""),
      ) as Record<string, unknown> | undefined;
      if (hit) {
        departmentName = departmentName || (hit.department as string) || null;
        levelName = levelName || (hit.level as string) || null;
        matricNumber = matricNumber || (hit.matric_number as string) || null;
        departmentId = departmentId || (hit.department_id as string) || null;
        levelId = levelId || (hit.level_id as string) || null;
      }
    } catch {
      /* ignore */
    }
  }

  if (departmentName && levelName && matricNumber) {
    return { ...p, departmentName, levelName, matricNumber, departmentId, levelId };
  }

  if (departmentId && !departmentName) {
    try {
      const { data: d } = await supabase
        .from("departments")
        .select("name")
        .eq("id", departmentId)
        .maybeSingle();
      departmentName = (d as { name?: string } | null)?.name || null;
    } catch {
      /* ignore */
    }
  }
  if (levelId && !levelName) {
    try {
      const { data: l } = await supabase
        .from("levels")
        .select("name")
        .eq("id", levelId)
        .maybeSingle();
      levelName = (l as { name?: string } | null)?.name || null;
    } catch {
      /* ignore */
    }
  }
  return { ...p, departmentName, levelName, matricNumber, departmentId, levelId };
}

async function attachBlocks(
  p: PublicUserProfile,
  myUserId?: string | null,
): Promise<PublicUserProfile> {
  if (!myUserId || myUserId === p.authUserId) return p;
  try {
    const { data: blocks } = await supabase
      .from("user_blocks")
      .select("blocker_id, blocked_id")
      .or(
        `and(blocker_id.eq.${myUserId},blocked_id.eq.${p.authUserId}),and(blocker_id.eq.${p.authUserId},blocked_id.eq.${myUserId})`,
      );
    let isBlockedByMe = false;
    let isBlockedMe = false;
    for (const b of blocks || []) {
      if (b.blocker_id === myUserId) isBlockedByMe = true;
      if (b.blocker_id === p.authUserId) isBlockedMe = true;
    }
    return { ...p, isBlockedByMe, isBlockedMe };
  } catch {
    return p;
  }
}

/** Direct table fallback when RPC returns null */
async function fetchProfileFallback(
  targetUserId: string,
): Promise<Record<string, unknown> | null> {
  // By auth_user_id
  const byAuth = await supabase
    .from("profiles")
    .select(
      "id, auth_user_id, full_name, first_name, last_name, profile_photo_url, phone, school_id, status",
    )
    .eq("auth_user_id", targetUserId)
    .maybeSingle();
  let profile = byAuth.data as Record<string, unknown> | null;

  // By profile id
  if (!profile) {
    const byId = await supabase
      .from("profiles")
      .select(
        "id, auth_user_id, full_name, first_name, last_name, profile_photo_url, phone, school_id, status",
      )
      .eq("id", targetUserId)
      .maybeSingle();
    profile = byId.data as Record<string, unknown> | null;
  }

  if (!profile) return null;

  const profileId = profile.id as string;
  const { data: student } = await supabase
    .from("students")
    .select("id, matric_number, department_id, level_id, status")
    .eq("profile_id", profileId)
    .limit(1)
    .maybeSingle();

  return {
    auth_user_id: profile.auth_user_id,
    profile_id: profile.id,
    full_name: profile.full_name,
    first_name: profile.first_name,
    last_name: profile.last_name,
    avatar_url: profile.profile_photo_url,
    profile_photo_url: profile.profile_photo_url,
    phone: profile.phone,
    school_id: profile.school_id,
    status: profile.status,
    matric_number: (student as { matric_number?: string } | null)?.matric_number,
    department_id: (student as { department_id?: string } | null)?.department_id,
    level_id: (student as { level_id?: string } | null)?.level_id,
    student_id: (student as { id?: string } | null)?.id,
  };
}

export async function fetchPublicProfile(
  targetUserId: string,
  myUserId?: string | null,
): Promise<PublicUserProfile | null> {
  let id = (targetUserId || "").trim();
  if (!id || id === "undefined" || id === "null") return null;

  if (id === "me") {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return null;
      id = uid;
      myUserId = uid;
    } catch {
      return null;
    }
  }

  // Validate UUID-ish ids (reject garbage)
  if (id.length < 8) return null;

  let row: Record<string, unknown> | null = null;

  // 1) SECURITY DEFINER RPC
  try {
    const { data, error } = await supabase.rpc("get_user_public_profile", {
      p_user_id: id,
    });
    if (error) {
      console.warn("[profile] get_user_public_profile", error.message);
    } else if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      // RPC may return empty object
      if (d.auth_user_id || d.full_name || d.profile_id || d.avatar_url) {
        row = d;
      }
    }
  } catch (e) {
    console.warn("[profile] rpc threw", e);
  }

  // 2) Messaging name resolver (often works when profile RLS is tight)
  if (!row) {
    try {
      const { data: names } = await supabase.rpc("resolve_messaging_peer_names", {
        p_user_ids: [id],
      });
      const first = Array.isArray(names) ? (names[0] as Record<string, unknown>) : null;
      if (first && (first.full_name || first.auth_user_id)) {
        row = {
          auth_user_id: first.auth_user_id || id,
          full_name: first.full_name || "Student",
          avatar_url: first.avatar_url || null,
        };
        // Enrich matric/dept from students when we have auth id
        try {
          const { data: prof } = await supabase
            .from("profiles")
            .select("id, school_id")
            .eq("auth_user_id", String(first.auth_user_id || id))
            .maybeSingle();
          if (prof) {
            row.profile_id = (prof as { id?: string }).id;
            row.school_id = (prof as { school_id?: string }).school_id;
            const { data: st } = await supabase
              .from("students")
              .select("id, matric_number, department_id, level_id")
              .eq("profile_id", (prof as { id: string }).id)
              .limit(1)
              .maybeSingle();
            if (st) {
              row.matric_number = (st as { matric_number?: string }).matric_number;
              row.department_id = (st as { department_id?: string }).department_id;
              row.level_id = (st as { level_id?: string }).level_id;
              row.student_id = (st as { id?: string }).id;
            }
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 3) Direct table fallback
  if (!row) {
    try {
      row = await fetchProfileFallback(id);
    } catch (e) {
      console.warn("[profile] fallback", e);
      row = null;
    }
  }

  // 4) Minimal profiles select
  if (!row) {
    try {
      const { data: p } = await supabase
        .from("profiles")
        .select(
          "id, auth_user_id, full_name, first_name, last_name, profile_photo_url, school_id, status, phone",
        )
        .or(`auth_user_id.eq.${id},id.eq.${id}`)
        .limit(1)
        .maybeSingle();
      if (p) {
        row = {
          auth_user_id: (p as { auth_user_id?: string }).auth_user_id || id,
          profile_id: (p as { id?: string }).id,
          full_name: (p as { full_name?: string }).full_name,
          first_name: (p as { first_name?: string }).first_name,
          last_name: (p as { last_name?: string }).last_name,
          avatar_url: (p as { profile_photo_url?: string }).profile_photo_url,
          school_id: (p as { school_id?: string }).school_id,
          status: (p as { status?: string }).status,
          phone: (p as { phone?: string }).phone,
        };
        const pid = row.profile_id as string | undefined;
        if (pid) {
          const { data: st } = await supabase
            .from("students")
            .select("id, matric_number, department_id, level_id")
            .eq("profile_id", pid)
            .limit(1)
            .maybeSingle();
          if (st) {
            row.matric_number = (st as { matric_number?: string }).matric_number;
            row.department_id = (st as { department_id?: string }).department_id;
            row.level_id = (st as { level_id?: string }).level_id;
            row.student_id = (st as { id?: string }).id;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 5) Students table by joining profiles (some schools store name on students)
  if (!row) {
    try {
      const { data: st } = await supabase
        .from("students")
        .select("id, profile_id, matric_number, department_id, level_id, school_id, full_name")
        .limit(1);
      // can't filter by auth without join — skip if no profile
    } catch {
      /* ignore */
    }
  }

  if (!row) return null;

  // Ensure student academic fields even if RPC omitted them
  if (!row.matric_number || !row.department_id || !row.level_id) {
    try {
      const pid = (row.profile_id as string) || (row.id as string);
      const authId = (row.auth_user_id as string) || id;
      let profileId = pid;
      if (!profileId) {
        const { data: pr } = await supabase
          .from("profiles")
          .select("id")
          .eq("auth_user_id", authId)
          .maybeSingle();
        profileId = (pr as { id?: string } | null)?.id || "";
      }
      if (profileId) {
        const { data: st } = await supabase
          .from("students")
          .select("id, matric_number, department_id, level_id, school_id")
          .eq("profile_id", profileId)
          .limit(1)
          .maybeSingle();
        if (st) {
          row.matric_number = row.matric_number || (st as { matric_number?: string }).matric_number;
          row.department_id = row.department_id || (st as { department_id?: string }).department_id;
          row.level_id = row.level_id || (st as { level_id?: string }).level_id;
          row.student_id = row.student_id || (st as { id?: string }).id;
          row.school_id = row.school_id || (st as { school_id?: string }).school_id;
        }
      }
    } catch {
      /* ignore */
    }
  }

  let profile = mapRow(row, id, myUserId);
  try {
    profile = await enrichDeptLevel(profile);
  } catch {
    /* ignore */
  }
  try {
    profile = await attachBlocks(profile, myUserId);
  } catch {
    /* ignore */
  }
  return profile;
}

export async function blockUser(blockerId: string, blockedId: string) {
  const { error } = await supabase.from("user_blocks").insert({
    blocker_id: blockerId,
    blocked_id: blockedId,
  });
  if (error) throw new Error(error.message);
}

export async function unblockUser(blockerId: string, blockedId: string) {
  const { error } = await supabase
    .from("user_blocks")
    .delete()
    .eq("blocker_id", blockerId)
    .eq("blocked_id", blockedId);
  if (error) throw new Error(error.message);
}

export async function listBlockedUsers(myUserId: string) {
  const { data, error } = await supabase
    .from("user_blocks")
    .select("blocked_id, created_at")
    .eq("blocker_id", myUserId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const profiles: PublicUserProfile[] = [];
  for (const r of data || []) {
    try {
      const p = await fetchPublicProfile(r.blocked_id as string, myUserId);
      if (p) profiles.push(p);
    } catch {
      /* skip */
    }
  }
  return profiles;
}

export async function updateMyProfilePhoto(profileId: string, file: File) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `profiles/${profileId}/${Date.now()}.${ext}`;
  const buckets = ["avatars", "profile-photos", "public", "media"];
  let publicUrl: string | null = null;
  for (const bucket of buckets) {
    const { error } = await supabase.storage.from(bucket).upload(path, file, {
      upsert: true,
      contentType: file.type || "image/jpeg",
    });
    if (!error) {
      const { data } = supabase.storage.from(bucket).getPublicUrl(path);
      publicUrl = data.publicUrl;
      break;
    }
  }
  if (!publicUrl) throw new Error("Upload failed");
  const { error: updErr } = await supabase
    .from("profiles")
    .update({ profile_photo_url: publicUrl } as never)
    .eq("id", profileId);
  if (updErr) throw new Error(updErr.message);
  return publicUrl;
}
