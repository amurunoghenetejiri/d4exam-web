import { supabase } from "@/integrations/supabase/client";

export type CallType = "voice" | "video";
export type CallStatus =
  | "ringing"
  | "active"
  | "ended"
  | "missed"
  | "rejected"
  | "busy"
  | "cancelled";

export type CallSession = {
  id: string;
  callType: CallType;
  status: CallStatus;
  initiatorId: string;
  conversationId: string | null;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
};

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // Public TURN (needed on mobile cellular where pure STUN often fails)
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

export async function startDirectCall(opts: {
  calleeId: string;
  callType: CallType;
  conversationId?: string | null;
}): Promise<string> {
  try {
    const { data, error } = await supabase.rpc("start_direct_call", {
      p_callee_id: opts.calleeId,
      p_call_type: opts.callType,
      p_conversation_id: opts.conversationId || null,
    });
    if (!error && data) return String(data);
    console.warn("[calls] start_direct_call RPC:", error?.message);
  } catch (e) {
    console.warn("[calls] start_direct_call failed", e);
  }
  // Fallback: local call id so UI + WebRTC signaling still work
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const { data: user } = await supabase.auth.getUser();
    const me = user.user?.id;
    if (me) {
      await supabase.from("call_sessions").insert({
        id,
        call_type: opts.callType,
        status: "ringing",
        initiator_id: me,
        conversation_id: opts.conversationId || null,
      } as never);
      await supabase.from("call_participants").insert([
        { call_id: id, user_id: me, role: "caller", status: "joined" },
        { call_id: id, user_id: opts.calleeId, role: "callee", status: "ringing" },
      ] as never);
    }
  } catch {
    /* signaling channel still works with local id */
  }
  return id;
}

export async function updateCallStatus(
  callId: string,
  status: CallStatus,
  endReason?: string,
) {
  const patch: Record<string, unknown> = { status };
  if (status === "active") patch.answered_at = new Date().toISOString();
  if (["ended", "missed", "rejected", "busy", "cancelled"].includes(status)) {
    patch.ended_at = new Date().toISOString();
    if (endReason) patch.end_reason = endReason;
  }
  const { error } = await supabase
    .from("call_sessions")
    .update(patch)
    .eq("id", callId);
  if (error) throw new Error(error.message);
}

export async function updateParticipantStatus(
  callId: string,
  userId: string,
  status: string,
) {
  const patch: Record<string, unknown> = { status };
  if (status === "joined") patch.joined_at = new Date().toISOString();
  if (status === "left" || status === "rejected" || status === "missed") {
    patch.left_at = new Date().toISOString();
  }
  const { error } = await supabase
    .from("call_participants")
    .update(patch)
    .eq("call_id", callId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function listCallHistory(userId: string, limit = 40) {
  const { data: parts, error } = await supabase
    .from("call_participants")
    .select("call_id, role, status")
    .eq("user_id", userId)
    .order("call_id", { ascending: false })
    .limit(limit * 2);
  if (error) throw new Error(error.message);
  const callIds = [...new Set((parts || []).map((p) => p.call_id as string))];
  if (!callIds.length) return [];
  const { data: sessions, error: e2 } = await supabase
    .from("call_sessions")
    .select("*")
    .in("id", callIds)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (e2) throw new Error(e2.message);
  return sessions || [];
}

export function createPeerConnection() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

export async function getLocalMedia(video: boolean, facingMode: "user" | "environment" = "user") {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: video
      ? { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 } }
      : false,
  });
}

/** Swap front/back camera on an existing stream + peer connection. */
export async function switchCameraFacing(
  localStream: MediaStream,
  pc: RTCPeerConnection | null,
  nextFacing: "user" | "environment",
): Promise<MediaStream> {
  const oldVideo = localStream.getVideoTracks()[0];
  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { exact: nextFacing }, width: { ideal: 640 }, height: { ideal: 480 } },
  }).catch(() =>
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: nextFacing }, width: { ideal: 640 }, height: { ideal: 480 } },
    }),
  );
  const newTrack = newStream.getVideoTracks()[0];
  if (!newTrack) throw new Error("No camera available");

  if (pc) {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(newTrack);
  }
  if (oldVideo) {
    localStream.removeTrack(oldVideo);
    oldVideo.stop();
  }
  localStream.addTrack(newTrack);
  // stop extra tracks from temp stream
  newStream.getAudioTracks().forEach((t) => t.stop());
  return localStream;
}


export type SignalEvent =
  | { type: "ready"; from: string }
  | { type: "ringing"; from: string }
  | { type: "offer"; sdp: RTCSessionDescriptionInit; from: string }
  | { type: "answer"; sdp: RTCSessionDescriptionInit; from: string }
  | { type: "ice"; candidate: RTCIceCandidateInit; from: string }
  | { type: "hangup"; from: string }
  | { type: "reject"; from: string }
  | { type: "busy"; from: string };

export function callChannelName(callId: string) {
  return `call:${callId}`;
}

export function subscribeCallChannel(
  callId: string,
  onEvent: (ev: SignalEvent) => void,
) {
  // Drop any stale channel with the same topic (Strict Mode / redial)
  const topic = callChannelName(callId);
  try {
    void supabase.removeChannel(supabase.channel(topic));
  } catch {
    /* ignore */
  }
  const channel = supabase.channel(topic, {
    config: { broadcast: { self: false, ack: true } },
  });
  channel.on("broadcast", { event: "signal" }, ({ payload }) => {
    if (payload && typeof payload === "object") {
      onEvent(payload as SignalEvent);
    }
  });
  channel.subscribe();
  return channel;
}

/** Wait until Realtime channel is SUBSCRIBED (or timeout). */
export function waitChannelReady(
  channel: ReturnType<typeof supabase.channel>,
  timeoutMs = 4000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const t = window.setTimeout(() => resolve(false), timeoutMs);
    // supabase-js exposes state via subscribe callback if we re-subscribe; poll instead
    const start = Date.now();
    const tick = () => {
      const st = (channel as unknown as { state?: string }).state;
      if (st === "joined" || st === "subscribed") {
        window.clearTimeout(t);
        resolve(true);
        return;
      }
      // Also accept after short delay — broadcast may still work once client is connected
      if (Date.now() - start > timeoutMs) {
        window.clearTimeout(t);
        resolve(false);
        return;
      }
      window.setTimeout(tick, 80);
    };
    tick();
  });
}

export async function broadcastSignal(
  channel: ReturnType<typeof supabase.channel>,
  event: SignalEvent,
) {
  await channel.send({
    type: "broadcast",
    event: "signal",
    payload: event,
  });
}


/** Best-effort high-priority push so callee device wakes when app is backgrounded. */
export async function notifyCalleeOfIncomingCall(opts: {
  calleeId: string;
  callId: string;
  callType: "voice" | "video";
  callerName: string;
  callerMatric?: string | null;
  fromUserId?: string | null;
  conversationId?: string | null;
}) {
  try {
    const { dispatchPushToUser } = await import("@/lib/push-send.functions");
    let fromUserId = opts.fromUserId || "";
    if (!fromUserId) {
      try {
        const { data: auth } = await supabase.auth.getUser();
        fromUserId = auth.user?.id || "";
      } catch { /* ignore */ }
    }
    await dispatchPushToUser({
      data: {
        recipientUserId: opts.calleeId,
        title: opts.callerName || "D4EXAM",
        message:
          opts.callType === "video"
            ? `Incoming video call${opts.callerMatric ? " · " + opts.callerMatric : ""}`
            : `Incoming voice call${opts.callerMatric ? " · " + opts.callerMatric : ""}`,
        link: `/student/messages?incomingCall=${encodeURIComponent(opts.callId)}&type=${opts.callType}`,
        // Native D4FirebaseMessagingService keys
        type: "incoming_call",
        callId: opts.callId,
        callType: opts.callType,
        callerName: opts.callerName || "Incoming Call",
        callerMatric: opts.callerMatric || "",
        fromUserId,
        callerId: fromUserId,
        conversationId: opts.conversationId || "",
      },
    });
  } catch {
    /* best-effort — Realtime still signals when app is open */
  }
}


/** Notify callee in realtime (works when their app is open). */
export async function inviteCalleeOnPersonalChannel(opts: {
  calleeId: string;
  callId: string;
  callType: "voice" | "video";
  conversationId?: string | null;
  callerName?: string;
  fromUserId: string;
}) {
  const payload = {
    callId: opts.callId,
    callType: opts.callType,
    fromUserId: opts.fromUserId,
    conversationId: opts.conversationId || null,
    callerName: opts.callerName || "D4EXAM",
  };
  try {
    const topic = `user-calls:${opts.calleeId}`;
    try {
      void supabase.removeChannel(supabase.channel(topic));
    } catch {
      /* ignore */
    }
    const ch = supabase.channel(topic, {
      config: { broadcast: { self: false } },
    });
    await new Promise<void>((resolve) => {
      const t = window.setTimeout(() => resolve(), 3000);
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          window.clearTimeout(t);
          resolve();
        }
      });
    });
    // Triple-send for reliability across flaky mobile networks
    await ch.send({ type: "broadcast", event: "incoming_call", payload });
    await ch.send({ type: "broadcast", event: "incoming_call", payload });
    await ch.send({ type: "broadcast", event: "incoming_call", payload });
    window.setTimeout(() => {
      try {
        void supabase.removeChannel(ch);
      } catch {
        /* ignore */
      }
    }, 10000);
  } catch (e) {
    console.warn("[calls] invite broadcast failed", e);
  }
}
