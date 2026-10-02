import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Info,
  Loader2,
  MessageCircle,
  MoreVertical,
  Phone,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useSessionUser } from "@/lib/session";
import {
  blockUser,
  fetchPublicProfile,
  unblockUser,
} from "@/lib/user-profile";
import { getOrCreateDirectConversation } from "@/lib/messaging";
import { appNavigate } from "@/lib/app-navigate";
import { startDirectCall } from "@/lib/calls";
import { isOnlineNow } from "@/lib/offline-guard";
import { ProfilePhotoViewer } from "@/components/profile/ProfilePhotoViewer";
import { isFavorite, toggleFavorite } from "@/lib/profile-favorites";

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

/**
 * Centered PROFILE QUICK VIEW modal (not full-screen).
 * Clean dark card — no full-page blur wash.
 */
export function MessagingProfileSheet({
  userId,
  open,
  onClose,
  onStartCall,
  conversationId,
  seedName,
  seedAvatar,
  seedMatric,
  isPeerOnline,
}: {
  userId: string | null;
  open: boolean;
  onClose: () => void;
  conversationId?: string | null;
  seedName?: string | null;
  seedAvatar?: string | null;
  seedMatric?: string | null;
  /** Only show Online when this is true */
  isPeerOnline?: boolean;
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
  const [busy, setBusy] = useState<string | null>(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fav, setFav] = useState(false);

  const profileQ = useQuery({
    queryKey: ["public-profile", userId, myId],
    enabled: Boolean(open && userId && userId.length > 8),
    queryFn: () => fetchPublicProfile(userId!, myId),
    staleTime: 15_000,
    retry: 1,
  });
  const p = profileQ.data;

  useEffect(() => {
    if (!open) {
      setPhotoOpen(false);
      setMenuOpen(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && myId && userId) setFav(isFavorite(myId, userId));
  }, [open, myId, userId]);

  if (!open || !userId) return null;

  const displayName = p?.fullName || seedName || "Student";
  const displayMatric = p?.matricNumber || seedMatric || null;
  const displayAvatar = p?.avatarUrl ?? seedAvatar ?? null;
  const deptLevel = [p?.departmentName, p?.levelName].filter(Boolean).join(" · ");
  const showOnline = Boolean(isPeerOnline);

  const peerId = p?.authUserId || userId || "";
  const peerName = displayName;
  const peerAvatar = displayAvatar;
  const peerMatric = displayMatric;

  const goMessage = async () => {
    if (!myId || !peerId || p?.isMe) {
      onClose();
      return;
    }
    if (!isOnlineNow()) {
      toast.error("Connect to the internet to message");
      return;
    }
    setBusy("msg");
    try {
      const schoolId = p?.schoolId || session?.schoolId || "";
      const id = await getOrCreateDirectConversation(myId, peerId, schoolId);
      onClose();
      appNavigate(`/student/messages?chat=${encodeURIComponent(id)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open chat");
    } finally {
      setBusy(null);
    }
  };

  const startCall = async (callType: "voice" | "video") => {
    if (!myId || !peerId || p?.isMe) return;
    if (!isOnlineNow()) {
      toast.error("Internet is required for calls");
      return;
    }
    setBusy(callType);
    try {
      const callId = await startDirectCall({
        calleeId: peerId,
        callType,
        conversationId: conversationId || null,
      });
      onStartCall?.({
        callId,
        callType,
        peerId,
        peerName,
        peerAvatar,
        peerMatric,
        isCaller: true,
      });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start call");
    } finally {
      setBusy(null);
    }
  };

  const goInfo = () => {
    if (!userId) return;
    onClose();
    appNavigate(`/student/user/${encodeURIComponent(userId)}`);
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
      setMenuOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const onToggleFav = () => {
    if (!myId || !userId || p?.isMe) return;
    const next = toggleFavorite(myId, userId);
    setFav(next);
    toast.success(next ? "Added to favorites" : "Removed from favorites");
    setMenuOpen(false);
  };

  // Synthetic data URL for initials avatar viewer
  const photoSrc = displayAvatar;

  return (
    <>
      {/* Dim overlay only — no heavy blur wash */}
      <div
        className="fixed inset-0 z-[120] flex h-[100dvh] w-screen items-center justify-center bg-black/55 p-4 backdrop-blur-md"
        role="dialog"
        aria-modal="true"
        aria-label="Profile preview"
        onClick={onClose}
      >
        <div
          className={cn(
            "relative mx-auto flex max-h-[min(92dvh,640px)] w-full max-w-[22rem] flex-col overflow-y-auto",
            "rounded-[1.5rem] bg-[#0b1b3a] shadow-2xl ring-1 ring-white/10",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative flex items-center justify-between px-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white active:bg-white/20"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white active:bg-white/20"
              aria-label="More"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </div>

          {menuOpen && !p?.isMe ? (
            <div className="absolute right-3 top-12 z-10 min-w-[11rem] overflow-hidden rounded-xl border border-white/10 bg-[#122a52] py-1 shadow-xl">
              <MenuItem label={fav ? "Remove favorite" : "Add to favorites"} onClick={onToggleFav} />
              <MenuItem label="Message" onClick={() => void goMessage()} />
              <MenuItem
                label={p?.isBlockedByMe ? "Unblock" : "Block"}
                danger
                onClick={() => void toggleBlock()}
              />
              <MenuItem label="View full profile" onClick={goInfo} />
            </div>
          ) : null}

          <div className="relative flex flex-col items-center px-5 pb-6 pt-1">
            {profileQ.isLoading && !p && !seedName ? (
              <div className="flex flex-col items-center gap-3 py-12">
                <Loader2 className="h-8 w-8 animate-spin text-[#60a5fa]" />
                <p className="text-sm text-white/60">Loading profile…</p>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setPhotoOpen(true)}
                  className="relative mt-1"
                  aria-label="View photo"
                >
                  <span className="relative grid h-32 w-32 place-items-center overflow-hidden rounded-full bg-[#1e3a5f] ring-[3px] ring-[#3b82f6]/90">
                    {displayAvatar ? (
                      <img src={displayAvatar} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-3xl font-extrabold text-[#93c5fd]">
                        {initials(displayName)}
                      </span>
                    )}
                  </span>
                  {showOnline ? (
                    <span className="absolute bottom-1 right-1 h-3.5 w-3.5 rounded-full border-2 border-[#0d213f] bg-emerald-400" />
                  ) : null}
                </button>

                <h2 className="mt-4 text-center text-lg font-bold tracking-tight text-white leading-snug">
                  {displayName}
                </h2>
                {displayMatric ? (
                  <p className="mt-1 text-sm font-medium text-white/60">{displayMatric}</p>
                ) : null}
                {deptLevel ? (
                  <p className="mt-0.5 text-center text-xs font-medium text-white/45">{deptLevel}</p>
                ) : null}

                {showOnline ? (
                  <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    Online
                  </span>
                ) : null}

                {!p?.isMe ? (
                  <div className="mt-5 grid w-full grid-cols-4 gap-2">
                    <QuickAction
                      icon={<MessageCircle className="h-5 w-5" />}
                      label="Message"
                      tone="blue"
                      busy={busy === "msg"}
                      onClick={() => void goMessage()}
                    />
                    <QuickAction
                      icon={<Phone className="h-5 w-5" />}
                      label="Voice Call"
                      tone="green"
                      busy={busy === "voice"}
                      onClick={() => void startCall("voice")}
                    />
                    <QuickAction
                      icon={<Video className="h-5 w-5" />}
                      label="Video Call"
                      tone="blue"
                      busy={busy === "video"}
                      onClick={() => void startCall("video")}
                    />
                    <QuickAction
                      icon={<Info className="h-5 w-5" />}
                      label="Info"
                      tone="navy"
                      onClick={goInfo}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={goInfo}
                    className="mt-4 rounded-full bg-[#2563eb] px-5 py-2 text-sm font-semibold text-white"
                  >
                    Open my profile
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <ProfilePhotoViewer
        open={photoOpen}
        src={photoSrc}
        name={displayName}
        subtitle={[displayMatric, deptLevel].filter(Boolean).join(" · ") || undefined}
        fallbackInitials={initials(displayName)}
        onClose={() => setPhotoOpen(false)}
      />
    </>
  );
}

function QuickAction({
  icon,
  label,
  onClick,
  busy,
  tone,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  busy?: boolean;
  tone: "blue" | "green" | "navy";
}) {
  const bg =
    tone === "green"
      ? "bg-emerald-500 text-white"
      : tone === "navy"
        ? "bg-[#1e3a5f] text-white"
        : "bg-[#2563eb] text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex flex-col items-center gap-1.5 active:scale-95 disabled:opacity-60"
    >
      <span className={cn("grid h-12 w-12 place-items-center rounded-2xl shadow-lg", bg)}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      </span>
      <span className="text-[10px] font-semibold leading-tight text-white/75">{label}</span>
    </button>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "block w-full px-3 py-2.5 text-left text-sm font-medium active:bg-white/10",
        danger ? "text-rose-400" : "text-white/90",
      )}
    >
      {label}
    </button>
  );
}
