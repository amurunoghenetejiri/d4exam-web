// @ts-nocheck
/**
 * Global call session — owns WebRTC + signaling outside React lifecycle.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  broadcastSignal,
  createPeerConnection,
  getLocalMedia,
  subscribeCallChannel,
  waitChannelReady,
  switchCameraFacing,
  updateCallStatus,
  updateParticipantStatus,
  inviteCalleeOnPersonalChannel,
  notifyCalleeOfIncomingCall,
  type SignalEvent,
} from "@/lib/calls";
import {
  nativeSetSpeaker,
  nativeStartCallService,
  nativeStopCallService,
  nativeShowIncoming,
} from "@/lib/native-call";
import { startCallRingtone, stopCallRingtone } from "@/lib/ringtone";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type CallPhase =
  | "idle"
  | "calling"
  | "ringing"
  | "connecting"
  | "active"
  | "minimized"
  | "no_answer"
  | "ended"
  | "declined"
  | "missed"
  | "failed";

export type CallSessionState = {
  callId: string;
  callType: "voice" | "video";
  phase: CallPhase;
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  peerMatric?: string | null;
  isCaller: boolean;
  conversationId?: string | null;
  myUserId: string;
  muted: boolean;
  camOff: boolean;
  speakerOn: boolean;
  facing: "user" | "environment";
  seconds: number;
  sharingScreen: boolean;
  error?: string | null;
};

type Listener = (s: CallSessionState | null) => void;

let state: CallSessionState | null = null;
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
let pendingIce: RTCIceCandidateInit[] = [];
let channel: RealtimeChannel | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let ringTimeout: ReturnType<typeof setTimeout> | null = null;
let inviteInterval: ReturnType<typeof setInterval> | null = null;
let readyInterval: ReturnType<typeof setInterval> | null = null;
let listeners = new Set<Listener>();
let localVideoEl: HTMLVideoElement | null = null;
let remoteVideoEl: HTMLVideoElement | null = null;

const RING_MS = 30_000;

function emit() {
  for (const l of listeners) {
    try {
      l(state ? { ...state } : null);
    } catch {
      /* ignore */
    }
  }
}

export function subscribeCallSession(fn: Listener) {
  listeners.add(fn);
  fn(state ? { ...state } : null);
  return () => {
    listeners.delete(fn);
  };
}

export function getCallSession() {
  return state ? { ...state } : null;
}

export function attachCallVideos(localEl: HTMLVideoElement | null, remoteEl: HTMLVideoElement | null) {
  localVideoEl = localEl;
  remoteVideoEl = remoteEl;
  if (localEl && localStream) localEl.srcObject = localStream;
  if (remoteEl && remoteStream) remoteEl.srcObject = remoteStream;
}

async function postSystemMessage(
  conversationId: string | null | undefined,
  myUserId: string,
  body: string,
) {
  if (!conversationId) return;
  try {
    await supabase.from("campus_messages").insert({
      conversation_id: conversationId,
      sender_id: myUserId,
      body,
      attachment_type: "call",
      attachment_url: null,
    } as never);
    const now = new Date().toISOString();
    let preview = body.slice(0, 140);
    if (/missed\s*video/i.test(body)) preview = "📞 Missed video call";
    else if (/missed/i.test(body)) preview = "📞 Missed voice call";
    else if (/declined/i.test(body)) preview = "📞 Call declined";
    else if (/no answer/i.test(body)) preview = "📞 No answer";
    await supabase
      .from("conversations")
      .update({
        updated_at: now,
        last_message_at: now,
        last_message_preview: preview,
        last_message_sender_id: myUserId,
      } as never)
      .eq("id", conversationId);
  } catch {
    /* ignore */
  }
}


function wirePcConnectionHandlers() {
  if (!pc) return;
  pc.onconnectionstatechange = () => {
    if (!pc || !state) return;
    const st = pc.connectionState;
    if (st === "connected") {
      const wasActive = state.phase === "active" || state.phase === "minimized";
      if (!wasActive) {
        if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
        if (inviteInterval) { clearInterval(inviteInterval); inviteInterval = null; }
        if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
        state.phase = "active";
        state.error = null;
        emit();
        void nativeStartCallService(
          state.peerName,
          state.callType === "video" ? "Video call" : "Voice call",
        );
        if (!timer) {
          timer = setInterval(() => {
            if (state && (state.phase === "active" || state.phase === "minimized")) {
              state.seconds += 1;
              emit();
            }
          }, 1000);
        }
        void updateCallStatus(state.callId, "active").catch(() => {});
      }
    } else if (st === "failed") {
      if (state.phase === "connecting" || state.phase === "calling") {
        state.error = "Connection failed. Check network and try again.";
        state.phase = "failed";
        emit();
      }
    }
  };
}

function clearTimers() {
  if (timer) clearInterval(timer);
  timer = null;
  if (ringTimeout) clearTimeout(ringTimeout);
  ringTimeout = null;
  if (inviteInterval) clearInterval(inviteInterval);
  inviteInterval = null;
  if (readyInterval) clearInterval(readyInterval);
  readyInterval = null;
}

async function hardTeardown() {
  clearTimers();
  await stopCallRingtone();
  await nativeStopCallService();
  try {
    localStream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  localStream = null;
  remoteStream = null;
  pendingIce = [];
  try {
    pc?.close();
  } catch {
    /* ignore */
  }
  pc = null;
  if (channel) {
    try {
      await channel.unsubscribe();
    } catch {
      /* ignore */
    }
  }
  channel = null;
}

export async function startOutgoingCall(opts: {
  callId: string;
  callType: "voice" | "video";
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  peerMatric?: string | null;
  conversationId?: string | null;
  myUserId: string;
}) {
  if (state) await endCall("cancelled");

  state = {
    callId: opts.callId,
    callType: opts.callType,
    phase: "calling",
    peerId: opts.peerId,
    peerName: opts.peerName,
    peerAvatar: opts.peerAvatar,
    peerMatric: opts.peerMatric,
    isCaller: true,
    conversationId: opts.conversationId,
    myUserId: opts.myUserId,
    muted: false,
    camOff: false,
    speakerOn: opts.callType === "video",
    facing: "user",
    seconds: 0,
    sharingScreen: false,
    error: null,
  };
  emit();
  void nativeStartCallService(
    opts.peerName,
    opts.callType === "video" ? "Video call · Calling…" : "Voice call · Calling…",
  );

  try {
    localStream = await getLocalMedia(opts.callType === "video", "user");
    if (localVideoEl) localVideoEl.srcObject = localStream;
  } catch (e) {
    const msg =
      opts.callType === "video"
        ? "Camera/microphone permission is required for video calls."
        : "Microphone permission is required for voice calls.";
    if (state) {
      state.error = msg;
      state.phase = "failed";
      emit();
    }
    console.error(e);
    return;
  }

  try {
    pc = createPeerConnection();
    localStream.getTracks().forEach((t) => pc!.addTrack(t, localStream!));

    pc.ontrack = (ev) => {
      remoteStream = ev.streams[0] || null;
      if (remoteVideoEl && remoteStream) remoteVideoEl.srcObject = remoteStream;
      if (state && state.phase !== "active" && state.phase !== "minimized") {
        if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
        if (inviteInterval) { clearInterval(inviteInterval); inviteInterval = null; }
        if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
        state.phase = "active";
        state.error = null;
        emit();
        void nativeStartCallService(
          state.peerName,
          state.callType === "video" ? "Video call" : "Voice call",
        );
        if (!timer) {
          timer = setInterval(() => {
            if (state && (state.phase === "active" || state.phase === "minimized")) {
              state.seconds += 1;
              emit();
            }
          }, 1000);
        }
        void updateCallStatus(state.callId, "active");
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && channel && state) {
        void broadcastSignal(channel, {
          type: "ice",
          candidate: ev.candidate.toJSON(),
          from: state.myUserId,
        });
      }
    };

    wirePcConnectionHandlers();
    channel = subscribeCallChannel(opts.callId, handleSignal);
    await waitChannelReady(channel, 5000);

    // Pulse invite on personal channel until answered.
    // Offer is created only after callee sends "ready".
    const pulseInvite = async () => {
      if (!state || state.phase !== "calling") return;
      // Resolve *caller* display name (not peer — peer is the callee)
      let myName = "D4EXAM";
      let myMatric = "";
      try {
        const { fetchPublicProfile } = await import("@/lib/user-profile");
        const me = await fetchPublicProfile(opts.myUserId, opts.myUserId);
        if (me?.fullName) myName = me.fullName;
        if (me?.matricNumber) myMatric = me.matricNumber;
      } catch {
        /* ignore */
      }
      void inviteCalleeOnPersonalChannel({
        calleeId: opts.peerId,
        callId: opts.callId,
        callType: opts.callType,
        conversationId: opts.conversationId,
        callerName: myName,
        fromUserId: opts.myUserId,
      });
      void notifyCalleeOfIncomingCall({
        calleeId: opts.peerId,
        callId: opts.callId,
        callType: opts.callType,
        callerName: myName,
        callerMatric: myMatric,
        fromUserId: opts.myUserId,
        conversationId: opts.conversationId,
      });
    };
    pulseInvite();
    if (inviteInterval) clearInterval(inviteInterval);
    inviteInterval = setInterval(pulseInvite, 1500);

    // 30s no-answer
    ringTimeout = setTimeout(() => {
      if (
        state &&
        state.isCaller &&
        (state.phase === "calling" || state.phase === "connecting" || state.phase === "ringing")
      ) {
        void markNoAnswer();
      }
    }, RING_MS);
  } catch (e) {
    console.error(e);
    if (state) {
      state.error = "Could not start the call. Check your connection.";
      state.phase = "failed";
      emit();
    }
  }
}

async function markNoAnswer() {
  if (!state) return;
  const snap = { ...state };
  state.phase = "no_answer";
  emit();
  await stopCallRingtone();
  try {
    await updateCallStatus(snap.callId, "missed");
  } catch {
    /* ignore */
  }
  // Callee missed the call — push so their phone shows "Missed call"
  try {
    const { dispatchPushToUser } = await import("@/lib/push-send.functions");
    // Resolve caller display name best-effort
    let callerName = "D4EXAM";
    try {
      const { fetchPublicProfile } = await import("@/lib/user-profile");
      const me = await fetchPublicProfile(snap.myUserId, snap.myUserId);
      if (me?.fullName) callerName = me.fullName;
    } catch { /* ignore */ }
    await dispatchPushToUser({
      data: {
        recipientUserId: snap.peerId,
        title: "Missed call",
        message: `Missed call from ${callerName}`,
        link: snap.conversationId
          ? `/student/messages?chat=${encodeURIComponent(snap.conversationId)}`
          : "/student/messages",
        type: "missed_call",
        callId: snap.callId,
        callerName,
        callerMatric: "",
      },
    });
  } catch {
    /* best-effort */
  }
  await postSystemMessage(
    snap.conversationId,
    snap.myUserId,
    snap.callType === "video" ? "Missed video call · No answer" : "Missed voice call · No answer",
  );
  // Keep UI on no_answer; media can stop
  try {
    localStream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  try {
    pc?.close();
  } catch {
    /* ignore */
  }
  pc = null;
  if (channel) {
    try {
      await broadcastSignal(channel, { type: "hangup", from: state.myUserId });
      await channel.unsubscribe();
    } catch {
      /* ignore */
    }
    channel = null;
  }
}

export async function acceptIncomingCall(opts: {
  callId: string;
  callType: "voice" | "video";
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  peerMatric?: string | null;
  conversationId?: string | null;
  myUserId: string;
}) {
  await stopCallRingtone();

  state = {
    callId: opts.callId,
    callType: opts.callType,
    phase: "connecting",
    peerId: opts.peerId,
    peerName: opts.peerName,
    peerAvatar: opts.peerAvatar,
    peerMatric: opts.peerMatric,
    isCaller: false,
    conversationId: opts.conversationId,
    myUserId: opts.myUserId,
    muted: false,
    camOff: false,
    speakerOn: opts.callType === "video",
    facing: "user",
    seconds: 0,
    sharingScreen: false,
    error: null,
  };
  emit();
  void nativeStartCallService(
    opts.peerName,
    opts.callType === "video" ? "Video call · Connecting…" : "Voice call · Connecting…",
  );

  try {
    localStream = await getLocalMedia(opts.callType === "video", "user");
    if (localVideoEl) localVideoEl.srcObject = localStream;
  } catch (e) {
    if (state) {
      state.error =
        opts.callType === "video"
          ? "Camera/microphone permission is required."
          : "Microphone permission is required.";
      state.phase = "failed";
      emit();
    }
    console.error(e);
    return;
  }

  try {
    pc = createPeerConnection();
    localStream.getTracks().forEach((t) => pc!.addTrack(t, localStream!));
    wirePcConnectionHandlers();
    pc.ontrack = (ev) => {
      remoteStream = ev.streams[0] || null;
      if (remoteVideoEl && remoteStream) remoteVideoEl.srcObject = remoteStream;
      if (state && state.phase !== "active" && state.phase !== "minimized") {
        if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
        if (inviteInterval) { clearInterval(inviteInterval); inviteInterval = null; }
        if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
        state.phase = "active";
        state.error = null;
        emit();
        void nativeStartCallService(state.peerName, "In call");
        if (!timer) {
          timer = setInterval(() => {
            if (state && (state.phase === "active" || state.phase === "minimized")) {
              state.seconds += 1;
              emit();
            }
          }, 1000);
        }
        void updateCallStatus(state.callId, "active").catch(() => {});
      }
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate && channel && state) {
        void broadcastSignal(channel, {
          type: "ice",
          candidate: ev.candidate.toJSON(),
          from: state.myUserId,
        });
      }
    };
    channel = subscribeCallChannel(opts.callId, handleSignal);
    await waitChannelReady(channel, 4000);

    // Best-effort DB status — never fail the answer path on RLS
    try {
      await updateParticipantStatus(opts.callId, opts.myUserId, "joined");
    } catch {
      /* ignore */
    }
    try {
      await updateCallStatus(opts.callId, "active");
    } catch {
      /* ignore */
    }

    // Pulse "ready" until we get an offer / become active (caller may have missed first one)
    const sendReady = () => {
      if (!channel || !state) return;
      if (state.phase === "active" || state.phase === "minimized") return;
      if (state.phase === "failed" || state.phase === "ended" || state.phase === "declined") return;
      void broadcastSignal(channel, {
        type: "ready",
        from: opts.myUserId,
      });
    };
    sendReady();
    window.setTimeout(sendReady, 300);
    window.setTimeout(sendReady, 900);
    if (readyInterval) clearInterval(readyInterval);
    readyInterval = setInterval(sendReady, 1200);
  } catch (e) {
    console.error(e);
    if (state) {
      state.error = "Could not answer the call.";
      state.phase = "failed";
      emit();
    }
  }
}

export async function notifyIncomingCall(opts: {
  callId: string;
  callType: "voice" | "video";
  peerId: string;
  peerName: string;
  peerAvatar: string | null;
  peerMatric?: string | null;
  conversationId?: string | null;
  myUserId: string;
}) {
  if (state && !["idle", "ended", "no_answer", "failed", "declined", "missed"].includes(state.phase)) {
    return;
  }
  state = {
    callId: opts.callId,
    callType: opts.callType,
    phase: "ringing",
    peerId: opts.peerId,
    peerName: opts.peerName,
    peerAvatar: opts.peerAvatar,
    peerMatric: opts.peerMatric,
    isCaller: false,
    conversationId: opts.conversationId,
    myUserId: opts.myUserId,
    muted: false,
    camOff: false,
    speakerOn: false,
    facing: "user",
    seconds: 0,
    sharingScreen: false,
    error: null,
  };
  emit();
  await startCallRingtone();
  await nativeShowIncoming({
    callId: opts.callId,
    callerName: opts.peerName,
    subtitle: [
      opts.peerMatric,
      opts.callType === "video" ? "Incoming video call" : "Incoming voice call",
    ]
      .filter(Boolean)
      .join(" · "),
    callType: opts.callType,
  });
  ringTimeout = setTimeout(() => {
    if (state && state.phase === "ringing" && !state.isCaller) {
      void markMissed();
    }
  }, RING_MS);
}

async function markMissed() {
  if (!state) return;
  state.phase = "missed";
  emit();
  await stopCallRingtone();
  await postSystemMessage(
    state.conversationId,
    state.myUserId,
    state.callType === "video" ? "Missed video call" : "Missed voice call",
  );
  try {
    await updateCallStatus(state.callId, "missed");
  } catch {
    /* ignore */
  }
}

function handleSignal(ev: SignalEvent) {
  if (!state || !pc) return;
  if (ev.from === state.myUserId) return;
  void (async () => {
    try {
      if (ev.type === "ready" && state?.isCaller && pc) {
        if (inviteInterval) {
          clearInterval(inviteInterval);
          inviteInterval = null;
        }
        // Only create the offer once (ignore further ready pulses)
        if (pc.signalingState !== "stable" && pc.signalingState !== "have-local-offer") {
          return;
        }
        if (pc.localDescription && pc.signalingState === "have-local-offer") {
          // Re-broadcast existing offer in case callee missed it
          if (channel && pc.localDescription) {
            await broadcastSignal(channel, {
              type: "offer",
              sdp: pc.localDescription.toJSON
                ? (pc.localDescription as RTCSessionDescription).toJSON()
                : {
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp,
                  },
              from: state.myUserId,
            });
          }
          return;
        }
        try {
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: state.callType === "video",
          });
          await pc.setLocalDescription(offer);
          if (channel) {
            await broadcastSignal(channel, {
              type: "offer",
              sdp: offer,
              from: state.myUserId,
            });
          }
          if (state) {
            state.phase = "connecting";
            emit();
          }
        } catch (err) {
          console.error("[calls] Error creating offer on ready signal:", err);
        }
      } else if (ev.type === "offer" && pc.signalingState !== "closed") {
        if (readyInterval) {
          clearInterval(readyInterval);
          readyInterval = null;
        }
        // Glare / renegotiation: if we have a local offer, rollback first
        try {
          if (pc.signalingState === "have-local-offer") {
            await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
          }
        } catch { /* ignore */ }
        await pc.setRemoteDescription(ev.sdp);
        for (const c of pendingIce) {
          try { await pc.addIceCandidate(c); } catch { /* ignore */ }
        }
        pendingIce = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (channel) {
          await broadcastSignal(channel, {
            type: "answer",
            sdp: answer,
            from: state!.myUserId,
          });
        }
        if (state && state.phase !== "active" && state.phase !== "minimized") {
          state.phase = "connecting";
          emit();
        }
      } else if (ev.type === "answer" && pc.signalingState !== "closed") {
        await pc.setRemoteDescription(ev.sdp);
        for (const c of pendingIce) {
          try { await pc.addIceCandidate(c); } catch { /* ignore */ }
        }
        pendingIce = [];
        if (state) {
          state.phase = "connecting";
          emit();
        }
      } else if (ev.type === "ice" && ev.candidate) {
        try {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(ev.candidate);
          } else {
            pendingIce.push(ev.candidate);
          }
        } catch {
          /* ignore */
        }
      } else if (ev.type === "hangup") {
        // Either side hanging up ends the call for both
        if (state && (state.phase === "ringing" || state.phase === "calling") && !state.isCaller) {
          await markMissed();
        } else {
          await endCall("ended");
        }
      } else if (ev.type === "reject") {
        if (state) {
          state.phase = "declined";
          emit();
          await hardTeardown();
          await postSystemMessage(
            state.conversationId,
            state.myUserId,
            state.callType === "video" ? "Video call declined" : "Voice call declined",
          );
        }
      } else if (ev.type === "busy") {
        await endCall("ended");
      }
    } catch (e) {
      console.error(e);
    }
  })();
}

export async function endCall(
  reason: "ended" | "cancelled" | "rejected" | "missed" | "busy" | "local" | string = "ended",
) {
  const snap = state;
  // Stop ring immediately so user hears hangup
  await stopCallRingtone();
  if (channel && snap) {
    try {
      await broadcastSignal(channel, {
        type: reason === "rejected" ? "reject" : "hangup",
        from: snap.myUserId,
      });
    } catch {
      /* ignore */
    }
  }
  if (snap && reason === "rejected") {
    await postSystemMessage(
      snap.conversationId,
      snap.myUserId,
      snap.callType === "video" ? "Video call declined" : "Voice call declined",
    );
  } else if (snap && snap.seconds > 0 && reason !== "missed" && reason !== "rejected") {
    const mm = String(Math.floor(snap.seconds / 60)).padStart(2, "0");
    const ss = String(snap.seconds % 60).padStart(2, "0");
    const label =
      snap.callType === "video"
        ? `Video call · ${mm}:${ss}`
        : `Voice call · ${mm}:${ss}`;
    await postSystemMessage(snap.conversationId, snap.myUserId, label);
  }
  await hardTeardown();
  try {
    if (snap) {
      const status =
        reason === "cancelled" ? "cancelled" :
        reason === "rejected" ? "rejected" :
        reason === "missed" ? "missed" : "ended";
      await updateCallStatus(snap.callId, status as "ended");
      await updateParticipantStatus(snap.callId, snap.myUserId, "left");
    }
  } catch {
    /* ignore */
  }
  state = null;
  emit();
}

export function dismissCallUi() {
  void hardTeardown();
  state = null;
  emit();
}

export async function rejectIncomingCall() {
  await stopCallRingtone();
  if (channel && state) {
    try {
      await broadcastSignal(channel, { type: "reject", from: state.myUserId });
    } catch {
      /* ignore */
    }
  }
  if (state) {
    try {
      await updateParticipantStatus(state.callId, state.myUserId, "declined");
    } catch {
      /* ignore */
    }
    try {
      await updateCallStatus(state.callId, "ended");
    } catch {
      /* ignore */
    }
    state.phase = "declined";
    state.error = "Call declined";
    emit();
  }
  await endCall("declined");
}

export function minimizeCall() {
  if (!state) return;
  // Allow minimize while ringing/calling/connecting/active — does NOT end the call
  if (["active", "connecting", "calling", "ringing"].includes(state.phase)) {
    (state as { _preMinimizePhase?: string })._preMinimizePhase = state.phase;
    state.phase = "minimized";
    emit();
  }
}

export function restoreCall() {
  if (!state) return;
  if (state.phase === "minimized") {
    const prev = (state as { _preMinimizePhase?: string })._preMinimizePhase;
    state.phase =
      prev === "ringing" || prev === "calling" || prev === "connecting" || prev === "active"
        ? (prev as typeof state.phase)
        : state.seconds > 0
          ? "active"
          : "connecting";
    emit();
  }
}

export function toggleMute() {
  if (!state) return;
  state.muted = !state.muted;
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !state!.muted;
    });
  }
  emit();
}

export function toggleCam() {
  if (!state) return;
  state.camOff = !state.camOff;
  if (localStream) {
    localStream.getVideoTracks().forEach((t) => {
      t.enabled = !state!.camOff;
    });
  }
  emit();
}

export async function toggleSpeaker() {
  if (!state) return;
  state.speakerOn = !state.speakerOn;
  await nativeSetSpeaker(state.speakerOn);
  // WebView audio element routing best-effort
  try {
    if (remoteVideoEl) {
      // @ts-expect-error setSinkId not in all typings
      if (typeof remoteVideoEl.setSinkId === "function") {
        // leave default
      }
    }
  } catch { /* ignore */ }
  emit();
}

/** Upgrade an active voice call to video (local camera + renegotiate). */
export async function upgradeToVideo() {
  if (!state || !pc) return;
  try {
    const cam = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facing || "user" },
      audio: false,
    });
    const vTrack = cam.getVideoTracks()[0];
    if (!vTrack) return;
    if (!localStream) localStream = new MediaStream();
    // Remove old video tracks
    localStream.getVideoTracks().forEach((t) => {
      localStream!.removeTrack(t);
      try { t.stop(); } catch { /* ignore */ }
    });
    localStream.addTrack(vTrack);
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(vTrack);
    } else {
      pc.addTrack(vTrack, localStream);
    }
    if (localVideoEl) localVideoEl.srcObject = localStream;
    state.callType = "video";
    state.camOff = false;
    state.speakerOn = true;
    await nativeSetSpeaker(true);
    emit();
    // Renegotiate so peer receives video
    if (state.isCaller || pc.signalingState === "stable") {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      if (channel) {
        await broadcastSignal(channel, { type: "offer", sdp: offer, from: state.myUserId });
      }
    }
  } catch (e) {
    console.error("[calls] upgradeToVideo", e);
    if (state) {
      state.error = "Could not enable camera";
      emit();
    }
  }
}

export async function flipCamera() {
  if (!state || !localStream) return;
  const next = state.facing === "user" ? "environment" : "user";
  try {
    await switchCameraFacing(localStream, pc, next);
    state.facing = next;
    if (localVideoEl) localVideoEl.srcObject = localStream;
    emit();
  } catch (e) {
    console.error(e);
  }
}

export async function startScreenShare() {
  if (!state || !pc) {
    return;
  }
  try {
    const md = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
    };
    if (typeof md.getDisplayMedia !== "function") {
      if (state) {
        state.error = "Screen share is not supported on this device";
        emit();
        window.setTimeout(() => {
          if (state) { state.error = null; emit(); }
        }, 2500);
      }
      return;
    }
    const display = await md.getDisplayMedia({ video: true, audio: false });
    if (!display) return;
    const track = display.getVideoTracks()[0];
    if (!track) return;
    // Ensure we have a video sender (voice calls may not)
    let sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(track);
    } else {
      if (!localStream) localStream = new MediaStream();
      localStream.addTrack(track);
      pc.addTrack(track, localStream);
      // Renegotiate
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        if (channel && state) {
          await broadcastSignal(channel, { type: "offer", sdp: offer, from: state.myUserId });
        }
      } catch (e) {
        console.warn("[calls] screen share renegotiate", e);
      }
    }
    track.onended = () => {
      void stopScreenShare();
    };
    state.sharingScreen = true;
    state.callType = "video";
    emit();
  } catch (e) {
    console.warn("[calls] startScreenShare", e);
    if (state) {
      state.error = "Screen share cancelled or denied";
      emit();
      window.setTimeout(() => {
        if (state) { state.error = null; emit(); }
      }, 2500);
    }
  }
}

export async function stopScreenShare() {
  if (!state || !pc || !localStream) return;
  const cam = localStream.getVideoTracks()[0];
  const sender = pc.getSenders().find((s) => s.track?.kind === "video");
  if (sender && cam) await sender.replaceTrack(cam);
  state.sharingScreen = false;
  emit();
}
