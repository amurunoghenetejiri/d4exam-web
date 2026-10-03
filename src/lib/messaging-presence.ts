import { supabase } from "@/integrations/supabase/client";

export type PresencePayload = {
  userId: string;
  role: "student" | "officer";
  online: boolean;
  typing?: boolean;
  recording?: boolean;
  conversationKey?: string;
  at: number;
};

type Handlers = {
  onPresence?: (map: Map<string, PresencePayload>) => void;
  onTyping?: (p: PresencePayload) => void;
};

/** Lightweight presence + typing over a school channel. */
export function joinMessagingPresence(
  schoolId: string,
  self: Omit<PresencePayload, "at" | "online"> & { online?: boolean },
  handlers: Handlers,
): { channel: { untrack: () => void }; setTyping: (v: boolean, conversationKey?: string) => void; setRecording: (v: boolean, conversationKey?: string) => void; leave: () => void } {
  const channel = supabase.channel(`d4-msg:${schoolId}`, {
    config: { presence: { key: self.userId } },
  });
  const map = new Map<string, PresencePayload>();

  const publish = (extra: Partial<PresencePayload> = {}) => {
    const payload: PresencePayload = {
      userId: self.userId,
      role: self.role,
      online: true,
      typing: false,
      recording: false,
      conversationKey: self.conversationKey,
      at: Date.now(),
      ...extra,
    };
    void channel.track(payload);
  };

  channel
    .on("presence", { event: "sync" }, () => {
      map.clear();
      const state = channel.presenceState();
      for (const key of Object.keys(state)) {
        const arr = state[key] as PresencePayload[];
        const last = arr?.[arr.length - 1];
        if (last?.userId) map.set(last.userId, last);
      }
      handlers.onPresence?.(new Map(map));
    })
    .on("presence", { event: "join" }, ({ newPresences }) => {
      for (const p of newPresences as PresencePayload[]) {
        if (p?.userId) map.set(p.userId, p);
      }
      handlers.onPresence?.(new Map(map));
    })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      for (const p of leftPresences as PresencePayload[]) {
        if (p?.userId) map.delete(p.userId);
      }
      handlers.onPresence?.(new Map(map));
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") publish({ online: true });
    });

  let typingTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    channel,
    setTyping(v, conversationKey) {
      publish({ typing: v, recording: false, conversationKey });
      if (typingTimer) clearTimeout(typingTimer);
      if (v) {
        typingTimer = setTimeout(() => publish({ typing: false, conversationKey }), 2500);
      }
    },
    setRecording(v, conversationKey) {
      publish({ recording: v, typing: false, conversationKey });
    },
    leave() {
      if (typingTimer) clearTimeout(typingTimer);
      void channel.untrack();
      void supabase.removeChannel(channel);
    },
  };
}

export function ticksFor(opts: {
  isMine: boolean;
  createdAt: string;
  peerOnline: boolean;
  peerReadAt: string | null | undefined;
}): "none" | "sent" | "delivered" | "read" {
  if (!opts.isMine) return "none";
  if (opts.peerReadAt) {
    const read = new Date(opts.peerReadAt).getTime();
    const created = new Date(opts.createdAt).getTime();
    if (!Number.isNaN(read) && !Number.isNaN(created) && read >= created - 1000) return "read";
  }
  if (opts.peerOnline) return "delivered";
  return "sent";
}
