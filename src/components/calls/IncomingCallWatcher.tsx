import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSessionUser } from "@/lib/session";
import {
  getCallSession,
  notifyIncomingCall,
  subscribeCallSession,
} from "@/lib/call-session";
import { fetchPublicProfile } from "@/lib/user-profile";

/**
 * Listens for incoming call invites (personal broadcast + call_participants Realtime).
 * Safe to mount once (GlobalCallHost). Never throws into the React tree.
 */
export function IncomingCallWatcher({
  onIncoming,
}: {
  onIncoming?: (call: {
    callId: string;
    callType: "voice" | "video";
    peerId: string;
    peerName: string;
    peerAvatar: string | null;
    peerMatric?: string | null;
    conversationId?: string | null;
  }) => void;
}) {
  const { data: session } = useSessionUser();
  const myId = session?.userId || null;
  const handled = useRef<Set<string>>(new Set());
  const onIncomingRef = useRef(onIncoming);
  onIncomingRef.current = onIncoming;

  useEffect(() => {
    if (!myId) return;
    let cancelled = false;

    const handleInvite = async (payload: {
      callId: string;
      callType?: string;
      fromUserId?: string;
      conversationId?: string | null;
      callerName?: string;
    }) => {
      if (cancelled) return;
      const callId = String(payload.callId || "");
      if (!callId || handled.current.has(callId)) return;
      const cur = getCallSession();
      if (
        cur &&
        !["ended", "no_answer", "missed", "failed", "declined", "idle"].includes(cur.phase)
      ) {
        return;
      }
      handled.current.add(callId);
      const peerId = String(payload.fromUserId || "");
      let peerName = payload.callerName || "Incoming call";
      let peerAvatar: string | null = null;
      let peerMatric: string | null = null;
      if (peerId) {
        try {
          const p = await fetchPublicProfile(peerId, myId);
          if (p) {
            peerName = p.fullName || peerName;
            peerAvatar = p.avatarUrl || null;
            peerMatric = p.matricNumber || null;
          }
        } catch {
          /* ignore */
        }
      }
      const callType = (payload.callType === "video" ? "video" : "voice") as "voice" | "video";
      try {
        await notifyIncomingCall({
          callId,
          callType,
          peerId: peerId || "unknown",
          peerName,
          peerAvatar,
          peerMatric,
          conversationId: payload.conversationId || null,
          myUserId: myId,
        });
      } catch (e) {
        console.warn("[IncomingCallWatcher] notifyIncomingCall", e);
      }
      onIncomingRef.current?.({
        callId,
        callType,
        peerId: peerId || "unknown",
        peerName,
        peerAvatar,
        peerMatric,
        conversationId: payload.conversationId || null,
      });
    };

    const personalName = `user-calls:${myId}`;
    const dbName = `incoming-calls-db:${myId}`;

    // Tear down any prior instance of these topic names (Strict Mode / remounts)
    try {
      void supabase.removeChannel(supabase.channel(personalName));
    } catch {
      /* ignore */
    }
    try {
      void supabase.removeChannel(supabase.channel(dbName));
    } catch {
      /* ignore */
    }

    let personal: ReturnType<typeof supabase.channel> | null = null;
    let db: ReturnType<typeof supabase.channel> | null = null;

    try {
      personal = supabase.channel(personalName, {
        config: { broadcast: { self: false } },
      });
      personal.on("broadcast", { event: "incoming_call" }, ({ payload }) => {
        void handleInvite(
          payload as {
            callId: string;
            callType?: string;
            fromUserId?: string;
            conversationId?: string | null;
            callerName?: string;
          },
        );
      });
      personal.subscribe();
    } catch (e) {
      console.warn("[IncomingCallWatcher] personal channel", e);
    }

    try {
      db = supabase.channel(dbName);
      db.on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "call_participants",
          filter: `user_id=eq.${myId}`,
        },
        (payload) => {
          const row = payload.new as {
            call_id?: string;
            role?: string;
            status?: string;
          };
          if (!row?.call_id) return;
          if (row.role === "caller") return;
          if (row.status && row.status !== "ringing" && row.status !== "invited") return;
          void (async () => {
            try {
              const { data: cs } = await supabase
                .from("call_sessions")
                .select("id, call_type, initiator_id, conversation_id, status")
                .eq("id", row.call_id)
                .maybeSingle();
              if (!cs || (cs as { status?: string }).status === "ended") return;
              await handleInvite({
                callId: String((cs as { id: string }).id),
                callType: String((cs as { call_type?: string }).call_type || "voice"),
                fromUserId: String((cs as { initiator_id?: string }).initiator_id || ""),
                conversationId:
                  (cs as { conversation_id?: string | null }).conversation_id || null,
              });
            } catch (err) {
              console.warn("[IncomingCallWatcher] db invite", err);
            }
          })();
        },
      );
      db.subscribe();
    } catch (e) {
      console.warn("[IncomingCallWatcher] db channel", e);
    }

    return () => {
      cancelled = true;
      if (personal) {
        try {
          void supabase.removeChannel(personal);
        } catch {
          /* ignore */
        }
      }
      if (db) {
        try {
          void supabase.removeChannel(db);
        } catch {
          /* ignore */
        }
      }
    };
  }, [myId]);

  // Keep session subscription warm (no-op listener)
  useEffect(() => {
    try {
      return subscribeCallSession(() => {});
    } catch {
      return undefined;
    }
  }, []);

  return null;
}
