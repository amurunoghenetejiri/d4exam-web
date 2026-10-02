// @ts-nocheck
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  Bell,
  Building2,
  ChevronRight,
  Flag,
  GraduationCap,
  Hash,
  Heart,
  Image as ImageIcon,
  Loader2,
  MessageCircle,
  MoreVertical,
  Phone,
  Users,
  UsersRound,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useSessionUser } from "@/lib/session";
import {
  blockUser,
  fetchPublicProfile,
  unblockUser,
  updateMyProfilePhoto,
  updateMyBio,
} from "@/lib/user-profile";
import { getOrCreateDirectConversation, listMessages } from "@/lib/messaging";
import { appNavigate } from "@/lib/app-navigate";
import { startDirectCall } from "@/lib/calls";
import { isOnlineNow } from "@/lib/offline-guard";
import { ProfilePhotoViewer } from "@/components/profile/ProfilePhotoViewer";
import { isFavorite, toggleFavorite } from "@/lib/profile-favorites";
import { supabase } from "@/integrations/supabase/client";

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || "")
      .join("") || "?"
  );
}

export function UserProfileView({
  userId,
  onBack,
  groupContext,
  onStartCall,
}: {
  userId: string;
  onBack?: () => void;
  groupContext?: { id: string; name: string } | null;
  onStartCall?: (opts: {
    callId: string;
    callType: "voice" | "video";
    peerId: string;
    peerName: string;
    peerAvatar: string | null;
    peerMatric?: string | null;
    isCaller: boolean;
  }) => void;
}) {
  const { data: session } = useSessionUser();
  const myId = session?.userId || "";
  const qc = useQueryClient();
  const [photoOpen, setPhotoOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [bioEditOpen, setBioEditOpen] = useState(false);
  const [mediaSheetOpen, setMediaSheetOpen] = useState(false);
  const [mediaViewIndex, setMediaViewIndex] = useState(0);
  const [callHistOpen, setCallHistOpen] = useState(false);
  const [callHistTab, setCallHistTab] = useState<"all" | "missed" | "declined">("all");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState("");
  const [bioDraft, setBioDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [fav, setFav] = useState(() =>
    Boolean(myId && userId && isFavorite(myId, userId)),
  );

  const profileQ = useQuery({
    queryKey: ["public-profile", userId, myId],
    enabled: Boolean(userId && userId.length > 8),
    queryFn: () => fetchPublicProfile(userId, myId),
    staleTime: 20_000,
    retry: 1,
  });

  const p = profileQ.data;
  const loading = profileQ.isLoading || profileQ.isFetching;

  const mediaQ = useQuery({
    queryKey: ["profile-shared-media", myId, p?.authUserId],
    enabled: Boolean(myId && p?.authUserId && !p.isMe),
    staleTime: 60_000,
    queryFn: async () => {
      if (!myId || !p) return { count: 0, thumbs: [] as string[], conversationId: null as string | null };
      try {
        const schoolId = p.schoolId || session?.schoolId || "";
        const convId = await getOrCreateDirectConversation(myId, p.authUserId, schoolId);
        const msgs = await listMessages(convId, 200);
        const media = (msgs || []).filter(
          (m: { attachment_url?: string | null; attachment_type?: string | null }) =>
            m.attachment_url &&
            (m.attachment_type === "image" ||
              m.attachment_type === "video" ||
              m.attachment_type === "file" ||
              m.attachment_type === "audio" ||
              /\.(jpg|jpeg|png|gif|webp|mp4|pdf|doc)/i.test(m.attachment_url || "")),
        );
        const thumbs = media
          .filter(
            (m: { attachment_url?: string | null; attachment_type?: string | null }) =>
              m.attachment_type === "image" ||
              /\.(jpg|jpeg|png|gif|webp)/i.test(m.attachment_url || ""),
          )
          .map((m: { attachment_url?: string | null }) => m.attachment_url as string)
          .slice(0, 4);
        const calls = (msgs || []).filter(
          (m: { attachment_type?: string | null; body?: string | null }) =>
            (m.attachment_type || "").toLowerCase() === "call" ||
            /missed|voice call|video call|no answer|declined/i.test(m.body || ""),
        );
        return {
          count: media.length,
          thumbs,
          conversationId: convId,
          media: media.map((m: any) => ({
            id: m.id,
            url: m.attachment_url as string,
            type: (m.attachment_type || "file") as string,
            body: m.body as string | null,
            created_at: m.created_at as string,
            sender_id: m.sender_id as string,
          })),
          calls: calls.map((m: any) => ({
            id: m.id,
            body: (m.body || "Call") as string,
            created_at: m.created_at as string,
            sender_id: m.sender_id as string,
          })),
        };
      } catch {
        return {
          count: 0,
          thumbs: [] as string[],
          conversationId: null,
          media: [] as { id: string; url: string; type: string; body: string | null; created_at: string; sender_id: string }[],
          calls: [] as { id: string; body: string; created_at: string; sender_id: string }[],
        };
      }
    },
  });

  const groupsQ = useQuery({
    queryKey: ["profile-common-groups", myId, p?.authUserId],
    enabled: Boolean(myId && p?.authUserId && !p.isMe),
    staleTime: 60_000,
    queryFn: async () => {
      if (!myId || !p) return [];
      try {
        const { data: mine } = await supabase
          .from("conversation_members")
          .select("conversation_id")
          .eq("user_id", myId)
          .is("left_at", null);
        const myIds = (mine || []).map((r) => r.conversation_id as string);
        if (!myIds.length) return [];
        const { data: theirs } = await supabase
          .from("conversation_members")
          .select("conversation_id")
          .eq("user_id", p.authUserId)
          .in("conversation_id", myIds)
          .is("left_at", null);
        const shared = [...new Set((theirs || []).map((r) => r.conversation_id as string))];
        if (!shared.length) return [];
        const { data: groups } = await supabase
          .from("conversations")
          .select("id, title, type, avatar_url")
          .in("id", shared)
          .eq("type", "group")
          .limit(8);
        return groups || [];
      } catch {
        return [];
      }
    },
  });

  const deptLevel = useMemo(
    () => [p?.departmentName, p?.levelName].filter(Boolean).join(" · "),
    [p?.departmentName, p?.levelName],
  );

  const goMessage = async () => {
    if (!myId || !p || p.isMe) return;
    if (!isOnlineNow()) {
      toast.error("Connect to the internet to message");
      return;
    }
    setBusy("msg");
    try {
      const schoolId = p.schoolId || session?.schoolId || "";
      const id = await getOrCreateDirectConversation(myId, p.authUserId, schoolId);
      appNavigate(`/student/messages?chat=${encodeURIComponent(id)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open chat");
    } finally {
      setBusy(null);
    }
  };

  const startCall = async (callType: "voice" | "video") => {
    if (!myId || !p || p.isMe) return;
    if (!isOnlineNow()) {
      toast.error("Internet is required for calls");
      return;
    }
    setBusy(callType);
    try {
      const callId = await startDirectCall({
        calleeId: p.authUserId,
        callType,
      });
      onStartCall?.({
        callId,
        callType,
        peerId: p.authUserId,
        peerName: p.fullName,
        peerAvatar: p.avatarUrl,
        peerMatric: p.matricNumber,
        isCaller: true,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start call");
    } finally {
      setBusy(null);
    }
  };

  const toggleBlock = async () => {
    if (!myId || !p || p.isMe) return;
    setBusy("block");
    try {
      if (p.isBlockedByMe) {
        await unblockUser(myId, p.authUserId);
        toast.success("User unblocked");
      } else {
        await blockUser(myId, p.authUserId);
        toast.success("User blocked");
      }
      void qc.invalidateQueries({ queryKey: ["public-profile", userId] });
      setMoreOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const onToggleFav = () => {
    if (!myId || !userId || !p || p.isMe) return;
    const next = toggleFavorite(myId, userId);
    setFav(next);
    toast.success(next ? "Added to favorites" : "Removed from favorites");
    setMoreOpen(false);
  };

  if (loading && !p) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 bg-gradient-to-b from-[#0b1b3a] to-[#1a3a6e]">
        <Loader2 className="h-9 w-9 animate-spin text-white" />
        <p className="text-sm font-medium text-white/70">Loading profile…</p>
      </div>
    );
  }

  if (!p) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 bg-gradient-to-b from-[#0b1b3a] to-[#122a52] px-6 text-center text-white">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-white/10 text-2xl font-bold">?</div>
        <div>
          <p className="text-lg font-bold">Profile not found</p>
          <p className="mt-1 text-sm text-white/60">
            This user may be offline or not in your school.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold backdrop-blur"
        >
          Go back
        </button>
      </div>
    );
  }

  const mediaCount = mediaQ.data?.count ?? 0;
  const thumbs = mediaQ.data?.thumbs ?? [];
  const groups = groupsQ.data || [];

  return (
    <div className="fixed inset-0 z-[90] overflow-y-auto overflow-x-hidden bg-[#0b1b3a] text-white">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 50% 20%, rgba(59,130,246,0.45), transparent 55%)",
        }}
      />

      <div className="relative z-10 flex items-center justify-between px-3 pb-1 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onBack}
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 active:scale-95"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <p className="text-sm font-semibold tracking-wide text-white/90">Profile</p>
        {p.isMe ? (
          <span className="h-10 w-10" aria-hidden />
        ) : (
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            className="grid h-10 w-10 place-items-center rounded-full bg-white/10 active:scale-95"
            aria-label="More"
          >
            <MoreVertical className="h-5 w-5" />
          </button>
        )}
      </div>

      {moreOpen && !p.isMe ? (
        <div className="absolute right-3 top-14 z-20 min-w-[13rem] overflow-hidden rounded-xl border border-white/10 bg-[#122a52] py-1 shadow-xl">
          <MoreItem label={fav ? "Remove from Favorites" : "Add to Favorites"} onClick={onToggleFav} />
          <MoreItem label="Message" onClick={() => void goMessage()} />
          <MoreItem label="Voice Call" onClick={() => void startCall("voice")} />
          <MoreItem label="Video Call" onClick={() => void startCall("video")} />
          <MoreItem
            label={p.isBlockedByMe ? "Unblock User" : "Block User"}
            danger
            onClick={() => void toggleBlock()}
          />
          <MoreItem
            label="Report User"
            danger
            onClick={() => {
              setMoreOpen(false);
              setReportText("");
              setReportOpen(true);
            }}
          />
        </div>
      ) : null}

      <div className="relative z-10 mx-auto max-w-lg px-4 pb-24">
        <div className="flex flex-col items-center pt-4">
          <div className="relative">
            <button
              type="button"
              onClick={() => setPhotoOpen(true)}
              className="relative"
              aria-label="View photo"
            >
              <span className="relative grid h-28 w-28 place-items-center overflow-hidden rounded-full bg-[#1e3a5f] ring-[3px] ring-[#3b82f6]/90">
                {p.avatarUrl ? (
                  <img src={p.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-4xl font-extrabold text-[#93c5fd]">{initials(p.fullName)}</span>
                )}
              </span>
            </button>
            {p.isMe && session?.profileId ? (
              <label className="absolute bottom-0 right-0 grid h-9 w-9 cursor-pointer place-items-center rounded-full bg-[#2563eb] text-white shadow-lg ring-2 ring-[#0b1b3a] active:scale-95">
                {busy === "photo" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <span className="text-xl font-bold leading-none">+</span>
                )}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f || !session.profileId) return;
                    if (f.size > 3 * 1024 * 1024) {
                      toast.error("Image must be 3 MB or smaller.");
                      return;
                    }
                    if (!f.type.startsWith("image/")) {
                      toast.error("Please choose an image file.");
                      return;
                    }
                    setBusy("photo");
                    void updateMyProfilePhoto(session.profileId, f)
                      .then(() => {
                        toast.success("Profile photo updated");
                        void qc.invalidateQueries({ queryKey: ["public-profile", userId] });
                        void qc.invalidateQueries({ queryKey: ["session-user"] });
                      })
                      .catch((err) => toast.error(err instanceof Error ? err.message : "Upload failed"))
                      .finally(() => setBusy(null));
                  }}
                />
              </label>
            ) : null}
          </div>
          {p.isMe ? (
            <p className="mt-2 text-xs font-medium text-white/45">
              {p.avatarUrl ? "Tap + to change photo" : "Tap + to add a profile photo"}
            </p>
          ) : null}

          <h1 className="mt-3 text-center text-2xl font-bold tracking-tight">{p.fullName}</h1>
          {p.matricNumber ? (
            <p className="mt-1 text-sm font-medium text-white/55">{p.matricNumber}</p>
          ) : null}
          {deptLevel ? (
            <p className="mt-0.5 text-center text-xs font-medium text-white/45">{deptLevel}</p>
          ) : null}
          {/* Online badge only when presence confirms — omitted by default */}
          {groupContext?.name ? (
            <p className="mt-2 text-[11px] text-white/40">From group · {groupContext.name}</p>
          ) : null}
        </div>

        {!p.isMe ? (
          <div className="mt-5 grid grid-cols-4 gap-2">
            <ActionBtn icon={<MessageCircle className="h-5 w-5" />} label="Message" tone="blue" busy={busy === "msg"} onClick={() => void goMessage()} />
            <ActionBtn icon={<Phone className="h-5 w-5" />} label="Voice Call" tone="green" busy={busy === "voice"} onClick={() => void startCall("voice")} />
            <ActionBtn icon={<Video className="h-5 w-5" />} label="Video Call" tone="blue" busy={busy === "video"} onClick={() => void startCall("video")} />
            <ActionBtn icon={<MoreVertical className="h-5 w-5" />} label="More" tone="navy" onClick={() => setMoreOpen((v) => !v)} />
          </div>
        ) : null}

        <section className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06]">
          <InfoRow icon={<Building2 className="h-4 w-4" />} label="Department" value={p.departmentName || "Not set"} />
          <InfoRow icon={<GraduationCap className="h-4 w-4" />} label="Level" value={p.levelName || "Not set"} />
          <InfoRow icon={<Building2 className="h-4 w-4" />} label="School" value={p.schoolName || session?.schoolName || "Not set"} />
          <InfoRow icon={<Hash className="h-4 w-4" />} label="Matric Number" value={p.matricNumber || "Not set"} last />
        </section>

        <section className="mt-3 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-white/45">
              <Users className="h-3.5 w-3.5" />
              About
            </div>
            {p.isMe && session?.profileId ? (
              <button
                type="button"
                className="text-[11px] font-bold text-[#60a5fa]"
                onClick={() => {
                  setBioDraft(p.bio || "");
                  setBioEditOpen(true);
                }}
              >
                Edit
              </button>
            ) : null}
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-white/75 whitespace-pre-wrap">
            {p.bio
              ? p.bio
              : p.departmentName && p.levelName
                ? `${p.fullName.split(" ")[0]} studies ${p.departmentName} · ${p.levelName}.`
                : p.departmentName
                  ? `${p.fullName.split(" ")[0]} is in ${p.departmentName}.`
                  : p.matricNumber
                    ? `Matric number ${p.matricNumber}.`
                    : p.isMe
                      ? "Add a short bio so classmates can know you better."
                      : "No bio added yet."}
          </p>
        </section>

        <button
          type="button"
          onClick={() => {
            setMediaViewIndex(0);
            setMediaSheetOpen(true);
          }}
          className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-left active:bg-white/10"
        >
          <ImageIcon className="h-5 w-5 shrink-0 text-[#60a5fa]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white/90">Media, Links and Files</p>
            <p className="text-xs text-white/45">{mediaCount} items</p>
            {thumbs.length > 0 ? (
              <div className="mt-2 flex gap-1.5">
                {thumbs.map((u) => (
                  <img key={u} src={u} alt="" className="h-10 w-10 rounded-lg object-cover ring-1 ring-white/10" />
                ))}
                {mediaCount > thumbs.length ? (
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-white/10 text-[10px] font-bold text-white/70">
                    +{mediaCount - thumbs.length}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-white/35" />
        </button>

        {!p.isMe ? (
        <section className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06]">
          <div className="flex items-center gap-2 px-4 py-3">
            <UsersRound className="h-4 w-4 text-[#60a5fa]" />
            <p className="text-sm font-semibold text-white/90">Groups in Common</p>
            <span className="ml-auto text-xs text-white/40">{groups.length}</span>
          </div>
          {groups.length === 0 ? (
            <p className="border-t border-white/5 px-4 py-3 text-xs text-white/40">No groups in common yet</p>
          ) : (
            groups.map((g) => (
              <button
                key={g.id as string}
                type="button"
                onClick={() => appNavigate(`/student/messages?chat=${encodeURIComponent(g.id as string)}`)}
                className="flex w-full items-center gap-3 border-t border-white/5 px-4 py-3 text-left active:bg-white/5"
              >
                <span className="grid h-9 w-9 place-items-center rounded-full bg-[#2563eb]/25 text-xs font-bold text-[#93c5fd]">
                  {((g.title as string) || "G").slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-white/85">
                  {(g.title as string) || "Group"}
                </span>
                <ChevronRight className="h-4 w-4 text-white/30" />
              </button>
            ))
          )}
        </section>
        ) : null}

        <section className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06]">
          <ListRow icon={<Phone className="h-4 w-4 text-[#60a5fa]" />} title="Call History" subtitle="Recent voice & video with this person" onClick={() => setCallHistOpen(true)} />
          <ListRow icon={<Bell className="h-4 w-4 text-[#60a5fa]" />} title="Notifications" subtitle="Default" last onClick={() => toast.message("Mute this chat from the conversation menu")} />
        </section>

        {!p.isMe ? (
          <section className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.06]">
            <ListRow icon={<Heart className={cn("h-4 w-4", fav ? "text-rose-400" : "text-white/60")} />} title={fav ? "Remove from Favorites" : "Add to Favorites"} onClick={onToggleFav} />
            <ListRow icon={<Ban className="h-4 w-4 text-rose-400" />} title={p.isBlockedByMe ? "Unblock User" : "Block User"} danger onClick={() => void toggleBlock()} />
            <ListRow icon={<Flag className="h-4 w-4 text-rose-400" />} title="Report User" danger last onClick={() => { setReportText(""); setReportOpen(true); }} />
          </section>
        ) : null}
      </div>


      {mediaSheetOpen ? (
        <div className="fixed inset-0 z-[80] flex flex-col bg-[#0b1b3a]">
          <div className="flex items-center gap-3 border-b border-white/10 px-3 py-3">
            <button type="button" onClick={() => setMediaSheetOpen(false)} className="grid h-10 w-10 place-items-center rounded-full bg-white/10" aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white">Media, links & files</p>
              <p className="text-[11px] text-white/45">{mediaQ.data?.count || 0} items with {p.fullName.split(" ")[0]}</p>
            </div>
          </div>
          {(mediaQ.data?.media || []).length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <ImageIcon className="h-10 w-10 text-white/30" />
              <p className="text-sm text-white/50">No shared media yet</p>
            </div>
          ) : (
            <div className="grid flex-1 grid-cols-3 gap-0.5 overflow-y-auto p-0.5 content-start">
              {(mediaQ.data?.media || []).map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  className="relative aspect-square bg-white/5"
                  onClick={() => setMediaViewIndex(idx)}
                >
                  {item.type === "image" || /\.(jpg|jpeg|png|gif|webp)/i.test(item.url) ? (
                    <img src={item.url} alt="" className="h-full w-full object-cover" />
                  ) : item.type === "video" || /\.mp4/i.test(item.url) ? (
                    <div className="grid h-full place-items-center text-2xl">🎬</div>
                  ) : item.type === "audio" ? (
                    <div className="grid h-full place-items-center text-2xl">🎤</div>
                  ) : (
                    <div className="grid h-full place-items-center text-2xl">📄</div>
                  )}
                </button>
              ))}
            </div>
          )}
          {/* Fullscreen viewer with swipe */}
          {(mediaQ.data?.media || []).length > 0 && mediaViewIndex >= 0 ? (
            <div
              className="fixed inset-0 z-[85] flex flex-col bg-black"
              onTouchStart={(e) => {
                (e.currentTarget as any)._sx = e.touches[0].clientX;
              }}
              onTouchEnd={(e) => {
                const sx = (e.currentTarget as any)._sx as number | undefined;
                if (sx == null) return;
                const dx = e.changedTouches[0].clientX - sx;
                const list = mediaQ.data?.media || [];
                if (dx < -40 && mediaViewIndex < list.length - 1) setMediaViewIndex((i) => i + 1);
                if (dx > 40 && mediaViewIndex > 0) setMediaViewIndex((i) => i - 1);
              }}
            >
              <div className="flex items-center justify-between px-3 py-3">
                <button type="button" onClick={() => setMediaSheetOpen(false)} className="text-sm font-semibold text-white">Close</button>
                <p className="text-xs text-white/60">{mediaViewIndex + 1} / {(mediaQ.data?.media || []).length}</p>
                <button
                  type="button"
                  className="text-sm font-semibold text-white/80"
                  onClick={() => {
                    const list = mediaQ.data?.media || [];
                    if (mediaViewIndex < list.length - 1) setMediaViewIndex((i) => i + 1);
                  }}
                >
                  Next
                </button>
              </div>
              <div className="flex flex-1 items-center justify-center px-2">
                {(() => {
                  const item = (mediaQ.data?.media || [])[mediaViewIndex];
                  if (!item) return null;
                  if (item.type === "image" || /\.(jpg|jpeg|png|gif|webp)/i.test(item.url)) {
                    return <img src={item.url} alt="" className="max-h-full max-w-full object-contain" />;
                  }
                  if (item.type === "video" || /\.mp4/i.test(item.url)) {
                    return <video src={item.url} controls className="max-h-full max-w-full" />;
                  }
                  if (item.type === "audio") {
                    return <audio src={item.url} controls className="w-full" />;
                  }
                  return (
                    <a href={item.url} target="_blank" rel="noreferrer" className="rounded-xl bg-white/10 px-4 py-3 text-sm font-semibold text-white">
                      Open file
                    </a>
                  );
                })()}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {callHistOpen ? (
        <div className="fixed inset-0 z-[80] flex flex-col bg-[#0b1b3a]">
          <div className="flex items-center gap-3 border-b border-white/10 px-3 py-3">
            <button type="button" onClick={() => setCallHistOpen(false)} className="grid h-10 w-10 place-items-center rounded-full bg-white/10" aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white">Call history</p>
              <p className="text-[11px] text-white/45">With {p.fullName.split(" ")[0]}</p>
            </div>
          </div>
          <div className="flex gap-2 border-b border-white/10 px-3 py-2">
            {(["all", "missed", "declined"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setCallHistTab(tab)}
                className={
                  "rounded-full px-3 py-1.5 text-xs font-bold capitalize " +
                  (callHistTab === tab ? "bg-[#2563eb] text-white" : "bg-white/10 text-white/70")
                }
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {(() => {
              const all = mediaQ.data?.calls || [];
              const filtered = all.filter((c) => {
                if (callHistTab === "missed") return /missed|no answer/i.test(c.body);
                if (callHistTab === "declined") return /declined/i.test(c.body);
                return true;
              });
              if (!filtered.length) {
                return <p className="py-16 text-center text-sm text-white/45">No calls yet</p>;
              }
              return filtered.map((c) => {
                const outgoing = c.sender_id === myId;
                const isMissed = /missed|no answer/i.test(c.body);
                const isDeclined = /declined/i.test(c.body);
                const isVideo = /video/i.test(c.body);
                const dur = c.body.match(/(\d{1,2}:\d{2})/);
                return (
                  <div key={c.id} className="flex items-center gap-3 border-b border-white/5 py-3">
                    <span className={"grid h-11 w-11 place-items-center rounded-full text-lg " + (isMissed || isDeclined ? "bg-rose-500/20 text-rose-400" : "bg-[#2563eb]/20 text-[#60a5fa]")}>
                      {isVideo ? "🎥" : "📞"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={"text-sm font-semibold " + (isMissed ? "text-rose-400" : "text-white")}>
                        {c.body.replace(/^📞\s*/, "")}
                      </p>
                      <p className="text-[11px] text-white/45">
                        {outgoing ? "Outgoing" : "Incoming"}
                        {" · "}
                        {new Date(c.created_at).toLocaleString()}
                        {dur ? ` · ${dur[1]}` : ""}
                      </p>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      ) : null}

      {reportOpen ? (
        <div className="fixed inset-0 z-[80] flex flex-col bg-[#0b1b3a]">
          <div className="flex items-center gap-3 border-b border-white/10 px-3 py-3">
            <button type="button" onClick={() => setReportOpen(false)} className="grid h-10 w-10 place-items-center rounded-full bg-white/10" aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white">Report user</p>
              <p className="text-[11px] text-white/45">Report {p.fullName} to D4EXAM admins</p>
            </div>
            <button
              type="button"
              disabled={busy === "report" || !reportText.trim()}
              onClick={() => {
                if (!myId || !p || !reportText.trim()) return;
                setBusy("report");
                void (async () => {
                  try {
                    const { error } = await supabase.from("notifications").insert({
                      recipient_user_id: null,
                      title: `User report: ${p.fullName}`,
                      message: reportText.trim().slice(0, 2000),
                      type: "user_report",
                      link: `/super-admin`,
                      meta: {
                        reported_user_id: p.authUserId,
                        reported_name: p.fullName,
                        reporter_user_id: myId,
                      },
                    } as never);
                    // Also try a generic reports table if exists
                    try {
                      await supabase.from("user_reports").insert({
                        reporter_id: myId,
                        reported_id: p.authUserId,
                        reason: reportText.trim().slice(0, 2000),
                      } as never);
                    } catch { /* optional table */ }
                    if (error) {
                      // Fallback: notify self confirmation still
                      console.warn(error.message);
                    }
                    toast.success("Report submitted to D4EXAM admins");
                    setReportOpen(false);
                    setReportText("");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Could not submit report");
                  } finally {
                    setBusy(null);
                  }
                })();
              }}
              className="rounded-full bg-rose-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              {busy === "report" ? "Sending…" : "Submit"}
            </button>
          </div>
          <div className="flex-1 px-4 py-4">
            <textarea
              value={reportText}
              onChange={(e) => setReportText(e.target.value.slice(0, 2000))}
              rows={10}
              autoFocus
              placeholder="Describe what happened and why you are reporting this user…"
              className="h-full min-h-[12rem] w-full resize-none rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-[15px] font-medium leading-relaxed text-white outline-none placeholder:text-white/35 focus:ring-2 focus:ring-rose-500/40"
            />
            <p className="mt-2 text-right text-[11px] text-white/40">{reportText.length}/2000</p>
          </div>
        </div>
      ) : null}

      {bioEditOpen ? (
        <div className="fixed inset-0 z-[80] flex flex-col bg-[#0b1b3a]">
          <div className="flex items-center gap-3 border-b border-white/10 px-3 py-3">
            <button
              type="button"
              onClick={() => setBioEditOpen(false)}
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 active:scale-95"
              aria-label="Close"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white">Edit bio</p>
              <p className="text-[11px] text-white/45">D4EXAM · max 280 characters</p>
            </div>
            <button
              type="button"
              disabled={busy === "bio"}
              onClick={() => {
                if (!session?.profileId) return;
                setBusy("bio");
                void updateMyBio(session.profileId, bioDraft)
                  .then(() => {
                    toast.success("Bio updated");
                    setBioEditOpen(false);
                    void qc.invalidateQueries({ queryKey: ["public-profile", userId] });
                  })
                  .catch((err) =>
                    toast.error(err instanceof Error ? err.message : "Could not update bio"),
                  )
                  .finally(() => setBusy(null));
              }}
              className="rounded-full bg-[#2563eb] px-4 py-2 text-xs font-bold text-white disabled:opacity-60"
            >
              {busy === "bio" ? "Saving…" : "Save"}
            </button>
          </div>
          <div className="flex-1 px-4 py-4">
            <textarea
              value={bioDraft}
              onChange={(e) => setBioDraft(e.target.value.slice(0, 280))}
              autoFocus
              rows={8}
              placeholder="Write a short bio about yourself… You can use emojis 😊"
              className="h-full min-h-[12rem] w-full resize-none rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-[15px] font-medium leading-relaxed text-white outline-none placeholder:text-white/35 focus:ring-2 focus:ring-[#2563eb]/40"
            />
            <p className="mt-2 text-right text-[11px] tabular-nums text-white/40">
              {bioDraft.length}/280
            </p>
          </div>
        </div>
      ) : null}

      <ProfilePhotoViewer
        open={photoOpen}
        src={p.avatarUrl}
        name={p.fullName}
        subtitle={[p.matricNumber, deptLevel].filter(Boolean).join(" · ")}
        fallbackInitials={initials(p.fullName)}
        onClose={() => setPhotoOpen(false)}
      />
    </div>
  );
}

function ActionBtn({ icon, label, onClick, busy, tone }: { icon: ReactNode; label: string; onClick: () => void; busy?: boolean; tone: "blue" | "green" | "navy" }) {
  const bg = tone === "green" ? "bg-emerald-500" : tone === "navy" ? "bg-[#1e3a5f]" : "bg-[#2563eb]";
  return (
    <button type="button" onClick={onClick} disabled={busy} className="flex flex-col items-center gap-1.5 active:scale-95 disabled:opacity-60">
      <span className={cn("grid h-12 w-12 place-items-center rounded-2xl text-white shadow-lg", bg)}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      </span>
      <span className="text-[10px] font-semibold text-white/70">{label}</span>
    </button>
  );
}

function InfoRow({ icon, label, value, last }: { icon: ReactNode; label: string; value: string; last?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3", !last && "border-b border-white/5")}>
      <span className="text-white/40">{icon}</span>
      <span className="text-xs font-medium text-white/45">{label}</span>
      <span className="ml-auto max-w-[55%] truncate text-right text-sm font-semibold text-white/90">{value}</span>
    </div>
  );
}

function ListRow({ icon, title, subtitle, onClick, danger, last }: { icon: ReactNode; title: string; subtitle?: string; onClick: () => void; danger?: boolean; last?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-white/5", !last && "border-b border-white/5")}>
      <span className="grid h-8 w-8 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm font-medium", danger ? "text-rose-400" : "text-white/90")}>{title}</span>
        {subtitle ? <span className="mt-0.5 block text-xs text-white/40">{subtitle}</span> : null}
      </span>
      <ChevronRight className="h-4 w-4 text-white/25" />
    </button>
  );
}

function MoreItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn("block w-full px-3 py-2.5 text-left text-sm font-medium active:bg-white/10", danger ? "text-rose-400" : "text-white/90")}>
      {label}
    </button>
  );
}
