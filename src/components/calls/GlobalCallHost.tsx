import { useCallback, useEffect, useState } from "react";
import { useSessionUser } from "@/lib/session";
import { IncomingCallWatcher } from "@/components/calls/IncomingCallWatcher";
import { CallOverlay, type ActiveCall } from "@/components/calls/CallOverlay";
import {
  getCallSession,
  subscribeCallSession,
  type CallSessionState,
} from "@/lib/call-session";

/**
 * App-wide call host: listens for incoming invites on every page
 * and shows the call UI / status bar overlay.
 */
export function GlobalCallHost() {
  const { data: session } = useSessionUser();
  const myUserId = session?.userId || null;
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [sess, setSess] = useState<CallSessionState | null>(getCallSession());

  useEffect(() => subscribeCallSession(setSess), []);

  // Native full-screen / notification intent (FCM wake → MainActivity → WebView)
  useEffect(() => {
    if (!myUserId) return;
    const onNative = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as {
        action?: string;
        callId?: string;
        callType?: string;
      } | undefined;
      if (!detail?.callId) return;
      void import("@/lib/call-session").then(async ({ notifyIncomingCall, acceptIncomingCall, getCallSession }) => {
        const cur = getCallSession();
        if (!cur || ["ended", "no_answer", "missed", "failed", "declined", "idle"].includes(cur.phase)) {
          await notifyIncomingCall({
            callId: detail.callId!,
            callType: detail.callType === "video" ? "video" : "voice",
            peerId: "unknown",
            peerName: "Incoming call",
            peerAvatar: null,
            peerMatric: null,
            conversationId: null,
            myUserId,
          });
        }
        if (detail.action === "answer") {
          const s = getCallSession();
          if (s && (s.phase === "ringing" || s.phase === "minimized")) {
            await acceptIncomingCall({
              callId: s.callId,
              callType: s.callType,
              peerId: s.peerId,
              peerName: s.peerName,
              peerAvatar: s.peerAvatar,
              peerMatric: s.peerMatric,
              conversationId: s.conversationId,
              myUserId: s.myUserId,
            });
          }
        }
      });
    };
    window.addEventListener("d4-native-call", onNative);
    return () => window.removeEventListener("d4-native-call", onNative);
  }, [myUserId]);


  // Mirror global session into ActiveCall so overlay stays mounted
  useEffect(() => {
    if (!sess) {
      // Session torn down (end/reject) — close overlay unless we were never in a call
      setActiveCall((prev) => (prev ? null : prev));
      return;
    }
    if (sess.phase === "ended") {
      setActiveCall(null);
      return;
    }
    // Keep end-state screens (no_answer, declined, failed, missed) visible
    setActiveCall({
      callId: sess.callId,
      callType: sess.callType,
      peerId: sess.peerId,
      peerName: sess.peerName,
      peerAvatar: sess.peerAvatar,
      peerMatric: sess.peerMatric,
      isCaller: sess.isCaller,
      conversationId: sess.conversationId,
    });
  }, [sess?.callId, sess?.phase, sess?.peerName, sess?.peerAvatar, sess?.peerMatric]);

  const onIncoming = useCallback(
    (call: {
      callId: string;
      callType: "voice" | "video";
      peerId: string;
      peerName: string;
      peerAvatar: string | null;
      peerMatric?: string | null;
      conversationId?: string | null;
    }) => {
      setActiveCall({
        callId: call.callId,
        callType: call.callType,
        peerId: call.peerId,
        peerName: call.peerName,
        peerAvatar: call.peerAvatar,
        peerMatric: call.peerMatric,
        isCaller: false,
        conversationId: call.conversationId,
      });
    },
    [],
  );

  if (!myUserId) return null;

  return (
    <>
      <IncomingCallWatcher onIncoming={onIncoming} />
      {activeCall ? (
        <CallOverlay
          call={activeCall}
          myUserId={myUserId}
          onClose={() => setActiveCall(null)}
        />
      ) : null}
    </>
  );
}
