// @ts-nocheck
/**
 * D4EXAM campus messaging helpers.
 * Uses conversations / conversation_members / campus_messages.
 * Officer channel remains on student_officer_reports.
 */
import { supabase } from "@/integrations/supabase/client";

/** Resolve school_id for the logged-in user from profiles / students. */
export async function resolveMySchoolId(preferred?: string | null): Promise<string | null> {
  if (preferred) return preferred;
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, school_id")
    .eq("auth_user_id", uid)
    .maybeSingle();
  if (profile?.school_id) return profile.school_id as string;
  if (profile?.id) {
    const { data: st } = await supabase
      .from("students")
      .select("school_id")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (st?.school_id) return st.school_id as string;
  }
  const { data: st2 } = await supabase
    .from("students")
    .select("school_id")
    .eq("profile_id", uid)
    .maybeSingle();
  return (st2?.school_id as string) || null;
}


export type ConversationType = "direct" | "group";
export type GroupKind = "study" | "course" | "class" | "project" | "general";

export type ConversationRow = {
  id: string;
  school_id: string;
  type: ConversationType;
  title: string | null;
  description: string | null;
  avatar_url: string | null;
  group_kind: GroupKind | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_sender_id: string | null;
};

export type CampusMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string | null;
  attachment_url: string | null;
  attachment_type: string | null;
  reply_to_id: string | null;
  forwarded_from_id: string | null;
  client_id: string | null;
  duration_sec: number | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  /** Set when at least one recipient device has received the message */
  delivered_at?: string | null;
};

export type MessageTick = "none" | "pending" | "sent" | "delivered" | "read";

/** WhatsApp-style status for the SENDER only. */
export function computeMessageTick(
  m: CampusMessage,
  opts: { mine: boolean; peerLastReadAt?: string | null },
): MessageTick {
  if (!opts.mine) return "none";
  // Only optimistic local messages (not yet on server) show clock
  if (String(m.id || "").startsWith("opt-")) return "pending";
  // Read: peer opened conversation after this message
  if (opts.peerLastReadAt) {
    const msgT = new Date(m.created_at).getTime();
    const readT = new Date(opts.peerLastReadAt).getTime();
    if (Number.isFinite(msgT) && Number.isFinite(readT) && readT >= msgT) {
      return "read";
    }
  }
  // Delivered to recipient device
  if (m.delivered_at) return "delivered";
  // On server, not yet delivered
  return "sent";
}

export type StudentDiscover = {
  id: string;
  profile_id: string | null;
  auth_user_id: string | null;
  full_name: string;
  matric_number: string | null;
  department: string | null;
  level: string | null;
  department_id: string | null;
  level_id: string | null;
  school_id: string | null;
  avatar_url?: string | null;
};

export type ConversationListItem = {
  id: string;
  type: ConversationType;
  title: string;
  subtitle: string;
  preview: string;
  avatar_url: string | null;
  time: string | null;
  unread: number;
  isGroup: boolean;
  peerUserId?: string | null;
  online?: boolean;
  hasMessage?: boolean;
  lastSenderId?: string | null;
};

function previewFromMessage(m: {
  body?: string | null;
  attachment_type?: string | null;
  duration_sec?: number | null;
  reply_to_id?: string | null;
}): string {
  const at = (m.attachment_type || "").toLowerCase();
  const t = (m.body || "").trim();
  let core = "";
  if (at === "call" || /^(missed|no answer|call declined|voice call|video call)/i.test(t)) {
    if (/missed\s*video/i.test(t)) core = "📞 Missed video call";
    else if (/missed/i.test(t)) core = "📞 Missed voice call";
    else if (/declined/i.test(t)) core = "📞 Call declined";
    else if (/no answer/i.test(t)) core = "📞 No answer";
    else if (/video/i.test(t)) {
      const dur = t.match(/(\d{1,2}:\d{2})/);
      core = dur ? `📞 Video call · ${dur[1]}` : "📞 Video call";
    } else if (/voice|call/i.test(t)) {
      const dur = t.match(/(\d{1,2}:\d{2})/);
      core = dur ? `📞 Voice call · ${dur[1]}` : "📞 Voice call";
    } else {
      core = t.slice(0, 120) || "📞 Call";
    }
  } else if (at.includes("audio") || at === "voice") {
    const sec = m.duration_sec != null ? Math.max(0, Math.round(Number(m.duration_sec))) : null;
    const mm = sec != null ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : null;
    core = mm ? `🎤 Voice note · ${mm}` : "🎤 Voice note";
  } else if (at.includes("image") || at === "photo") {
    core = "📷 Photo";
  } else if (at.includes("video")) {
    core = "🎥 Video";
  } else if (t && t !== "(attachment)") {
    core = t.slice(0, 120);
  } else if (at) {
    core = "📄 Document";
  }
  if (m.reply_to_id && core) return `↩ ${core}`;
  return core;
}

/** List conversations the current user belongs to. */
export async function listMyConversations(
  userId: string,
): Promise<ConversationListItem[]> {
  const { data: memberships, error: mErr } = await supabase
    .from("conversation_members")
    .select("conversation_id, last_read_at, muted")
    .eq("user_id", userId)
    .is("left_at", null);

  if (mErr) {
    console.warn("[listMyConversations] memberships", mErr.message);
    throw new Error(mErr.message || "Could not load conversations");
  }
  if (!memberships?.length) return [];

  const ids = memberships.map((m) => m.conversation_id);
  const readMap = new Map(
    memberships.map((m) => [m.conversation_id, m.last_read_at as string | null]),
  );

  const { data: convs, error: cErr } = await supabase
    .from("conversations")
    .select("*")
    .in("id", ids)
    .order("updated_at", { ascending: false });

  if (cErr || !convs?.length) return [];

  // For direct chats, resolve peer names
  const directIds = (convs as ConversationRow[])
    .filter((c) => c.type === "direct")
    .map((c) => c.id);

  const peerName = new Map<string, { name: string; userId: string; avatar?: string | null }>();
  if (directIds.length) {
    const { data: peers } = await supabase
      .from("conversation_members")
      .select("conversation_id, user_id")
      .in("conversation_id", directIds)
      .neq("user_id", userId)
      .is("left_at", null);

    const peerUserIds = [...new Set((peers || []).map((p) => p.user_id))];
    if (peerUserIds.length) {
      const nameByUser = new Map<
        string,
        { name: string; avatar: string | null }
      >();

      // SECURITY DEFINER RPC — reliable full names across RLS
      const { data: rpcNames } = await supabase.rpc(
        "resolve_messaging_peer_names",
        { p_user_ids: peerUserIds },
      );
      if (Array.isArray(rpcNames)) {
        for (const r of rpcNames as Record<string, unknown>[]) {
          const uid = r.auth_user_id as string;
          if (!uid) continue;
          nameByUser.set(uid, {
            name: ((r.full_name as string) || "").trim() || "Student",
            avatar: (r.avatar_url as string) || null,
          });
        }
      }

      // Fallback direct profile read
      if (nameByUser.size < peerUserIds.length) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, auth_user_id, full_name, profile_photo_url")
          .in("auth_user_id", peerUserIds);
        for (const p of profiles || []) {
          const uid = p.auth_user_id as string;
          if (nameByUser.has(uid) && nameByUser.get(uid)!.name !== "Student")
            continue;
          nameByUser.set(uid, {
            name: ((p.full_name as string) || "").trim() || "Student",
            avatar: (p.profile_photo_url as string) || null,
          });
        }
      }

      for (const p of peers || []) {
        const info = nameByUser.get(p.user_id as string);
        peerName.set(p.conversation_id as string, {
          name: info?.name || "Student",
          userId: p.user_id as string,
          avatar: info?.avatar || null,
        });
      }
    }
  }

  // Unread counts (approx) — parallel, capped so Messages never hangs
  const unreadMap = new Map<string, number>();
  const unreadJobs = ids.slice(0, 40).map(async (id) => {
    try {
      const since = readMap.get(id);
      let q = supabase
        .from("campus_messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", id)
        .neq("sender_id", userId)
        .is("deleted_at", null);
      if (since) q = q.gt("created_at", since);
      const { count } = await q;
      unreadMap.set(id, count || 0);
    } catch {
      unreadMap.set(id, 0);
    }
  });
  await Promise.all(unreadJobs);

  const mapped = (convs as ConversationRow[]).map((c) => {
    const peer = peerName.get(c.id);
    const isGroup = c.type === "group";
    const hasMessage = Boolean(c.last_message_at || c.last_message_preview);
    return {
      id: c.id,
      type: c.type,
      title: isGroup
        ? c.title || "Group"
        : peer?.name || c.title || "Chat",
      subtitle: isGroup ? "Group" : "",
      preview: c.last_message_preview || (hasMessage ? "" : ""),
      avatar_url: isGroup ? c.avatar_url : peer?.avatar || null,
      time: c.last_message_at || c.updated_at,
      unread: unreadMap.get(c.id) || 0,
      isGroup,
      peerUserId: peer?.userId || null,
      hasMessage,
      lastSenderId: (c as { last_message_sender_id?: string | null }).last_message_sender_id || null,
    };
  });

  // Chats list: hide empty direct threads (opened but never messaged).
  // Groups still appear so members can open and start chatting.
  return mapped.filter((c) => c.isGroup || c.hasMessage);
}

/** Get or create a 1:1 direct conversation between two users in the same school. */
export async function getOrCreateDirectConversation(
  myUserId: string,
  peerUserId: string,
  schoolId: string,
): Promise<string> {
  if (myUserId === peerUserId) throw new Error("Cannot message yourself");

  // Find existing direct conversation sharing both members
  const { data: myMemberships } = await supabase
    .from("conversation_members")
    .select("conversation_id")
    .eq("user_id", myUserId)
    .is("left_at", null);

  const myConvIds = (myMemberships || []).map((m) => m.conversation_id);
  if (myConvIds.length) {
    const { data: shared } = await supabase
      .from("conversation_members")
      .select("conversation_id")
      .eq("user_id", peerUserId)
      .in("conversation_id", myConvIds)
      .is("left_at", null);

    if (shared?.length) {
      // Prefer a direct-type conversation
      const { data: directs } = await supabase
        .from("conversations")
        .select("id, type")
        .in(
          "id",
          shared.map((s) => s.conversation_id),
        )
        .eq("type", "direct");
      if (directs?.[0]?.id) return directs[0].id as string;
    }
  }

  // Create new via RPC first
  const resolvedSchool = (await resolveMySchoolId(schoolId)) || schoolId || null;
  const { data: rpcId, error: rpcErr } = await supabase.rpc(
    "create_campus_conversation",
    {
      p_type: "direct",
      p_title: null,
      p_description: null,
      p_group_kind: null,
      p_member_user_ids: [peerUserId],
      p_school_id: resolvedSchool,
    },
  );
  if (!rpcErr && rpcId) return rpcId as string;

  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id || myUserId;
  if (!resolvedSchool) {
    throw new Error(
      rpcErr?.message || "No school linked to your account",
    );
  }

  const { data: conv, error: cErr } = await supabase
    .from("conversations")
    .insert({
      school_id: resolvedSchool,
      type: "direct",
      created_by: uid,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (cErr || !conv?.id) {
    throw new Error(cErr?.message || rpcErr?.message || "Could not create chat");
  }

  const cid = conv.id as string;
  const { error: mErr } = await supabase.from("conversation_members").insert([
    { conversation_id: cid, user_id: uid, role: "member" },
    { conversation_id: cid, user_id: peerUserId, role: "member" },
  ]);
  if (mErr) throw new Error(mErr.message);
  return cid;
}

/** Create a group conversation. */
export async function createGroup(opts: {
  schoolId: string;
  creatorId: string;
  title: string;
  description?: string;
  groupKind?: GroupKind;
  memberUserIds: string[];
  avatarUrl?: string | null;
}): Promise<string> {
  const schoolId = (await resolveMySchoolId(opts.schoolId)) || opts.schoolId || null;
  const memberIds = opts.memberUserIds.filter(Boolean);

  // Prefer SECURITY DEFINER RPC (avoids RLS insert failures)
  const { data: rpcId, error: rpcErr } = await supabase.rpc(
    "create_campus_conversation",
    {
      p_type: "group",
      p_title: opts.title.trim(),
      p_description: opts.description?.trim() || null,
      p_group_kind: opts.groupKind || "study",
      p_member_user_ids: memberIds.length ? memberIds : [],
      p_school_id: schoolId || null,
    },
  );

  if (!rpcErr && rpcId) {
    if (opts.avatarUrl) {
      await supabase
        .from("conversations")
        .update({ avatar_url: opts.avatarUrl })
        .eq("id", rpcId);
    }
    return rpcId as string;
  }

  // Fallback direct insert
  const { data: auth } = await supabase.auth.getUser();
  const creatorId = auth.user?.id || opts.creatorId;
  if (!creatorId) throw new Error("Not signed in");
  if (!schoolId) {
    throw new Error(
      rpcErr?.message ||
        "No school linked to your account. Ask admin to set school_id on your profile.",
    );
  }

  const { data: conv, error: cErr } = await supabase
    .from("conversations")
    .insert({
      school_id: schoolId,
      type: "group",
      title: opts.title.trim(),
      description: opts.description?.trim() || null,
      group_kind: opts.groupKind || "study",
      avatar_url: opts.avatarUrl || null,
      created_by: creatorId,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (cErr || !conv?.id) {
    throw new Error(
      cErr?.message ||
        rpcErr?.message ||
        "Could not create group",
    );
  }

  const cid = conv.id as string;
  const members = [
    { conversation_id: cid, user_id: creatorId, role: "owner" as const },
    ...memberIds
      .filter((id) => id !== creatorId)
      .map((id) => ({
        conversation_id: cid,
        user_id: id,
        role: "member" as const,
      })),
  ];
  const { error: mErr } = await supabase.from("conversation_members").insert(members);
  if (mErr) throw new Error(mErr.message);
  return cid;
}


/** Best-effort FCM to other members when a message is sent (works when their app is killed). */
async function notifyMessageRecipients(opts: {
  conversationId: string;
  senderId: string;
  preview: string;
  attachmentType?: string | null;
  messageId?: string;
}) {
  try {
    const { data: members } = await supabase
      .from("conversation_members")
      .select("user_id")
      .eq("conversation_id", opts.conversationId)
      .is("left_at", null);
    const recipients = (members || [])
      .map((m) => String((m as { user_id?: string }).user_id || ""))
      .filter((id) => id && id !== opts.senderId);
    if (!recipients.length) return;

    // Resolve sender display name for notification title
    let senderName = "D4EXAM";
    let senderMatric = "";
    try {
      const { data: prof } = await supabase
        .from("profiles")
        .select("full_name, first_name, last_name")
        .eq("auth_user_id", opts.senderId)
        .maybeSingle();
      if (prof) {
        const p = prof as { full_name?: string; first_name?: string; last_name?: string };
        senderName =
          (p.full_name || "").trim() ||
          [p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
          senderName;
      }
      const { data: st } = await supabase
        .from("students")
        .select("matric_number")
        .eq("auth_user_id", opts.senderId)
        .maybeSingle();
      if (st && (st as { matric_number?: string }).matric_number) {
        senderMatric = String((st as { matric_number?: string }).matric_number);
      }
    } catch {
      /* ignore */
    }

    const title = senderMatric ? `${senderName} · ${senderMatric}` : senderName;
    const link = `/student/messages?chat=${encodeURIComponent(opts.conversationId)}`;
    const { dispatchPushToUser } = await import("@/lib/push-send.functions");
    const results = await Promise.all(
      recipients.map((recipientUserId) =>
        dispatchPushToUser({
          data: {
            recipientUserId,
            title,
            message: opts.preview || "New message",
            link,
            type: "chat_message",
            conversationId: opts.conversationId,
            callerName: senderName,
            callerMatric: senderMatric,
            fromUserId: opts.senderId,
            callerId: opts.senderId,
            actionLabel: "Reply",
            messageId: opts.messageId || "",
            attachmentType: opts.attachmentType || "",
          } as never,
        }).catch((e) => {
          console.warn("[notifyMessageRecipients] push error", e);
          return null;
        }),
      ),
    );
    console.info(
      "[notifyMessageRecipients]",
      recipients.length,
      "recipients",
      results.map((r) => (r && typeof r === "object" ? r : null)),
    );
  } catch (e) {
    console.warn("[notifyMessageRecipients] failed", e);
  }
}

/** Send a campus message (idempotent via client_id). */
export async function sendCampusMessage(opts: {
  conversationId: string;
  senderId: string;
  body?: string | null;
  attachmentUrl?: string | null;
  attachmentType?: string | null;
  replyToId?: string | null;
  forwardedFromId?: string | null;
  clientId: string;
  durationSec?: number | null;
}): Promise<CampusMessage> {
  const row = {
    conversation_id: opts.conversationId,
    sender_id: opts.senderId,
    body: opts.body || null,
    attachment_url: opts.attachmentUrl || null,
    attachment_type: opts.attachmentType || null,
    reply_to_id: opts.replyToId || null,
    forwarded_from_id: opts.forwardedFromId || null,
    client_id: opts.clientId,
    duration_sec: opts.durationSec ?? null,
  };

  // Prefer SECURITY DEFINER RPC (reliable under RLS)
  try {
    const { data: rpcMsg, error: rpcErr } = await supabase.rpc("send_campus_message", {
      p_conversation_id: opts.conversationId,
      p_body: opts.body || null,
      p_attachment_url: opts.attachmentUrl || null,
      p_attachment_type: opts.attachmentType || null,
      p_client_id: opts.clientId || null,
      p_reply_to_id: opts.replyToId || null,
      p_forwarded_from_id: opts.forwardedFromId || null,
      p_duration_sec: opts.durationSec ?? null,
    } as never);
    if (!rpcErr && rpcMsg) {
      const msg = (Array.isArray(rpcMsg) ? rpcMsg[0] : rpcMsg) as CampusMessage;
      if (!msg?.id) {
        console.warn("[sendCampusMessage] rpc returned no id", rpcMsg);
      } else {
      const preview = previewFromMessage(row);
      void notifyMessageRecipients({
        conversationId: opts.conversationId,
        senderId: opts.senderId,
        preview,
        attachmentType: opts.attachmentType || null,
        messageId: msg.id,
      });
      return msg;
      }
    }
    if (rpcErr) console.warn("[sendCampusMessage] rpc", rpcErr.message);
  } catch (e) {
    console.warn("[sendCampusMessage] rpc exception", e);
  }

  // Fallback: plain insert
  const ins = await supabase.from("campus_messages").insert(row).select("*").single();
  if (!ins.error && ins.data) {
    const preview = previewFromMessage(row);
    await touchConversation(opts.conversationId, opts.senderId, preview);
    void notifyMessageRecipients({
      conversationId: opts.conversationId,
      senderId: opts.senderId,
      preview,
      attachmentType: opts.attachmentType || null,
      messageId: (ins.data as CampusMessage).id,
    });
    return ins.data as CampusMessage;
  }

  if (ins.error && /duplicate|unique/i.test(ins.error.message)) {
    const { data: existing } = await supabase
      .from("campus_messages")
      .select("*")
      .eq("conversation_id", opts.conversationId)
      .eq("client_id", opts.clientId)
      .maybeSingle();
    if (existing) return existing as CampusMessage;
  }

  throw new Error(
    ins.error?.message ||
      "Could not send message. Check you are a member of this chat.",
  );
}

async function touchConversation(
  conversationId: string,
  senderId: string,
  preview: string,
) {
  const now = new Date().toISOString();
  await supabase
    .from("conversations")
    .update({
      updated_at: now,
      last_message_at: now,
      last_message_preview: preview.slice(0, 140),
      last_message_sender_id: senderId,
    })
    .eq("id", conversationId);
}

/** Mark conversation as read for current user. */
export async function markConversationRead(
  conversationId: string,
  userId: string,
) {
  await supabase
    .from("conversation_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .eq("user_id", userId);
}

/** Recipient marks undelivered messages as delivered (best-effort RPC). */
export async function markMessagesDelivered(conversationId: string) {
  try {
    await supabase.rpc("mark_messages_delivered", {
      p_conversation_id: conversationId,
    } as never);
  } catch {
    /* ignore if RPC not deployed */
  }
}

/** Peer last_read_at for direct chats (for read receipts). */
export async function getPeerLastReadAt(
  conversationId: string,
  myUserId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("conversation_members")
    .select("user_id, last_read_at")
    .eq("conversation_id", conversationId)
    .is("left_at", null);
  const peers = (data || []).filter(
    (r) => String((r as { user_id?: string }).user_id) !== myUserId,
  );
  if (!peers.length) return null;
  // For groups use the max last_read among peers (any peer read = partial; use max for progressive)
  let max: string | null = null;
  for (const p of peers) {
    const lr = (p as { last_read_at?: string | null }).last_read_at;
    if (!lr) continue;
    if (!max || new Date(lr).getTime() > new Date(max).getTime()) max = lr;
  }
  return max;
}

/** Load messages for a conversation. */
export async function listMessages(
  conversationId: string,
  limit = 80,
): Promise<CampusMessage[]> {
  const byId = new Map<string, CampusMessage>();
  const put = (rows: unknown) => {
    const arr = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? [rows] : [];
    for (const r of arr as CampusMessage[]) {
      if (r && (r as CampusMessage).id) byId.set(String((r as CampusMessage).id), r as CampusMessage);
    }
  };

  // 1) SECURITY DEFINER RPC
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc("list_campus_messages", {
      p_conversation_id: conversationId,
      p_limit: limit,
    } as never);
    if (rpcErr) console.warn("[listMessages] rpc", rpcErr.message);
    else put(rpcData);
  } catch (e) {
    console.warn("[listMessages] rpc exception", e);
  }

  // 2) Direct table SELECT
  try {
    const { data, error } = await supabase
      .from("campus_messages")
      .select("id, conversation_id, sender_id, body, attachment_url, attachment_type, reply_to_id, forwarded_from_id, client_id, duration_sec, created_at, edited_at, deleted_at, delivered_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) {
      console.warn("[listMessages] select", error.message);
      // Retry without delivered_at in case column missing on older clients
      const { data: d2, error: e2 } = await supabase
        .from("campus_messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (e2) console.warn("[listMessages] select*", e2.message);
      else put((d2 || []).filter((m: CampusMessage) => !m.deleted_at));
    } else {
      put((data || []).filter((m: CampusMessage) => !m.deleted_at));
    }
  } catch (e) {
    console.warn("[listMessages] select exception", e);
  }

  const all = [...byId.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  return all;
}

/** Discover students in the same school (name / matric / department / level). */
export async function discoverStudents(opts: {
  schoolId: string;
  query?: string;
  departmentId?: string | null;
  levelId?: string | null;
  excludeUserId?: string | null;
  limit?: number;
}): Promise<StudentDiscover[]> {
  const limit = opts.limit ?? 60;

  // Prefer SECURITY DEFINER RPC
  const { data: rpcRows, error: rpcErr } = await supabase.rpc(
    "list_school_students_for_messaging",
    {
      p_query: opts.query?.trim() || null,
      p_department_id: opts.departmentId || null,
      p_limit: limit,
    },
  );

  if (!rpcErr && Array.isArray(rpcRows) && rpcRows.length >= 0 && !rpcErr) {
    let list: StudentDiscover[] = (rpcRows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      profile_id: (r.profile_id as string) || null,
      auth_user_id: (r.auth_user_id as string) || null,
      full_name: (r.full_name as string) || "Student",
      matric_number: (r.matric_number as string) || null,
      department: (r.department as string) || null,
      level: (r.level as string) || null,
      department_id: (r.department_id as string) || null,
      level_id: (r.level_id as string) || null,
      school_id: (r.school_id as string) || null,
      avatar_url: (r.avatar_url as string) || null,
    }));
    if (opts.levelId) {
      list = list.filter((s) => s.level_id === opts.levelId);
    }
    if (opts.excludeUserId) {
      list = list.filter((s) => s.auth_user_id !== opts.excludeUserId);
    }
    // If RPC returned rows OR succeeded with empty (real empty school), use it
    // Only fall through if RPC itself failed
    if (!rpcErr) return list;
  }

  if (rpcErr) {
    console.warn("[discoverStudents] rpc", rpcErr.message);
  }

  const schoolId = (await resolveMySchoolId(opts.schoolId)) || opts.schoolId;
  if (!schoolId) return [];

  const baseSelect =
    "id, profile_id, matric_number, student_id, school_id, department_id, level_id, full_name, status";

  let rows: Record<string, unknown>[] = [];
  const rich = await supabase
    .from("students")
    .select(
      `${baseSelect}, departments(name), levels(name), profiles(auth_user_id, full_name, profile_photo_url)`,
    )
    .eq("school_id", schoolId)
    .limit(limit);

  if (!rich.error && rich.data) {
    rows = rich.data as Record<string, unknown>[];
  } else {
    const plain = await supabase
      .from("students")
      .select(baseSelect)
      .eq("school_id", schoolId)
      .limit(limit);
    if (plain.error || !plain.data) {
      console.warn("[discoverStudents]", rich.error?.message || plain.error?.message);
      return [];
    }
    rows = plain.data as Record<string, unknown>[];
    const profileIds = rows.map((r) => r.profile_id as string).filter(Boolean);
    if (profileIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, auth_user_id, full_name, avatar_url")
        .in("id", profileIds);
      const byId = new Map((profiles || []).map((p) => [p.id as string, p]));
      rows = rows.map((r) => ({
        ...r,
        profiles: byId.get(r.profile_id as string) || null,
      }));
    }
  }

  if (opts.departmentId) {
    rows = rows.filter((r) => r.department_id === opts.departmentId);
  }
  if (opts.levelId) {
    rows = rows.filter((r) => r.level_id === opts.levelId);
  }

  return mapStudents(rows, opts);
}

export async function listDepartmentOfficers(schoolId: string) {
  // Prefer SECURITY DEFINER RPC (correct profile_id → auth_user_id mapping)
  const { data: rpcRows, error: rpcErr } = await supabase.rpc(
    "list_school_officers_for_messaging",
  );
  if (!rpcErr && Array.isArray(rpcRows)) {
    return (rpcRows as Record<string, unknown>[])
      .filter((r) => r.auth_user_id)
      .filter((r) => !schoolId || !r.school_id || r.school_id === schoolId)
      .map((r) => ({
        id: r.auth_user_id as string,
        full_name: (r.full_name as string) || "Departmental Officer",
        avatar_url: (r.avatar_url as string) || null,
        roleLabel: (r.role_label as string) || "Departmental Officer",
      }));
  }
  if (rpcErr) console.warn("[listDepartmentOfficers] rpc", rpcErr.message);

  const results: {
    id: string;
    full_name: string;
    avatar_url: string | null;
    roleLabel: string;
  }[] = [];
  const seen = new Set<string>();
  const push = (
    authId: string | null | undefined,
    name: string | null | undefined,
    avatar: string | null | undefined,
  ) => {
    if (!authId || seen.has(authId)) return;
    seen.add(authId);
    results.push({
      id: authId,
      full_name: (name || "").trim() || "Departmental Officer",
      avatar_url: avatar || null,
      roleLabel: "Departmental Officer",
    });
  };

  // examination_officers.officer_id is a staff code (text), NOT auth uuid — use profile_id
  let eoQ = supabase
    .from("examination_officers")
    .select("profile_id, school_id, department_id, status")
    .limit(50);
  if (schoolId) eoQ = eoQ.eq("school_id", schoolId);
  const { data: eos } = await eoQ;
  const profileIds = (eos || [])
    .map((e) => e.profile_id as string)
    .filter(Boolean);
  if (profileIds.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, auth_user_id, full_name, profile_photo_url")
      .in("id", profileIds);
    for (const p of profs || []) {
      push(
        p.auth_user_id as string,
        p.full_name as string,
        p.profile_photo_url as string,
      );
    }
  }

  // user_roles examination_officer
  const { data: roles } = await supabase
    .from("user_roles")
    .select("user_id, school_id")
    .eq("role", "examination_officer")
    .limit(50);
  const uids = (roles || [])
    .filter((r) => !schoolId || !r.school_id || r.school_id === schoolId)
    .map((r) => r.user_id as string)
    .filter(Boolean);
  if (uids.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("auth_user_id, full_name, profile_photo_url")
      .in("auth_user_id", uids);
    for (const p of profs || []) {
      push(
        p.auth_user_id as string,
        p.full_name as string,
        p.profile_photo_url as string,
      );
    }
  }

  return results;
}


/** Load conversation meta for header (group creator, times, members). */
export async function getConversationMeta(conversationId: string, myUserId: string) {
  const { data: conv, error } = await supabase
    .from("conversations")
    .select(
      "id, type, title, description, avatar_url, group_kind, created_by, created_at, updated_at, school_id",
    )
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !conv) return null;

  const { data: members } = await supabase
    .from("conversation_members")
    .select("user_id, role, joined_at")
    .eq("conversation_id", conversationId)
    .is("left_at", null);

  let creatorName: string | null = null;
  if (conv.created_by) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name, auth_user_id")
      .eq("auth_user_id", conv.created_by)
      .maybeSingle();
    creatorName = (prof?.full_name as string) || null;
  }

  const peerIds = (members || [])
    .map((m) => m.user_id as string)
    .filter((id) => id && id !== myUserId);

  let peerName: string | null = null;
  let peerAvatar: string | null = null;
  if (conv.type === "direct" && peerIds[0]) {
    const { data: rpcNames } = await supabase.rpc(
      "resolve_messaging_peer_names",
      { p_user_ids: [peerIds[0]] },
    );
    const row = Array.isArray(rpcNames) ? (rpcNames as Record<string, unknown>[])[0] : null;
    if (row) {
      peerName = ((row.full_name as string) || "").trim() || null;
      peerAvatar = (row.avatar_url as string) || null;
    }
    if (!peerName) {
      const { data: peer } = await supabase
        .from("profiles")
        .select("full_name, profile_photo_url, auth_user_id")
        .eq("auth_user_id", peerIds[0])
        .maybeSingle();
      peerName = (peer?.full_name as string) || null;
      peerAvatar = (peer?.profile_photo_url as string) || null;
    }
  }

  const myRole =
    (members || []).find((m) => m.user_id === myUserId)?.role || "member";

  return {
    id: conv.id as string,
    type: conv.type as string,
    isGroup: conv.type === "group",
    title:
      conv.type === "group"
        ? (conv.title as string) || "Group"
        : peerName || (conv.title as string) || "Chat",
    subtitle:
      conv.type === "group"
        ? `${(members || []).length} members · ${(conv.group_kind as string) || "study"}`
        : "",
    avatar: (conv.avatar_url as string) || peerAvatar,
    peerUserId: conv.type === "direct" ? (peerIds[0] || null) : null,
    created_by: (conv.created_by as string) || null,
    creatorName,
    created_at: (conv.created_at as string) || null,
    description: (conv.description as string) || null,
    group_kind: (conv.group_kind as string) || null,
    memberCount: (members || []).length,
    myRole: myRole as string,
    peerUserId: peerIds[0] || null,
  };
}

/** Delete group (owner/admin) — removes conversation row (cascade members/messages). */
export async function deleteGroup(conversationId: string) {
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId)
    .eq("type", "group");
  if (error) throw new Error(error.message);
}


/** Forward a message into another conversation (new record, same content). */
export async function forwardCampusMessage(opts: {
  targetConversationId: string;
  senderId: string;
  source: CampusMessage;
  clientId: string;
}): Promise<CampusMessage> {
  return sendCampusMessage({
    conversationId: opts.targetConversationId,
    senderId: opts.senderId,
    body: opts.source.body,
    attachmentUrl: opts.source.attachment_url,
    attachmentType: opts.source.attachment_type,
    forwardedFromId: opts.source.id,
    clientId: opts.clientId,
    durationSec: opts.source.duration_sec,
  });
}

/** Group admin: update title/description/avatar. */
export async function updateGroupMeta(
  conversationId: string,
  patch: { title?: string; description?: string | null; avatar_url?: string | null },
) {
  const { error } = await supabase
    .from("conversations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("type", "group");
  if (error) throw new Error(error.message);
}

/** Add members to a group (admin/owner/creator). */
export async function addGroupMembers(
  conversationId: string,
  userIds: string[],
) {
  const rows = userIds.map((user_id) => ({
    conversation_id: conversationId,
    user_id,
    role: "member" as const,
  }));
  const { error } = await supabase.from("conversation_members").insert(rows);
  if (error) throw new Error(error.message);
}

/** Soft-remove member (set left_at). */
export async function removeGroupMember(
  conversationId: string,
  userId: string,
) {
  const { error } = await supabase
    .from("conversation_members")
    .update({ left_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

/** Leave group yourself. */
export async function leaveGroup(conversationId: string, userId: string) {
  return removeGroupMember(conversationId, userId);
}

/** Mute / unmute. */
export async function setGroupMuted(
  conversationId: string,
  userId: string,
  muted: boolean,
) {
  const { error } = await supabase
    .from("conversation_members")
    .update({ muted })
    .eq("conversation_id", conversationId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

/** List active members of a conversation. */
export async function listConversationMembers(conversationId: string) {
  const { data, error } = await supabase
    .from("conversation_members")
    .select("user_id, role, joined_at, muted, left_at")
    .eq("conversation_id", conversationId)
    .is("left_at", null);
  if (error) throw new Error(error.message);
  const userIds = (data || []).map((m) => m.user_id as string);
  if (!userIds.length) return [];

  const nameByUser = new Map<string, { name: string; avatar: string | null }>();
  const { data: rpcNames } = await supabase.rpc("resolve_messaging_peer_names", {
    p_user_ids: userIds,
  });
  if (Array.isArray(rpcNames)) {
    for (const r of rpcNames as Record<string, unknown>[]) {
      const uid = r.auth_user_id as string;
      if (!uid) continue;
      nameByUser.set(uid, {
        name: ((r.full_name as string) || "").trim() || "Member",
        avatar: (r.avatar_url as string) || null,
      });
    }
  }
  if (nameByUser.size < userIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("auth_user_id, full_name, profile_photo_url")
      .in("auth_user_id", userIds);
    for (const p of profiles || []) {
      const uid = p.auth_user_id as string;
      if (nameByUser.has(uid) && nameByUser.get(uid)!.name !== "Member") continue;
      nameByUser.set(uid, {
        name: ((p.full_name as string) || "").trim() || "Member",
        avatar: (p.profile_photo_url as string) || null,
      });
    }
  }

  return (data || []).map((m) => {
    const info = nameByUser.get(m.user_id as string);
    return {
      user_id: m.user_id as string,
      role: m.role as string,
      joined_at: m.joined_at as string,
      muted: Boolean(m.muted),
      full_name: info?.name || "Member",
      avatar_url: info?.avatar || null,
    };
  });
}


export async function enrichStudentsIdentity(
  studentIds: string[],
): Promise<
  Map<
    string,
    { department: string | null; level: string | null; full_name: string | null; matric: string | null }
  >
> {
  const map = new Map<
    string,
    { department: string | null; level: string | null; full_name: string | null; matric: string | null }
  >();
  if (!studentIds.length) return map;
  const { data } = await supabase
    .from("students")
    .select(
      "id, full_name, matric_number, student_id, departments(name), levels(name)",
    )
    .in("id", studentIds);
  for (const r of data || []) {
    const depts = r.departments as { name?: string } | null;
    const levels = r.levels as { name?: string } | null;
    map.set(r.id as string, {
      department: depts?.name || null,
      level: levels?.name || null,
      full_name: (r.full_name as string) || null,
      matric: (r.matric_number as string) || (r.student_id as string) || null,
    });
  }
  return map;
}


/** Promote or demote a group member (admin only). */
export async function setConversationMemberRole(
  conversationId: string,
  memberUserId: string,
  role: "admin" | "member",
) {
  const { error } = await supabase.rpc("set_campus_member_role", {
    p_conversation_id: conversationId,
    p_member_user_id: memberUserId,
    p_role: role,
  });
  if (error) {
    // Fallback direct update
    const { error: e2 } = await supabase
      .from("conversation_members")
      .update({ role })
      .eq("conversation_id", conversationId)
      .eq("user_id", memberUserId)
      .is("left_at", null);
    if (e2) throw new Error(error.message || e2.message);
  }
}


/** Soft-delete all messages in a conversation (clear chat). */
export async function clearCampusConversation(conversationId: string) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("campus_messages")
    .update({ deleted_at: now })
    .eq("conversation_id", conversationId)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
}


/** Edit own text message body. */
export async function editCampusMessage(messageId: string, body: string) {
  const { error } = await supabase
    .from("campus_messages")
    .update({ body, edited_at: new Date().toISOString() })
    .eq("id", messageId);
  if (error) throw new Error(error.message);
}

/** Soft-delete a single message for everyone (sender). */
export async function deleteCampusMessage(messageId: string) {
  const { error } = await supabase
    .from("campus_messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", messageId);
  if (error) throw new Error(error.message);
}
