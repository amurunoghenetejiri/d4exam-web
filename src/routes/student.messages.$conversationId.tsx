import { openUserProfile, D4_OPEN_PROFILE_EVENT } from "@/components/profile/ClickableUser";
import { MessagingProfileSheet } from "@/components/profile/MessagingProfileSheet";
import { startDirectCall, notifyCalleeOfIncomingCall, inviteCalleeOnPersonalChannel } from "@/lib/calls";
import { CallOverlay, type ActiveCall } from "@/components/calls/CallOverlay";
import { isOnlineNow } from "@/lib/offline-guard";
import { toast } from "sonner";
/**
 * Campus conversation chat (direct + group).
 * Reuses MessageMedia; stores in campus_messages.
 */
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
// useEffect used for back flag
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Mic,
  Paperclip,
  Send,
  UsersRound,
  User,
  Reply,
  Phone,
  Video,
  Copy,
  CornerUpRight,
  X,
  Pause,
  Play,
  Forward,
  MoreVertical,
  UserMinus,
  LogOut,
  VolumeX,
  Volume2,
} from "lucide-react";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import {
  listMessages,
  markConversationRead,
  sendCampusMessage,
  type CampusMessage,
} from "@/lib/messaging";
import { uploadMessageMedia } from "@/lib/message-media";
import {
  VoiceBubble,
  ImageBubble,
  ImageLightbox,
  VideoBubble,
  FileBubble,
  VideoLightbox,
  VoiceRecorderBar,
  LongPressMenu,
  lastSeenLabel,
  stopAllVoices,
  parseMediaUrls,
} from "@/components/messaging/MessageMedia";
import { joinMessagingPresence } from "@/lib/messaging-presence";
import {
  enqueueOutbox,
  listOutbox,
  removeOutbox,
  markOutboxFailed,
  markOutboxUploading,
  canRetry,
  subscribeOutbox,
  dataUrlToBlob,
} from "@/lib/message-outbox";
import {
  forwardCampusMessage,
  listMyConversations,
  listConversationMembers,
  updateGroupMeta,
  addGroupMembers,
  removeGroupMember,
  leaveGroup,
  setGroupMuted,
  discoverStudents,
  deleteGroup,
  getConversationMeta,
  setConversationMemberRole,
  clearCampusConversation,
  editCampusMessage,
  deleteCampusMessage,
  resolveMySchoolId,
} from "@/lib/messaging";

function ConversationChatRoute() {
  const { conversationId } = useParams({ from: "/student/messages/$conversationId" });
  return <ConversationChat conversationId={conversationId} />;
}

export const Route = createFileRoute("/student/messages/$conversationId")({
  ssr: false,
  head: () => ({ meta: [{ title: "Chat — D4EXAM" }] }),
  component: ConversationChatRoute,
  errorComponent: function ChatRouteError({ error, reset }) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-[#e0f2fe] px-6 text-center">
        <p className="text-lg font-bold text-slate-900">Chat could not load</p>
        <p className="max-w-sm text-sm text-slate-600">
          {(error as Error)?.message || "Something went wrong opening this chat."}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-full bg-[#2563eb] px-5 py-2.5 text-sm font-semibold text-white"
        >
          Try again
        </button>
        <a href="/student/messages" className="text-sm font-semibold text-[#2563eb]">
          Back to messages
        </a>
      </div>
    );
  },
});

/** Shared chat UI — used by route and inline from Messages hub (APK-safe). */
export function ConversationChat({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack?: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: session } = useSessionUser();
  useEffect(() => {
    try {
      (window as unknown as { __d4MsgInChat?: boolean }).__d4MsgInChat = true;
      const onBack = () => {
        // handled by backButton via history or navigate
        try {
          window.history.back();
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("d4-messaging-back", onBack);
      return () => {
        (window as unknown as { __d4MsgInChat?: boolean }).__d4MsgInChat = false;
        window.removeEventListener("d4-messaging-back", onBack);
      };
    } catch {
      return undefined;
    }
  }, []);
  const userId = session?.userId || "";

  const goBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    try {
      void navigate({ to: "/student/messages" });
    } catch {
      if (typeof window !== "undefined") {
        window.location.hash = "/student/messages";
      }
    }
  };

  const [text, setText] = useState("");
  const typingLink = useMemo(() => {
    const m = text.match(/https?:\/\/[^\s]+/i);
    const u = m ? m[0].replace(/[),.]+$/, "") : null;
    // only treat as "complete enough" when it has a domain with a dot
    if (!u) return null;
    try {
      const host = new URL(u).hostname;
      if (!host.includes(".")) return null;
      return u;
    } catch {
      return null;
    }
  }, [text]);
  const [linkMeta, setLinkMeta] = useState<{
    url: string;
    title?: string;
    description?: string;
    image?: string;
    logo?: string;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    if (!typingLink) {
      setLinkMeta(null);
      return;
    }
    let cancelled = false;
    setLinkMeta({ url: typingLink, loading: true });
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `https://api.microlink.io?url=${encodeURIComponent(typingLink)}&palette=false&audio=false&video=false&iframe=false`,
          );
          const json = (await res.json()) as {
            status: string;
            data?: {
              title?: string;
              description?: string;
              image?: { url?: string };
              logo?: { url?: string };
              publisher?: string;
            };
          };
          if (cancelled) return;
          if (json.status === "success" && json.data) {
            setLinkMeta({
              url: typingLink,
              title: json.data.title || new URL(typingLink).hostname,
              description: json.data.description || "",
              image: json.data.image?.url,
              logo: json.data.logo?.url,
              loading: false,
            });
          } else {
            setLinkMeta({
              url: typingLink,
              title: new URL(typingLink).hostname,
              description: "",
              loading: false,
            });
          }
        } catch {
          if (cancelled) return;
          try {
            setLinkMeta({
              url: typingLink,
              title: new URL(typingLink).hostname,
              description: "",
              loading: false,
            });
          } catch {
            setLinkMeta(null);
          }
        }
      })();
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [typingLink]);
  const [optimistic, setOptimistic] = useState<CampusMessage[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxUrls, setLightboxUrls] = useState<string[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [showScroll, setShowScroll] = useState(false);

  // Voice recording (matches VoiceRecorderBar state model)
  const [recording, setRecording] = useState(false);
  const [recPaused, setRecPaused] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const mediaRec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sendLock = useRef(false);
  const [replyTo, setReplyTo] = useState<CampusMessage | null>(null);
  const [swipeDx, setSwipeDx] = useState<Record<string, number>>({});
  const swipeRef = useRef<{
    key: string;
    x: number;
    y: number;
    axis: "none" | "h" | "v";
    dx: number;
  } | null>(null);
  const [forwardMsg, setForwardMsg] = useState<CampusMessage | null>(null);
  const [longPressMsg, setLongPressMsg] = useState<CampusMessage | null>(null);
  const [editMsg, setEditMsg] = useState<CampusMessage | null>(null);
  const [editText, setEditText] = useState("");
  const [senderNames, setSenderNames] = useState<Record<string, { name: string; avatar: string | null }>>({});
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [profileSheetUserId, setProfileSheetUserId] = useState<string | null>(null);
  const [profileSheetSeed, setProfileSheetSeed] = useState<{
    name?: string | null;
    avatar?: string | null;
    matric?: string | null;
  }>({});
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<{ userId?: string }>).detail;
      if (detail?.userId) setProfileSheetUserId(detail.userId);
    };
    window.addEventListener(D4_OPEN_PROFILE_EVENT, onOpen);
    return () => window.removeEventListener(D4_OPEN_PROFILE_EVENT, onOpen);
  }, []);
  const [clearOpen, setClearOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [peerOnline, setPeerOnline] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);
  const [peerRecording, setPeerRecording] = useState(false);
  const [peerLastAt, setPeerLastAt] = useState<number | null>(null);
  const [localTitle, setLocalTitle] = useState<string | null>(null);
  const presenceApi = useRef<ReturnType<typeof joinMessagingPresence> | null>(null);

  const metaQuery = useQuery({
    queryKey: ["campus-conv-meta", conversationId, userId],
    enabled: Boolean(conversationId && userId),
    queryFn: async () => {
      const rich = await getConversationMeta(conversationId, userId);
      if (rich) {
        return {
          title: rich.title,
          subtitle: rich.subtitle,
          avatar: rich.avatar,
          isGroup: rich.isGroup,
          creatorName: rich.creatorName,
          created_at: rich.created_at,
          description: rich.description,
          memberCount: rich.memberCount,
          myRole: rich.myRole,
          peerUserId: (rich as { peerUserId?: string | null }).peerUserId || null,
        };
      }
      return null;
    },
  });

  const meta = metaQuery.data;
  const displayTitle = localTitle || meta?.title || "Chat";

  // Presence: online / typing / recording for peer
  useEffect(() => {
    if (!userId || !conversationId) return;
    const schoolId = session?.schoolId;
    if (!schoolId) return;
    const api = joinMessagingPresence(
      schoolId,
      { userId, role: "student", conversationKey: conversationId },
      {
        onPresence(map) {
          const peerId = metaQuery.data?.peerUserId;
          if (!peerId) {
            // group: any other member typing
            let typing = false;
            let recording = false;
            let online = false;
            let lastAt: number | null = null;
            map.forEach((p, id) => {
              if (id === userId) return;
              if (p.conversationKey && p.conversationKey !== conversationId) return;
              if (p.online) online = true;
              if (p.typing) typing = true;
              if (p.recording) recording = true;
              if (p.at) lastAt = Math.max(lastAt || 0, p.at);
            });
            setPeerOnline(online);
            setPeerTyping(typing);
            setPeerRecording(recording);
            setPeerLastAt(lastAt);
            return;
          }
          const p = map.get(peerId);
          setPeerOnline(Boolean(p?.online));
          setPeerTyping(Boolean(p?.typing && p.conversationKey === conversationId));
          setPeerRecording(Boolean(p?.recording && p.conversationKey === conversationId));
          setPeerLastAt(p?.at || null);
        },
      },
    );
    presenceApi.current = api;
    return () => {
      api.leave();
      presenceApi.current = null;
    };
  }, [userId, conversationId, session?.schoolId, metaQuery.data?.peerUserId]);

  // Broadcast typing while composing
  useEffect(() => {
    const api = presenceApi.current;
    if (!api) return;
    const typing = text.trim().length > 0;
    api.setTyping(typing, conversationId);
    if (!typing) return;
    const t = setTimeout(() => api.setTyping(false, conversationId), 2500);
    return () => clearTimeout(t);
  }, [text, conversationId]);

  useEffect(() => {
    presenceApi.current?.setRecording(recording, conversationId);
  }, [recording, conversationId]);

  const msgQuery = useQuery({
    queryKey: ["campus-messages", conversationId],
    enabled: Boolean(conversationId),
    staleTime: 5_000,
    queryFn: () => listMessages(conversationId, 120),
  });

  useEffect(() => {
    if (!conversationId) return;
    const topic = `campus-msg-${conversationId}`;
    try {
      void supabase.removeChannel(supabase.channel(topic));
    } catch {
      /* ignore stale channel */
    }
    let ch: ReturnType<typeof supabase.channel> | null = null;
    try {
      ch = supabase.channel(topic);
      ch.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "campus_messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          void qc.invalidateQueries({ queryKey: ["campus-messages", conversationId] });
          void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
        },
      );
      ch.subscribe();
    } catch (e) {
      console.warn("[messages] realtime campus_messages", e);
    }
    return () => {
      if (ch) {
        try {
          void supabase.removeChannel(ch);
        } catch {
          /* ignore */
        }
      }
    };
  }, [conversationId, qc]);

  // Flush campus outbox when back online
  useEffect(() => {
    if (!userId || !conversationId) return;
    const flush = async () => {
      if (!isOnlineNow()) return;
      const items = listOutbox("student").filter(
        (x) => x.conversationId === conversationId && canRetry(x),
      );
      for (const item of items) {
        try {
          markOutboxUploading(item.clientId);
          let mediaUrl = item.mediaUrl || null;
          if (!mediaUrl && item.blobDataUrl) {
            const blob = dataUrlToBlob(item.blobDataUrl);
            if (blob) {
              const up = await uploadMessageMedia(
                blob,
                item.mediaType || blob.type || "application/octet-stream",
                `campus/${conversationId}`,
              );
              mediaUrl = up.url;
            }
          }
          await sendCampusMessage({
            conversationId,
            senderId: userId,
            body: item.text || null,
            attachmentUrl: mediaUrl,
            attachmentType: item.mediaType || null,
            clientId: item.clientId,
            durationSec: item.durationSec ?? null,
            forwardedFromId: item.forwardedFromId || null,
            replyToId: item.replyToId || null,
          });
          removeOutbox(item.clientId);
        } catch (e) {
          markOutboxFailed(item.clientId, e instanceof Error ? e.message : "fail");
        }
      }
      void qc.invalidateQueries({ queryKey: ["campus-messages", conversationId] });
    };
    void flush();
    const unsub = subscribeOutbox(() => { void flush(); });
    const onOnline = () => { void flush(); };
    window.addEventListener("online", onOnline);
    return () => {
      unsub();
      window.removeEventListener("online", onOnline);
    };
  }, [userId, conversationId, qc]);

  useEffect(() => {
    if (userId && conversationId) {
      void markConversationRead(conversationId, userId);
    }
  }, [userId, conversationId, msgQuery.dataUpdatedAt]);

  const serverMsgs = msgQuery.data || [];
  // Resolve sender display names (groups + reply labels)
  useEffect(() => {
    const rows = msgQuery.data || [];
    const ids = [...new Set(rows.map((m) => m.sender_id).filter(Boolean))];
    if (!ids.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabase.rpc("resolve_messaging_peer_names", {
          p_user_ids: ids,
        });
        if (cancelled || !Array.isArray(data)) return;
        const map: Record<string, { name: string; avatar: string | null }> = {};
        for (const r of data as Record<string, unknown>[]) {
          const uid = r.auth_user_id as string;
          if (!uid) continue;
          map[uid] = {
            name: ((r.full_name as string) || "").trim() || "Member",
            avatar: (r.avatar_url as string) || null,
          };
        }
        setSenderNames((prev) => ({ ...prev, ...map }));
      } catch { /* ignore */ }
    })();
    return () => {
      cancelled = true;
    };
  }, [msgQuery.data]);

    const merged = useMemo(() => {
    const byClient = new Set(
      serverMsgs.map((m) => m.client_id).filter(Boolean) as string[],
    );
    const pending = optimistic.filter(
      (o) => o.client_id && !byClient.has(o.client_id),
    );
    return [...serverMsgs, ...pending].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }, [serverMsgs, optimistic]);

  const scrollToEnd = useCallback((smooth = true) => {
    endRef.current?.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "end",
    });
  }, []);

  useEffect(() => {
    if (!showScroll) scrollToEnd(false);
  }, [merged.length, showScroll, scrollToEnd]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScroll(dist > 120);
  };

  const stopRecTimer = () => {
    if (recTimer.current) {
      clearInterval(recTimer.current);
      recTimer.current = null;
    }
  };

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRec.current = null;
    chunks.current = [];
  };

  const cancelRecording = () => {
    stopRecTimer();
    try {
      mediaRec.current?.stop();
    } catch {
      /* ignore */
    }
    cleanupStream();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setRecording(false);
    setRecPaused(false);
    setRecSecs(0);
  };

  const startRecording = async () => {
    stopAllVoices();
    cancelRecording();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        if (blob.size > 0) {
          setPreviewUrl(URL.createObjectURL(blob));
        }
      };
      mediaRec.current = rec;
      rec.start(200);
      setRecording(true);
      setRecPaused(false);
      setRecSecs(0);
      recTimer.current = setInterval(() => setRecSecs((s) => s + 1), 1000);
    } catch {
      toast.error("Microphone permission required");
    }
  };

  const pauseRecording = () => {
    try {
      mediaRec.current?.pause();
    } catch {
      /* ignore */
    }
    stopRecTimer();
    setRecPaused(true);
  };

  const continueRecording = () => {
    try {
      mediaRec.current?.resume();
    } catch {
      /* ignore */
    }
    setRecPaused(false);
    recTimer.current = setInterval(() => setRecSecs((s) => s + 1), 1000);
  };

  const finishAndSendVoice = async () => {
    stopRecTimer();
    const durationSec = recSecs;
    const replyId = replyTo?.id || null;
    setReplyTo(null);
    await new Promise<void>((resolve) => {
      const rec = mediaRec.current;
      if (!rec || rec.state === "inactive") {
        resolve();
        return;
      }
      rec.onstop = () => {
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        cleanupStream();
        void (async () => {
          const localUrl = URL.createObjectURL(blob);
          const clientId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          setOptimistic((p) => [
            ...p,
            {
              id: clientId,
              conversation_id: conversationId,
              sender_id: userId,
              body: null,
              attachment_url: localUrl,
              attachment_type: "audio",
              reply_to_id: replyId,
              forwarded_from_id: null,
              client_id: clientId,
              duration_sec: durationSec,
              created_at: new Date().toISOString(),
              edited_at: null,
              deleted_at: null,
            },
          ]);
          setRecording(false);
          setRecPaused(false);
          setRecSecs(0);
          setPreviewUrl(null);
          try {
            if (!isOnlineNow()) {
              const { blobToDataUrlIfSmall } = await import("@/lib/message-outbox");
              const dataUrl = await blobToDataUrlIfSmall(blob);
              enqueueOutbox({
                clientId,
                kind: "campus_audio",
                text: "",
                mediaType: "audio",
                blobDataUrl: dataUrl,
                role: "student",
                userId,
                conversationId,
                durationSec,
              });
              toast.message("Voice queued — waiting for connection");
              return;
            }
            const up = await uploadMessageMedia(
              blob,
              "audio/webm",
              `campus/${conversationId}`,
            );
            await sendCampusMessage({
              conversationId,
              senderId: userId,
              attachmentUrl: up.url,
              attachmentType: "audio",
              clientId,
              durationSec,
              replyToId: replyId,
            });
            void qc.invalidateQueries({
              queryKey: ["campus-messages", conversationId],
            });
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Voice send failed");
          }
        })();
        resolve();
      };
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });
  };

  const doSendText = async () => {
    const t = text.trim();
    if (!t || !userId || !conversationId || sendLock.current) return;
    const clientId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyId = replyTo?.id || null;
    setOptimistic((p) => [
      ...p,
      {
        id: clientId,
        conversation_id: conversationId,
        sender_id: userId,
        body: t,
        attachment_url: null,
        attachment_type: null,
        reply_to_id: replyId,
        forwarded_from_id: null,
        client_id: clientId,
        duration_sec: null,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted_at: null,
      },
    ]);
    setText("");
    setReplyTo(null);
    scrollToEnd();
    sendLock.current = true;
    try {
      if (!isOnlineNow()) {
        enqueueOutbox({
          clientId,
          kind: "campus_text",
          text: t,
          role: "student",
          userId,
          conversationId,
        });
        toast.message("Waiting for connection — queued");
        return;
      }
      await sendCampusMessage({
        conversationId,
        senderId: userId,
        body: t,
        clientId,
        replyToId: replyId,
      });
      void qc.invalidateQueries({ queryKey: ["campus-messages", conversationId] });
      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      sendLock.current = false;
    }
  };

  const onFile = async (file: File) => {
    const kind = file.type || "";
    const localUrl = URL.createObjectURL(file);
    const attType = kind.startsWith("image/")
      ? "image"
      : kind.startsWith("video/")
        ? "video"
        : kind.startsWith("audio/")
          ? "audio"
          : "file";
    const clientId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyId = replyTo?.id || null;
    setOptimistic((p) => [
      ...p,
      {
        id: clientId,
        conversation_id: conversationId,
        sender_id: userId,
        body: null,
        attachment_url: localUrl,
        attachment_type: attType,
        reply_to_id: replyId,
        forwarded_from_id: null,
        client_id: clientId,
        duration_sec: null,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted_at: null,
      },
    ]);
    setReplyTo(null);
    try {
      if (!isOnlineNow()) {
        const { blobToDataUrlIfSmall } = await import("@/lib/message-outbox");
        const dataUrl = await blobToDataUrlIfSmall(file);
        enqueueOutbox({
          clientId,
          kind: "campus_media",
          text: "",
          mediaType: attType,
          blobDataUrl: dataUrl,
          role: "student",
          userId,
          conversationId,
        });
        toast.message("Attachment queued — waiting for connection");
        return;
      }
      const up = await uploadMessageMedia(file, kind, `campus/${conversationId}`);
      await sendCampusMessage({
        conversationId,
        senderId: userId,
        attachmentUrl: up.url,
        attachmentType:
          up.type === "image" ? "image" : up.type === "audio" ? "audio" : attType,
        clientId,
        replyToId: replyId,
      });
      void qc.invalidateQueries({ queryKey: ["campus-messages", conversationId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    }
  };

  const URL_RE = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  const linkifyText = (text: string, mine: boolean) => {
    const parts: ReactNode[] = [];
    let last = 0;
    const re = new RegExp(URL_RE.source, "gi");
    let match: RegExpExecArray | null;
    let k = 0;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) parts.push(text.slice(last, match.index));
      const url = match[0];
      parts.push(
        <a
          key={`u-${k++}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn("underline break-all", mine ? "text-blue-700" : "text-white")}
          onClick={(e) => e.stopPropagation()}
        >
          {url}
        </a>,
      );
      last = match.index + url.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length ? parts : text;
  };

  const resolvePeerId = () => {
    if (meta?.isGroup) return null;
    const fromMeta = (meta as { peerUserId?: string } | null)?.peerUserId;
    if (fromMeta) return fromMeta;
    return Object.keys(senderNames).find((id) => id !== userId) || null;
  };

  const startPeerCall = async (callType: "voice" | "video") => {
    const peer = resolvePeerId();
    if (!peer || !userId) {
      toast.error("No peer to call");
      return;
    }
    if (!isOnlineNow()) {
      toast.error("Internet connection is required for calls");
      return;
    }
    try {
      const callId = await startDirectCall({ calleeId: peer, callType, conversationId });
      void notifyCalleeOfIncomingCall({
        calleeId: peer,
        callId,
        callType,
        callerName: displayTitle || "D4EXAM",
      });
      void inviteCalleeOnPersonalChannel({
        calleeId: peer,
        callId,
        callType,
        conversationId,
        callerName: displayTitle || "D4EXAM",
        fromUserId: userId,
      });
      setActiveCall({
        callId,
        callType,
        peerId: peer,
        peerName: displayTitle,
        peerAvatar: senderNames[peer]?.avatar || null,
        peerMatric: null,
        isCaller: true,
        conversationId,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start call");
    }
  };

  const nameOf = (uid: string | null | undefined) => {
    if (!uid) return "Member";
    if (uid === userId) return "You";
    return senderNames[uid]?.name || displayTitle || "Member";
  };
  const replySnippet = (m: CampusMessage) => {
    const at = (m.attachment_type || "").toLowerCase();
    if (at.includes("audio") || at === "voice") {
      const sec = m.duration_sec != null ? Math.max(0, Math.round(Number(m.duration_sec))) : null;
      const t = sec != null ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}` : null;
      return t ? `🎤 Voice note · ${t}` : "🎤 Voice note";
    }
    if (at.includes("image") || at === "photo") return "📷 Photo";
    if (at.includes("video")) return "🎥 Video";
    const b = (m.body || "").trim();
    if (b) return b.slice(0, 80);
    return "Message";
  };
  const findMsg = (id: string | null | undefined) =>
    id ? (merged.find((x) => x.id === id) || null) : null;

    const mm = String(Math.floor(recSecs / 60)).padStart(2, "0");
  const ss = String(recSecs % 60).padStart(2, "0");

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col select-none"
      style={{
        height: "100dvh",
        maxHeight: "100dvh",
        background: "linear-gradient(180deg, #e0f2fe 0%, #f0f9ff 45%, #e0f2fe 100%)",
      }}
    >
      {/* Brand watermark — same as departmental officer chat */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="relative flex items-center justify-center"
            style={{ animation: "d4WatermarkFloat 9s ease-in-out infinite" }}
          >
            <img
              src="/logo.png"
              alt=""
              className="h-[min(48vh,360px)] w-auto max-w-[68%] select-none object-contain opacity-[0.14]"
              style={{ filter: "grayscale(0.25) brightness(1.08)" }}
              loading="eager"
              decoding="async"
            />
            <span
              className="pointer-events-none absolute inset-[8%] overflow-hidden rounded-full"
              style={{
                background:
                  "linear-gradient(115deg, transparent 25%, rgba(255,255,255,0.5) 48%, rgba(147,197,253,0.35) 52%, transparent 75%)",
                backgroundSize: "220% 100%",
                animation: "d4WatermarkShine 5s ease-in-out infinite",
              }}
            />
            <span className="absolute h-2 w-2 rounded-full bg-blue-400/30" style={{ top: "18%", left: "22%", animation: "d4WatermarkOrb 7s ease-in-out infinite" }} />
            <span className="absolute h-1.5 w-1.5 rounded-full bg-sky-300/40" style={{ bottom: "22%", right: "18%", animation: "d4WatermarkOrb 8s ease-in-out infinite reverse" }} />
          </div>
        </div>
        <style>{`
          @keyframes d4WatermarkFloat { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-10px) scale(1.03); } }
          @keyframes d4WatermarkShine { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
          @keyframes d4WatermarkOrb { 0%, 100% { transform: translate(0,0); opacity: 0.35; } 50% { transform: translate(12px,-14px); opacity: 0.7; } }
        `}</style>
      </div>

      {/* Chat header — matches departmental officer chat (commit 3548f25) */}
      <header
        className="relative z-30 flex shrink-0 items-center gap-3 border-b border-white/10 bg-[#0b1b3a] px-3 py-3 text-white"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top, 0px))" }}
      >
        <button
          type="button"
          onClick={() => goBack()}
          className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <span className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-white/15 ring-2 ring-white/90 shadow-md ring-offset-1 ring-offset-[#0b1b3a]">
          {meta?.avatar ? (
            <img src={meta.avatar} alt="" className="h-full w-full object-cover" />
          ) : meta?.isGroup ? (
            <UsersRound className="h-5 w-5 text-white" />
          ) : (
            <User className="h-5 w-5 text-white" />
          )}
          {!meta?.isGroup ? (
            <span
              className={cn(
                "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white",
                peerOnline ? "bg-emerald-400" : "bg-slate-300",
              )}
            />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block max-w-full truncate text-left text-sm font-bold leading-tight"
            onClick={() => {
              if (meta?.isGroup) return;
              const peer = (meta as { peerUserId?: string } | null)?.peerUserId
                || Object.keys(senderNames).find((id) => id !== userId);
              if (peer) openUserProfile(peer);
            }}
          >
            {displayTitle}
          </button>
          <p
            className={cn(
              "truncate text-[11px] font-medium",
              peerTyping || peerRecording ? "text-emerald-300" : "text-white/70",
            )}
          >
            {peerRecording
              ? "Recording a voice note…"
              : peerTyping
                ? "Typing…"
                : peerOnline
                  ? "Online"
                  : peerLastAt
                    ? lastSeenLabel(peerLastAt)
                    : meta?.isGroup
                      ? meta?.subtitle || "Group"
                      : "Last seen just now"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void startPeerCall("voice")}
            className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10"
            aria-label={meta?.isGroup ? "Group voice call" : "Voice call"}
          >
            <Phone className="h-4.5 w-4.5 h-[1.15rem] w-[1.15rem]" />
          </button>
          <button
            type="button"
            onClick={() => void startPeerCall("video")}
            className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10"
            aria-label={meta?.isGroup ? "Group video call" : "Video call"}
          >
            <Video className="h-4.5 w-4.5 h-[1.15rem] w-[1.15rem]" />
          </button>
          <div className="relative">
          <button
            type="button"
            onClick={() => setChatMenuOpen((v) => !v)}
            className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10"
            aria-label="Chat menu"
          >
            <MoreVertical className="h-5 w-5" />
          </button>
          {chatMenuOpen ? (
            <div className="absolute right-0 z-[70] mt-1 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-slate-900 shadow-lg">
              <button
                type="button"
                className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50"
                onClick={() => {
                  setRenameVal(displayTitle);
                  setRenameOpen(true);
                  setChatMenuOpen(false);
                }}
              >
                Rename
              </button>
              {meta?.isGroup ? (
                <button
                  type="button"
                  className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50"
                  onClick={() => {
                    setGroupMenuOpen(true);
                    setChatMenuOpen(false);
                  }}
                >
                  Group settings
                </button>
              ) : null}
              <button
                type="button"
                className="block w-full px-3 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
                onClick={() => {
                  setClearOpen(true);
                  setChatMenuOpen(false);
                }}
              >
                Clear chat
              </button>
            </div>
          ) : null}
        </div>
        </div>
      </header>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="relative z-10 min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-2">
          {merged.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
              <p className="text-sm font-semibold text-slate-600">
                No messages yet
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Say hello — send a text or voice note below.
              </p>
            </div>
          ) : null}
          {merged.map((m) => {
            const mine = m.sender_id === userId;
            const urls = parseMediaUrls(m.attachment_url);
            const att = (m.attachment_type || "").toLowerCase();
            const isCall = att === "call" || att.includes("call");
            const isVoice = !isCall && (att.includes("audio") || att === "voice");
            const isImage = !isCall && (att.includes("image") || att === "photo");
            const isVideo = !isCall && att.includes("video") && !att.includes("call");
            const isFile =
              Boolean(m.attachment_url) && !isVoice && !isImage && !isVideo && !isCall;
            const pending =
              m.id.startsWith("opt-") || Boolean(m.client_id?.startsWith("opt-"));
            const timeLabel = formatTime(m.created_at);
            const tick = pending ? "pending" : "delivered";

            return (
              <div
                key={m.id}
                id={`msg-${m.id}`}
                className={cn(
                  "relative flex w-full touch-pan-y rounded-2xl transition-shadow duration-300",
                  mine ? "justify-end" : "justify-start",
                  highlightId === m.id && "ring-2 ring-[#2563eb] ring-offset-2 ring-offset-[#e8f4fc]",
                )}
                style={{
                  transform: `translateX(${swipeDx[m.id] || 0}px)`,
                  transition: swipeRef.current?.key === m.id ? "none" : "transform 0.2s ease",
                }}
                onTouchStart={(e) => {
                  swipeRef.current = {
                    key: m.id,
                    x: e.touches[0]?.clientX ?? 0,
                    y: e.touches[0]?.clientY ?? 0,
                    axis: "none",
                    dx: 0,
                  };
                  if (lpTimer.current) clearTimeout(lpTimer.current);
                  lpTimer.current = setTimeout(() => {
                    setLongPressMsg(m);
                    setSwipeDx((prev) => {
                      const n = { ...prev };
                      delete n[m.id];
                      return n;
                    });
                  }, 480);
                }}
                onTouchMove={(e) => {
                  const s = swipeRef.current;
                  if (!s || s.key !== m.id) return;
                  const x = e.touches[0]?.clientX ?? 0;
                  const y = e.touches[0]?.clientY ?? 0;
                  const rawX = x - s.x;
                  const rawY = y - s.y;
                  if (s.axis === "none") {
                    if (Math.abs(rawX) < 12 && Math.abs(rawY) < 12) return;
                    s.axis = Math.abs(rawX) > Math.abs(rawY) * 1.15 ? "h" : "v";
                    if (s.axis === "h" && lpTimer.current) {
                      clearTimeout(lpTimer.current);
                      lpTimer.current = null;
                    }
                  }
                  if (s.axis === "v") {
                    if (lpTimer.current) {
                      clearTimeout(lpTimer.current);
                      lpTimer.current = null;
                    }
                    return;
                  }
                  const next = Math.max(-72, Math.min(72, rawX));
                  s.dx = next;
                  setSwipeDx((prev) =>
                    prev[m.id] === next ? prev : { ...prev, [m.id]: next },
                  );
                }}
                onTouchEnd={() => {
                  if (lpTimer.current) {
                    clearTimeout(lpTimer.current);
                    lpTimer.current = null;
                  }
                  const s = swipeRef.current;
                  const dx = s?.key === m.id ? s.dx : 0;
                  swipeRef.current = null;
                  setSwipeDx((prev) => {
                    const n = { ...prev };
                    delete n[m.id];
                    return n;
                  });
                  if (Math.abs(dx) > 40) setReplyTo(m);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setLongPressMsg(m);
                }}
              >
                {/* Blue reply affordance while swiping */}
                {Math.abs(swipeDx[m.id] || 0) > 24 ? (
                  <div
                    className={cn(
                      "pointer-events-none absolute top-1/2 z-0 flex -translate-y-1/2 items-center gap-1",
                      mine ? "left-2" : "right-2",
                    )}
                  >
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-[#2563eb] text-white shadow-md">
                      <Reply className="h-4 w-4" />
                    </span>
                  </div>
                ) : null}
                <div className={cn("flex max-w-[92%] items-start gap-2", mine ? "flex-row-reverse" : "flex-row")}>
                  {meta?.isGroup && !mine ? (
                    <button
                      type="button"
                      onClick={() => openUserProfile(m.sender_id)}
                      className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[#0b1b3a] text-[10px] font-bold text-white ring-2 ring-white shadow"
                    >
                      {senderNames[m.sender_id]?.avatar ? (
                        <img src={senderNames[m.sender_id]!.avatar!} alt="" className="h-full w-full object-cover" />
                      ) : (
                        (nameOf(m.sender_id).slice(0, 2) || "?").toUpperCase()
                      )}
                    </button>
                  ) : null}
                  <div className={cn("flex min-w-0 flex-col", mine ? "items-end" : "items-start")}>
                    {meta?.isGroup ? (
                      <button
                        type="button"
                        onClick={() => openUserProfile(m.sender_id)}
                        className={cn(
                          "mb-1 inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-bold",
                          mine
                            ? "bg-slate-200/80 text-slate-600"
                            : "bg-[#dbeafe] text-[#1d4ed8]",
                        )}
                      >
                        {nameOf(m.sender_id)}
                      </button>
                    ) : null}
                    {m.forwarded_from_id ? (
                      <span
                        className={cn(
                          "mb-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold",
                          mine
                            ? "bg-slate-200/90 text-slate-600"
                            : "bg-[#dbeafe] text-[#1d4ed8]",
                        )}
                      >
                        <CornerUpRight className="h-3 w-3" aria-hidden /> Forwarded
                      </span>
                    ) : null}
                {isCall ? (
                  <CallEventBubble
                    body={m.body || "Call"}
                    mine={mine}
                    timeLabel={timeLabel}
                    onCallback={(t) => void startPeerCall(t)}
                  />
                ) : isVoice && m.attachment_url ? (
                  <div className="flex flex-col gap-1">
                    {m.reply_to_id ? (
                      <button
                        type="button"
                        onClick={() => {
                          const id = m.reply_to_id;
                          if (!id) return;
                          setHighlightId(id);
                          const el = document.getElementById(`msg-${id}`);
                          el?.scrollIntoView({ behavior: "smooth", block: "center" });
                          window.setTimeout(() => setHighlightId(null), 1600);
                        }}
                        className={cn(
                          "w-full min-w-[10rem] rounded-lg border-l-2 px-2 py-1 text-left text-[11px]",
                          mine
                            ? "border-blue-400 bg-white/90 text-slate-600"
                            : "border-[#2563eb] bg-white text-slate-600",
                        )}
                      >
                        <p className="truncate font-bold">
                          {nameOf(findMsg(m.reply_to_id)?.sender_id)}
                        </p>
                        <p className="line-clamp-2 break-words opacity-80">
                          {findMsg(m.reply_to_id)
                            ? replySnippet(findMsg(m.reply_to_id)!)
                            : "Message"}
                        </p>
                      </button>
                    ) : null}
                    <VoiceBubble
                      id={m.id}
                      src={m.attachment_url}
                      mine={mine}
                      timeLabel={timeLabel}
                      tick={tick === "pending" ? "pending" : mine ? "delivered" : "none"}
                      durationSec={m.duration_sec}
                    />
                  </div>
                ) : isImage && (urls[0] || m.attachment_url) ? (
                  <ImageBubble
                    id={m.id}
                    src={urls[0] || m.attachment_url!}
                    count={Math.max(urls.length, 1)}
                    mine={mine}
                    timeLabel={timeLabel}
                    tick={tick === "pending" ? "pending" : mine ? "delivered" : "none"}
                    onOpen={() => {
                      setLightboxUrls(urls.length ? urls : [urls[0] || m.attachment_url!]);
                      setLightboxIndex(0);
                    }}
                  />
                ) : isVideo && m.attachment_url ? (
                  <VideoBubble
                    src={m.attachment_url}
                    mine={mine}
                    timeLabel={timeLabel}
                    tick={tick === "pending" ? "pending" : mine ? "delivered" : "none"}
                    onOpen={() => setVideoSrc(m.attachment_url!)}
                    durationSec={m.duration_sec}
                    forwarded={Boolean(m.forwarded_from_id)}
                  />
                ) : isFile && m.attachment_url ? (
                  <FileBubble
                    src={m.attachment_url}
                    mine={mine}
                    timeLabel={timeLabel}
                    tick={tick === "pending" ? "pending" : mine ? "delivered" : "none"}
                  />
                ) : (
                  <div
                    className={cn(
                      "min-w-[7.5rem] max-w-[85%] md:max-w-[70%] rounded-2xl px-3 py-2 text-sm shadow-sm",
                      mine
                        ? "rounded-br-md border border-slate-200 bg-white text-slate-800"
                        : "rounded-bl-md bg-[#2563eb] text-white",
                    )}
                  >
                    {m.reply_to_id ? (
                      <button
                        type="button"
                        onClick={() => {
                          const id = m.reply_to_id;
                          if (!id) return;
                          setHighlightId(id);
                          const el = document.getElementById(`msg-${id}`);
                          el?.scrollIntoView({ behavior: "smooth", block: "center" });
                          window.setTimeout(() => setHighlightId(null), 1600);
                        }}
                        className={cn(
                          "mb-1.5 w-full rounded-lg border-l-2 px-2 py-1 text-left text-[11px]",
                          mine
                            ? "border-blue-400 bg-slate-50 text-slate-600"
                            : "border-white/50 bg-white/15 text-blue-50",
                        )}
                      >
                        <p className="truncate font-bold opacity-90">
                          {nameOf(findMsg(m.reply_to_id)?.sender_id)}
                        </p>
                        <p className="line-clamp-2 break-words opacity-80">
                          {findMsg(m.reply_to_id)
                            ? replySnippet(findMsg(m.reply_to_id)!)
                            : "Original message"}
                        </p>
                      </button>
                    ) : null}
                    {m.body ? (
                      <LinkMessageBody body={m.body} mine={mine} linkifyText={linkifyText} />
                    ) : null}
                    <div
                      className={cn(
                        "mt-1 flex shrink-0 items-center justify-end gap-1 whitespace-nowrap text-[10px] tabular-nums",
                        mine ? "text-slate-400" : "text-white/70",
                      )}
                    >
                      <span className="shrink-0">{timeLabel}</span>
                      {mine ? (
                        pending ? (
                          <Check className="h-3 w-3 shrink-0 opacity-70" />
                        ) : (
                          <CheckCheck className="h-3 w-3 shrink-0" />
                        )
                      ) : null}
                    </div>
                  </div>
                )}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        {showScroll ? (
          <button
            type="button"
            onClick={() => scrollToEnd(true)}
            className="absolute bottom-3 left-1/2 z-10 grid h-10 w-10 -translate-x-1/2 place-items-center rounded-full bg-[#2563eb] text-lg font-bold text-white shadow-lg animate-pulse"
            aria-label="Scroll to latest"
          >
            ↓
          </button>
        ) : null}
      </div>

      <div
        className="relative z-30 shrink-0 border-t border-white/10 bg-[#0b1b3a] px-2 py-2 text-white"
        style={{
          paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0px))",
        }}
      >
        {recording ? (
          <VoiceRecorderBar
            recording={recording}
            paused={recPaused}
            seconds={recSecs}
            previewUrl={null}
            onCancel={cancelRecording}
            onPause={pauseRecording}
            onContinue={continueRecording}
            onPreviewPlay={() => {}}
            onSend={() => void finishAndSendVoice()}
          />
        ) : (
          <>
          {typingLink ? (
            <div className="mx-auto mb-2 max-w-2xl overflow-hidden rounded-xl border border-slate-200/80 bg-white/95 shadow-sm">
              {linkMeta?.loading || !linkMeta ? (
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div className="relative grid h-9 w-9 shrink-0 place-items-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-[#2563eb]/20" />
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-[#2563eb]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-bold text-slate-800">Generating link…</p>
                    <p className="truncate text-[11px] text-slate-500">{typingLink}</p>
                  </div>
                </div>
              ) : (
                <div className="flex gap-3 p-2.5">
                  {linkMeta.image ? (
                    <img src={linkMeta.image} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-slate-100 text-lg">🔗</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-1 text-[13px] font-bold text-slate-900">{linkMeta.title || linkMeta.host}</p>
                    {linkMeta.description ? (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{linkMeta.description}</p>
                    ) : null}
                    <p className="mt-1 truncate text-[10px] font-semibold uppercase tracking-wide text-slate-400">{linkMeta.host}</p>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          {replyTo ? (
            <div className="mx-auto mb-2 flex max-w-2xl items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-blue-800">
                  Replying to {nameOf(replyTo.sender_id)}
                </p>
                <p className="line-clamp-2 text-xs text-slate-700">
                  {replySnippet(replyTo)}
                </p>
              </div>
              <button type="button" onClick={() => setReplyTo(null)} className="text-slate-400" aria-label="Cancel reply">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}
          <div className="mx-auto flex max-w-2xl items-end gap-1.5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="mb-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/10"
              aria-label="Attach"
            >
              <Paperclip className="h-5 w-5" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                if (!files.length) return;
                const images = files.filter((f) => f.type.startsWith("image/"));
                const rest = files.filter((f) => !f.type.startsWith("image/"));
                void (async () => {
                  if (images.length > 1) {
                    await onImagesBatch(images);
                  } else if (images.length === 1) {
                    await onFile(images[0]);
                  }
                  for (const f of rest) await onFile(f);
                })();
                e.target.value = "";
              }}
            />
            <div className="flex min-w-0 flex-1 items-end rounded-full border border-white/20 bg-white px-3">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={1}
                placeholder="Type your message…"
                className="max-h-24 min-h-[36px] w-full resize-none bg-transparent py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void doSendText();
                  }
                }}
              />
            </div>
            {text.trim() ? (
              <button
                type="button"
                onClick={() => void doSendText()}
                className="mb-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#2563eb] text-white"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startRecording()}
                className={cn(
                  "mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-white shadow-lg transition active:scale-95",
                  "bg-gradient-to-b from-[#60a5fa] via-[#3b82f6] to-[#1d4ed8]",
                  "ring-2 ring-white/60 ring-offset-1 ring-offset-[#0b1b3a]",
                )}
                aria-label="Record voice"
              >
                <Mic className="h-5 w-5" />
              </button>
            )}
          </div>
          </>
        )}
      </div>

      {clearOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-extrabold text-slate-900">Clear this chat?</h3>
            <p className="mt-1 text-xs text-slate-500">
              All messages in this conversation will be deleted. This cannot be undone.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold"
                onClick={() => setClearOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-700"
                onClick={() => {
                  void (async () => {
                    try {
                      await clearCampusConversation(conversationId);
                      setOptimistic([]);
                      void qc.invalidateQueries({ queryKey: ["campus-messages", conversationId] });
                      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
                      setClearOpen(false);
                      toast.success("Chat cleared");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Could not clear chat");
                    }
                  })();
                }}
              >
                Clear chat
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameOpen && !meta?.isGroup ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-extrabold text-slate-900">Rename</h3>
            <input
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              className="mt-3 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/25"
              placeholder="Display name"
            />
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold"
                onClick={() => setRenameOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-[#2563eb] py-2.5 text-sm font-bold text-white"
                onClick={() => {
                  const v = renameVal.trim();
                  if (v) {
                    setLocalTitle(v);
                    try {
                      localStorage.setItem(`d4exam.msg.nick.${conversationId}`, v);
                    } catch { /* ignore */ }
                  }
                  setRenameOpen(false);
                  toast.success("Name updated");
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {longPressMsg ? (
        <LongPressMenu
          open={Boolean(longPressMsg)}
          onClose={() => setLongPressMsg(null)}
          items={[
            {
              label: "Copy",
              icon: "copy",
              onClick: () => {
                const t =
                  longPressMsg.body ||
                  replySnippet(longPressMsg);
                void navigator.clipboard?.writeText(t);
                toast.success("Copied");
                setLongPressMsg(null);
              },
            },
            ...(longPressMsg.sender_id === userId &&
            longPressMsg.body &&
            !(longPressMsg.attachment_type || "").includes("audio") &&
            !(longPressMsg.attachment_type || "").includes("image")
              ? [
                  {
                    label: "Edit",
                    icon: "edit" as const,
                    onClick: () => {
                      setEditMsg(longPressMsg);
                      setEditText(longPressMsg.body || "");
                      setLongPressMsg(null);
                    },
                  },
                ]
              : []),
            {
              label: "Forward",
              onClick: () => {
                setForwardMsg(longPressMsg);
                setLongPressMsg(null);
              },
            },
            ...(longPressMsg.sender_id === userId
              ? [
                  {
                    label: "Delete",
                    icon: "delete" as const,
                    danger: true,
                    onClick: () => {
                      void (async () => {
                        try {
                          await deleteCampusMessage(longPressMsg.id);
                          void qc.invalidateQueries({
                            queryKey: ["campus-messages", conversationId],
                          });
                          toast.success("Deleted");
                        } catch (e) {
                          toast.error(
                            e instanceof Error ? e.message : "Delete failed",
                          );
                        }
                        setLongPressMsg(null);
                      })();
                    },
                  },
                ]
              : []),
          ]}
        />
      ) : null}

      {editMsg ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-extrabold">Edit message</h3>
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={3}
              className="mt-3 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/25"
            />
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl border py-2.5 text-sm font-semibold"
                onClick={() => setEditMsg(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-[#2563eb] py-2.5 text-sm font-bold text-white"
                onClick={() => {
                  void (async () => {
                    try {
                      await editCampusMessage(editMsg.id, editText.trim());
                      void qc.invalidateQueries({
                        queryKey: ["campus-messages", conversationId],
                      });
                      setEditMsg(null);
                      toast.success("Updated");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Edit failed");
                    }
                  })();
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {profileSheetUserId ? (
        <MessagingProfileSheet
          userId={profileSheetUserId}
          seedName={profileSheetSeed.name}
          seedAvatar={profileSheetSeed.avatar}
          seedMatric={profileSheetSeed.matric}
          open
          onClose={() => setProfileSheetUserId(null)}
          conversationId={conversationId}
          onStartCall={(opts) => setActiveCall({ ...opts, conversationId })}
        />
      ) : null}

      {activeCall && userId ? (
        <CallOverlay
          call={activeCall}
          myUserId={userId}
          onClose={() => setActiveCall(null)}
        />
      ) : null}
      {lightboxUrls && lightboxUrls.length ? (
        <ImageLightbox
          urls={lightboxUrls}
          index={lightboxIndex}
          onClose={() => {
            setLightboxUrls(null);
            setLightboxSrc(null);
          }}
        />
      ) : lightboxSrc ? (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      ) : null}
      {videoSrc ? (
        <VideoLightbox src={videoSrc} onClose={() => setVideoSrc(null)} />
      ) : null}

      {forwardMsg ? (
        <ForwardSheet
          userId={userId}
          source={forwardMsg}
          onClose={() => setForwardMsg(null)}
          onDone={() => {
            setForwardMsg(null);
            toast.success("Message forwarded");
          }}
        />
      ) : null}

      {meta?.isGroup && (meta.creatorName || meta.created_at) ? (
        <div className="shrink-0 border-b border-blue-50 bg-[#eff6ff] px-4 py-2 text-center text-[11px] text-slate-600">
          <span className="font-semibold text-[#2563eb]">Study group</span>
          {meta.creatorName ? (
            <span>
              {" "}
              · Created by <span className="font-semibold text-slate-800">{meta.creatorName}</span>
            </span>
          ) : null}
          {meta.created_at ? (
            <span>
              {" "}
              ·{" "}
              {new Date(meta.created_at).toLocaleDateString([], {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          ) : null}
          {meta.memberCount ? (
            <span> · {meta.memberCount} members</span>
          ) : null}
        </div>
      ) : null}

      {groupMenuOpen && meta?.isGroup ? (
        <GroupMenuSheet
          conversationId={conversationId}
          userId={userId}
          title={meta.title}
          creatorName={meta.creatorName}
          createdAt={meta.created_at}
          onClose={() => setGroupMenuOpen(false)}
          onLeft={() => goBack()}
        />
      ) : null}
    </div>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function CallEventBubble({
  body,
  mine,
  timeLabel,
  onCallback,
}: {
  body: string;
  mine: boolean;
  timeLabel: string;
  onCallback?: (type: "voice" | "video") => void;
}) {
  const isVideo = /video/i.test(body);
  const isMissed = /missed/i.test(body);
  const isNoAnswer = /no answer/i.test(body);
  const isDeclined = /declined/i.test(body);
  const isEnded = /ended/i.test(body) && !isMissed && !isNoAnswer;

  // Recipient sees missed; caller sees no answer
  const showAsMissed = !mine && (isMissed || isNoAnswer);
  const showAsNoAnswer = mine && (isNoAnswer || isMissed);

  let headline = body;
  let sub = timeLabel;
  let actionLabel = "";
  let iconBg = "bg-[#2563eb]";

  if (showAsMissed) {
    headline = isVideo ? "You missed a video call" : "You missed a call";
    sub = "Tap to call back · " + timeLabel;
    actionLabel = "Call back";
    iconBg = "bg-gradient-to-br from-rose-500 to-rose-700";
  } else if (showAsNoAnswer) {
    headline = isVideo ? "Video call · No answer" : "No answer";
    sub = "They didn't pick up · " + timeLabel;
    actionLabel = "Call again";
    iconBg = "bg-gradient-to-br from-orange-500 to-amber-600";
  } else if (isDeclined) {
    headline = "Call declined";
    sub = timeLabel;
    actionLabel = "Call again";
    iconBg = "bg-slate-600";
  } else if (isEnded) {
    headline = isVideo ? "Video call ended" : "Voice call ended";
    sub = timeLabel;
    iconBg = "bg-[#1e3a6e]";
  }

  return (
    <div className={"w-[min(82vw,300px)] " + (mine ? "ml-auto" : "")}>
      <div className="overflow-hidden rounded-[18px] border border-white/10 bg-[#0f172a] shadow-[0_8px_30px_rgba(0,0,0,0.25)]">
        <div className="flex items-center gap-3 px-3.5 pt-3.5">
          <span className={"grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-xl text-white shadow-inner " + iconBg}>
            {isVideo ? "🎥" : "📞"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-extrabold leading-tight text-white">{headline}</p>
            <p className="mt-0.5 text-[11.5px] font-medium text-slate-400">{sub}</p>
          </div>
        </div>
        {actionLabel && onCallback ? (
          <div className="p-3 pt-2.5">
            <button
              type="button"
              onClick={() => onCallback(isVideo ? "video" : "voice")}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-[13px] font-extrabold text-[#0b1b3a] shadow-sm transition active:scale-[0.98]"
            >
              <span aria-hidden>{isVideo ? "📹" : "📞"}</span>
              {actionLabel}
            </button>
          </div>
        ) : (
          <div className="h-3" />
        )}
      </div>
    </div>
  );
}


function LinkMessageBody({
  body,
  mine,
  linkifyText,
}: {
  body: string;
  mine: boolean;
  linkifyText: (t: string, mine: boolean) => ReactNode;
}) {
  const urlMatch = body.trim().match(/^https?:\/\/[^\s]+$/i);
  const [meta, setMeta] = useState<{
    title?: string;
    description?: string;
    image?: string;
    host?: string;
  } | null>(null);

  useEffect(() => {
    if (!urlMatch) return;
    const url = urlMatch[0].replace(/[),.]+$/, "");
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `https://api.microlink.io?url=${encodeURIComponent(url)}&palette=false&audio=false&video=false&iframe=false`,
        );
        const json = await res.json();
        if (cancelled || json.status !== "success") return;
        setMeta({
          title: json.data?.title,
          description: json.data?.description,
          image: json.data?.image?.url,
          host: new URL(url).hostname,
        });
      } catch {
        try {
          if (!cancelled) setMeta({ host: new URL(url).hostname, title: new URL(url).hostname });
        } catch { /* ignore */ }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [body]);

  if (urlMatch && meta) {
    const href = urlMatch[0].replace(/[),.]+$/, "");
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="block max-w-[min(52vw,190px)] overflow-hidden rounded-xl bg-black/10 text-left"
        onClick={(e) => e.stopPropagation()}
      >
        {meta.image ? (
          <img src={meta.image} alt="" className="h-24 w-full object-cover" />
        ) : null}
        <div className="px-2.5 py-2">
          <p className={cn("line-clamp-2 text-[12px] font-bold", mine ? "text-slate-900" : "text-white")}>
            {meta.title || meta.host}
          </p>
          {meta.description ? (
            <p className={cn("mt-0.5 line-clamp-2 text-[10px] leading-snug", mine ? "text-slate-600" : "text-white/80")}>
              {meta.description}
            </p>
          ) : null}
          <p className={cn("mt-1 truncate text-[9px] font-semibold uppercase tracking-wide", mine ? "text-slate-400" : "text-white/55")}>
            {meta.host || href}
          </p>
        </div>
      </a>
    );
  }

  if (urlMatch && !meta) {
    return (
      <p className={cn("break-all text-[13px] underline", mine ? "text-slate-800" : "text-white")}>
        {body.trim()}
      </p>
    );
  }

  return (
    <p className="break-words whitespace-pre-wrap text-[15px] leading-snug">
      {linkifyText(body, mine)}
    </p>
  );
}


function ForwardSheet({
  userId,
  source,
  onClose,
  onDone,
}: {
  userId: string;
  source: CampusMessage;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: convs = [], isLoading } = useQuery({
    queryKey: ["campus-conversations", userId, "forward"],
    enabled: Boolean(userId),
    queryFn: () => listMyConversations(userId),
  });
  const [busy, setBusy] = useState<string | null>(null);

  const sendTo = async (targetId: string) => {
    if (busy) return;
    setBusy(targetId);
    try {
      const clientId = `fwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!isOnlineNow()) {
        enqueueOutbox({
          clientId,
          kind: "campus_forward",
          text: source.body || "",
          mediaUrl: source.attachment_url,
          mediaType: source.attachment_type,
          role: "student",
          userId,
          conversationId: targetId,
          durationSec: source.duration_sec,
          forwardedFromId: source.id,
        });
        toast.message("Queued — will send when online");
        onDone();
        return;
      }
      await forwardCampusMessage({
        targetConversationId: targetId,
        senderId: userId,
        source,
        clientId,
      });
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Forward failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div className="flex max-h-[70dvh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-xl sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <Forward className="h-4 w-4 text-[#2563eb]" />
            <h2 className="text-sm font-bold">Forward to…</h2>
          </div>
          <button type="button" onClick={onClose} className="text-sm font-semibold text-slate-500">
            Cancel
          </button>
        </div>
        <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>
          ) : convs.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-500">No chats yet</p>
          ) : (
            convs.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy === c.id || c.id === source.conversation_id}
                onClick={() => void sendTo(c.id)}
                className="flex w-full items-center gap-3 border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50 disabled:opacity-40"
              >
                <div className="grid h-10 w-10 place-items-center rounded-full bg-[#0b1b3a] text-xs font-bold text-white">
                  {c.isGroup ? <UsersRound className="h-4 w-4" /> : c.title.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{c.title}</p>
                  <p className="truncate text-[11px] text-slate-500">{c.isGroup ? "Group" : "Chat"}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function GroupMenuSheet({
  conversationId,
  userId,
  title,
  creatorName,
  createdAt,
  onClose,
  onLeft,
}: {
  conversationId: string;
  userId: string;
  title: string;
  creatorName?: string | null;
  createdAt?: string | null;
  onClose: () => void;
  onLeft: () => void;
}) {
  const qc = useQueryClient();
  const [rename, setRename] = useState(title);
  const [renaming, setRenaming] = useState(false);
  const membersQ = useQuery({
    queryKey: ["campus-members", conversationId],
    queryFn: () => listConversationMembers(conversationId),
  });
  const me = (membersQ.data || []).find((m) => m.user_id === userId);
  const isAdmin = me?.role === "admin" || me?.role === "owner";

  const saveRename = async () => {
    if (!rename.trim()) return;
    try {
      await updateGroupMeta(conversationId, { title: rename.trim() });
      void qc.invalidateQueries({ queryKey: ["campus-conv-meta", conversationId] });
      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
      toast.success("Group renamed");
      setRenaming(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
    }
  };

  const iconRef = useRef<HTMLInputElement>(null);
  const changeIcon = async (file: File) => {
    try {
      const up = await uploadMessageMedia(file, file.type || "image/jpeg", `campus-group/${conversationId}`);
      await updateGroupMeta(conversationId, { avatar_url: up.url });
      void qc.invalidateQueries({ queryKey: ["campus-conv-meta", conversationId] });
      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
      toast.success("Group icon updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Icon update failed");
    }
  };

  const doLeave = async () => {
    try {
      await leaveGroup(conversationId, userId);
      toast.success("Left group");
      onLeft();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not leave");
    }
  };

  const doDelete = async () => {
    if (!isAdmin) return;
    if (!window.confirm("Delete this group for everyone?")) return;
    try {
      await deleteGroup(conversationId);
      toast.success("Group deleted");
      onLeft();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const [addOpen, setAddOpen] = useState(false);
  const [addQ, setAddQ] = useState("");
  const addStudentsQ = useQuery({
    queryKey: ["group-add-students", addQ],
    enabled: addOpen,
    queryFn: () =>
      discoverStudents({
        schoolId: "",
        query: addQ,
        excludeUserId: userId,
        limit: 30,
      }),
  });

  const addOne = async (authUserId: string | null) => {
    if (!authUserId) {
      toast.error("Student account not linked");
      return;
    }
    try {
      await addGroupMembers(conversationId, [authUserId]);
      void membersQ.refetch();
      toast.success("Member added");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add");
    }
  };

  const toggleMute = async () => {
    try {
      await setGroupMuted(conversationId, userId, !me?.muted);
      void membersQ.refetch();
      toast.success(me?.muted ? "Unmuted" : "Muted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const removeMember = async (uid: string) => {
    try {
      await removeGroupMember(conversationId, uid);
      void membersQ.refetch();
      toast.success("Member removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Remove failed");
    }
  };

  const toggleAdmin = async (memberId: string, currentRole: string) => {
    if (currentRole === "owner") {
      toast.error("You cannot demote the group owner");
      return;
    }
    const next = currentRole === "admin" ? "member" : "admin";
    try {
      await setConversationMemberRole(conversationId, memberId, next);
      void membersQ.refetch();
      void qc.invalidateQueries({ queryKey: ["campus-members", conversationId] });
      toast.success(next === "admin" ? "Made admin" : "Demoted to member");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update role");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div className="flex max-h-[80dvh] w-full max-w-md flex-col rounded-t-3xl bg-white shadow-xl sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-bold">Group settings</h2>
          <button type="button" onClick={onClose} className="text-sm font-semibold text-slate-500">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {(creatorName || createdAt) && (
            <div className="rounded-xl bg-[#eff6ff] px-3 py-2 text-xs text-slate-600">
              {creatorName ? (
                <p>
                  Created by <span className="font-semibold text-slate-900">{creatorName}</span>
                </p>
              ) : null}
              {createdAt ? (
                <p className="mt-0.5 text-slate-500">
                  {new Date(createdAt).toLocaleString()}
                </p>
              ) : null}
            </div>
          )}
          {isAdmin ? (
            <div>
              <p className="text-xs font-semibold text-slate-500">Group icon</p>
              <button
                type="button"
                onClick={() => iconRef.current?.click()}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-sm font-semibold text-[#2563eb]"
              >
                Change group icon
              </button>
              <input
                ref={iconRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void changeIcon(f);
                  e.target.value = "";
                }}
              />
              <p className="mt-3 text-xs font-semibold text-slate-500">Group name</p>
              {renaming ? (
                <div className="mt-1 flex gap-2">
                  <input
                    value={rename}
                    onChange={(e) => setRename(e.target.value)}
                    className="h-10 flex-1 rounded-xl border border-slate-200 px-3 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void saveRename()}
                    className="rounded-xl bg-[#2563eb] px-3 text-xs font-bold text-white"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  className="mt-1 text-sm font-semibold text-[#2563eb]"
                >
                  {title} · Rename
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm font-semibold text-slate-800">{title}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void toggleMute()}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-700"
            >
              {me?.muted ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              {me?.muted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              onClick={() => void doLeave()}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-rose-200 py-2.5 text-xs font-bold text-rose-600"
            >
              <LogOut className="h-4 w-4" />
              Leave
            </button>
          </div>

          {isAdmin ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAddOpen((v) => !v)}
                className="flex flex-1 items-center justify-center rounded-xl border border-slate-200 py-2.5 text-xs font-bold text-slate-800"
              >
                Add members
              </button>
              <button
                type="button"
                onClick={() => void doDelete()}
                className="flex flex-1 items-center justify-center rounded-xl border border-red-200 bg-red-50 py-2.5 text-xs font-bold text-red-700"
              >
                Delete group
              </button>
            </div>
          ) : null}

          {addOpen ? (
            <div className="rounded-xl border border-slate-100 p-2">
              <input
                value={addQ}
                onChange={(e) => setAddQ(e.target.value)}
                placeholder="Search name or matric..."
                className="mb-2 h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
              />
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {(addStudentsQ.data || []).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => void addOne(s.auth_user_id)}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{s.full_name}</span>
                      {s.matric_number ? (
                        <span className="ml-1 text-[10px] text-slate-400">{s.matric_number}</span>
                      ) : null}
                    </span>
                    <span className="text-[10px] font-bold text-[#2563eb]">Add</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Members ({(membersQ.data || []).length})
            </p>
            {(membersQ.data || []).map((m) => (
              <div key={m.user_id} className="relative z-10 flex items-center gap-2 border-b border-slate-50 py-2">
                <div className="grid h-8 w-8 place-items-center rounded-full bg-slate-200 text-[10px] font-bold">
                  {m.full_name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{m.full_name}</p>
                  <p className="text-[10px] text-slate-500">{m.role}</p>
                </div>
                {isAdmin && m.user_id !== userId ? (
                  <div className="flex items-center gap-1">
                    {m.role === "owner" ? (
                      <span className="rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700">
                        Owner
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void toggleAdmin(m.user_id, m.role)}
                        className="rounded-lg bg-[#eff6ff] px-2 py-1 text-[10px] font-bold text-[#2563eb]"
                      >
                        {m.role === "admin" ? "Demote" : "Make admin"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void removeMember(m.user_id)}
                      className="grid h-8 w-8 place-items-center rounded-full text-rose-500 hover:bg-rose-50"
                      aria-label="Remove"
                    >
                      <UserMinus className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
