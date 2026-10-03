/**
 * D4EXAM Messages hub — student campus messaging
 * Visual reference: Chats | Groups | Students | Officers + quick actions
 * Bottom nav is hidden via AppShell immersiveMessaging.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { appNavigate } from "@/lib/app-navigate";
import { ConversationChat } from "./student.messages.$conversationId";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Users,
  User,
  UserPlus,
  Shield,
  GraduationCap,
  MessageSquare,
  MessagesSquare,
  MoreVertical,
  Check,
  CheckCheck,
  Play,
  UsersRound,
  ArrowLeft,
  PenLine,
  Mic,
  Bell,
  Reply,
  CornerUpRight,
} from "lucide-react";
import { useSessionUser } from "@/lib/session";
import { useStudentContext } from "@/lib/student";
import { cn } from "@/lib/utils";
import {
  discoverStudents,
  listMyConversations,
  getOrCreateDirectConversation,
  createGroup,
  listDepartmentOfficers,
  resolveMySchoolId,
  type ConversationListItem,
  type StudentDiscover,
  type GroupKind,
} from "@/lib/messaging";
import { toast } from "sonner";
import { openUserProfile, D4_OPEN_PROFILE_EVENT } from "@/components/profile/ClickableUser";
import { MessagingProfileSheet } from "@/components/profile/MessagingProfileSheet";
import { CallOverlay, MinimizedCallBubble, type ActiveCall } from "@/components/calls/CallOverlay";

export const Route = createFileRoute("/student/messages")({
  ssr: false,
  head: () => ({ meta: [{ title: "Messages — D4EXAM" }] }),
  component: MessagesHub,
  errorComponent: function MessagesRouteError({ error, reset }) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-[#e0f2fe] px-6 text-center">
        <p className="text-lg font-bold text-slate-900">Messages could not load</p>
        <p className="max-w-sm text-sm text-slate-600">
          {(error as Error)?.message || "Something went wrong opening Messages."}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-full bg-[#2563eb] px-5 py-2.5 text-sm font-semibold text-white"
        >
          Try again
        </button>
        <a href="/student" className="text-sm font-semibold text-[#2563eb]">
          Back to home
        </a>
      </div>
    );
  },
});

type TabKey = "chats" | "groups" | "students" | "officers";

function formatListTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (
    d.getFullYear() === yest.getFullYear() &&
    d.getMonth() === yest.getMonth() &&
    d.getDate() === yest.getDate()
  ) {
    return "Yesterday";
  }
  return d.toLocaleDateString([], { weekday: "short" });
}

function Avatar({
  name,
  url,
  group,
  onOpenProfile,
}: {
  name: string;
  url?: string | null;
  group?: boolean;
  onOpenProfile?: () => void;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

  const inner = url ? (
    <span className="relative grid h-12 w-12 shrink-0 place-items-center">
      <img
        src={url}
        alt=""
        className="h-12 w-12 rounded-full object-cover shadow-md ring-2 ring-[#2563eb]/40 ring-offset-2 ring-offset-[#e8f4fc] transition hover:ring-[#2563eb]/70"
      />
    </span>
  ) : (
    <div
      className={cn(
        "grid h-12 w-12 shrink-0 place-items-center rounded-full text-sm font-bold text-white shadow-md ring-2 ring-white/90 ring-offset-2 ring-offset-[#e8f4fc] transition hover:scale-105",
        group
          ? "bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8]"
          : "bg-gradient-to-br from-[#0b1b3a] to-[#1e3a5f]",
      )}
    >
      {group ? <UsersRound className="h-5 w-5" /> : initials}
    </div>
  );

  if (onOpenProfile) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenProfile();
        }}
        className="shrink-0"
        aria-label={`Open ${name} profile`}
      >
        {inner}
      </button>
    );
  }
  return inner;
}

function MessagesHub() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: session } = useSessionUser();
  const { data: student } = useStudentContext();
  const userId = session?.userId || "";
  const [profileSheetUserId, setProfileSheetUserId] = useState<string | null>(null);
  const [profileSheetSeed, setProfileSheetSeed] = useState<{
    name?: string | null;
    avatar?: string | null;
    matric?: string | null;
  }>({});
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<{ userId?: string }>).detail;
      if (detail?.userId) setProfileSheetUserId(detail.userId);
    };
    window.addEventListener(D4_OPEN_PROFILE_EVENT, onOpen);
    return () => window.removeEventListener(D4_OPEN_PROFILE_EVENT, onOpen);
  }, []);
  const schoolIdHint =
    student?.schoolId || session?.schoolId || "";
  const schoolQ = useQuery({
    queryKey: ["my-school-id", session?.userId, schoolIdHint],
    enabled: Boolean(session?.userId),
    staleTime: 60_000,
    queryFn: () => resolveMySchoolId(schoolIdHint || null),
  });
  const schoolId = schoolQ.data || schoolIdHint || "";

  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("chats");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [deptOpen, setDeptOpen] = useState(false);
  const [fabHidden, setFabHidden] = useState(false);
  const fabTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const hide = () => {
      setFabHidden(true);
      if (fabTimer.current) clearTimeout(fabTimer.current);
    };
    const showLater = () => {
      if (fabTimer.current) clearTimeout(fabTimer.current);
      fabTimer.current = setTimeout(() => setFabHidden(false), 700);
    };
    const onScroll = () => { hide(); showLater(); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("touchstart", hide, { passive: true });
    window.addEventListener("touchend", showLater, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("touchstart", hide);
      window.removeEventListener("touchend", showLater);
      if (fabTimer.current) clearTimeout(fabTimer.current);
    };
  }, []);

  const convQuery = useQuery({
    queryKey: ["campus-conversations", userId],
    enabled: Boolean(userId),
    staleTime: 15_000,
    queryFn: () => listMyConversations(userId),
  });

  const studentsQuery = useQuery({
    queryKey: [
      "campus-discover",
      schoolId,
      search,
      deptOpen,
      tab === "students" || findOpen || deptOpen,
    ],
    enabled: Boolean(userId) && (tab === "students" || findOpen || deptOpen),
    staleTime: 30_000,
    queryFn: () =>
      discoverStudents({
        schoolId: schoolId || schoolIdHint || "",
        query: search,
        departmentId: deptOpen ? student?.departmentId || null : null,
        excludeUserId: userId,
        limit: 60,
      }),
  });

  const officersQuery = useQuery({
    queryKey: ["campus-officers", schoolId],
    enabled: Boolean(userId) && tab === "officers",
    staleTime: 60_000,
    queryFn: () => listDepartmentOfficers(schoolId || schoolIdHint || ""),
  });

  const conversations = convQuery.data || [];
  const groups = conversations.filter((c) => c.isGroup);
  // Chats tab = every conversation (students, officers, groups)
  const allChats = conversations;

  const filteredChats = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = tab === "groups" ? groups : allChats;
    if (!q) return list;
    return list.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.preview.toLowerCase().includes(q) ||
        (c.subtitle || "").toLowerCase().includes(q),
    );
  }, [allChats, groups, search, tab]);

  const openConversation = useCallback(
    (id: string) => {
      if (!id) return;
      // Inline chat view — works even when route matching fails on APK
      setActiveChatId(id);
      const path = `/student/messages/${id}`;
      try {
        appNavigate(path);
      } catch {
        /* ignore */
      }
      try {
        void navigate({
          to: "/student/messages/$conversationId",
          params: { conversationId: id },
        });
      } catch {
        /* ignore */
      }
    },
    [navigate],
  );

  const startDirect = useCallback(
    async (peer: StudentDiscover) => {
      if (!peer.auth_user_id || !userId) {
        toast.error("Cannot start chat — student account not linked yet");
        return;
      }
      try {
        const sid = schoolId || schoolIdHint || "";
        const cid = await getOrCreateDirectConversation(
          userId,
          peer.auth_user_id,
          sid,
        );
        void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
        openConversation(cid);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not open chat");
      }
    },
    [userId, schoolId, navigate, qc],
  );

  const openOfficer = useCallback(() => {
    setTab("officers");
    setSearch("");
  }, []);

  // Session still resolving — show shell so route never looks "broken"
  if (!userId) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#e0f2fe] px-6">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-[#2563eb] border-t-transparent" />
        <p className="text-sm font-semibold text-slate-600">Loading messages…</p>
      </div>
    );
  }

  if (activeChatId) {
    return (
      <ConversationChat
        conversationId={activeChatId}
        onBack={() => {
          setActiveChatId(null);
          try {
            appNavigate("/student/messages");
          } catch {
            /* ignore */
          }
        }}
      />
    );
  }

  return (
    <div className="relative flex h-dvh min-h-0 flex-col"
      style={{ background: "linear-gradient(180deg, #e0f2fe 0%, #f0f9ff 45%, #e0f2fe 100%)" }}>
      {/* Brand watermark — centered, same motion as officer chat */}
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
      {/* Navy header */}
      <header
        className="relative z-10 shrink-0 bg-[#0b1b3a] text-white"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="flex items-center gap-2 px-3 pb-3 pt-2.5 sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={() => navigate({ to: "/student" })}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/10 active:bg-white/15"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] shadow-lg shadow-blue-900/40 ring-2 ring-white/25">
            <MessageSquare className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-black tracking-tight sm:text-xl">D4<span className="text-[#60a5fa]">Chat</span></h1>
            <p className="text-[10px] text-white/70 sm:text-[11px]">
              Campus messages · groups · officers
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => appNavigate("/student/notifications")}
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition active:scale-95"
              aria-label="Notifications"
            >
              <Bell className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (userId) appNavigate(`/student/user/${encodeURIComponent(userId)}`);
                else appNavigate("/student/user/me");
              }}
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition active:scale-95"
              aria-label="My profile"
            >
              <User className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Tabs */}
        <div className="shrink-0 px-3 pt-3">
          <div className="flex gap-1 rounded-2xl bg-slate-100/90 p-1">
            {(
              [
                ["chats", "Chats", MessageSquare],
                ["groups", "Groups", Users],
                ["students", "Students", User],
                ["officers", "Officers", Shield],
              ] as const
            ).map(([key, label, Icon]) => {
              const active = tab === key;
              const badge =
                key === "chats"
                  ? allChats.reduce((n, c) => n + c.unread, 0)
                  : key === "groups"
                    ? groups.reduce((n, c) => n + c.unread, 0)
                    : 0;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={cn(
                    "relative flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2.5 text-xs font-semibold transition",
                    active
                      ? "bg-[#2563eb] text-white shadow-sm"
                      : "text-slate-600 hover:bg-white/80",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{label}</span>
                  {badge > 0 ? (
                    <span
                      className={cn(
                        "ml-0.5 min-w-[1.15rem] rounded-full px-1.5 text-center text-[10px] font-bold leading-4",
                        active
                          ? "bg-white text-[#2563eb]"
                          : "bg-[#2563eb] text-white",
                      )}
                    >
                      {badge > 99 ? "99+" : badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Search */}
        <div className="shrink-0 px-3 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              id="msg-global-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people, groups or messages..."
              className="h-11 w-full rounded-2xl border border-slate-200 bg-white pl-10 pr-3 text-sm text-slate-800 shadow-sm outline-none ring-[#2563eb]/30 placeholder:text-slate-400 focus:ring-2"
            />
          </div>
        </div>

        {/* Quick action cards — slim on mobile */}
        <div className="shrink-0 px-2.5 pt-2.5 sm:px-3 sm:pt-3">
          <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
            <QuickCard
              icon={<Users className="h-5 w-5 text-[#2563eb]" strokeWidth={2} />}
              title="Create Group"
              shortTitle="Create Group"
              subtitle="Study · Discuss · Grow"
              onClick={() => setCreateOpen(true)}
            />
            <QuickCard
              icon={<UserPlus className="h-5 w-5 text-[#2563eb]" strokeWidth={2} />}
              title="Find Students"
              shortTitle="Find Students"
              subtitle="Connect with peers"
              onClick={() => {
                setTab("students");
                setFindOpen(true);
              }}
            />
            <QuickCard
              icon={<Shield className="h-5 w-5 text-[#2563eb]" strokeWidth={2} />}
              title="Department Officers"
              shortTitle="Officer"
              subtitle="Get help & support"
              onClick={openOfficer}
            />
            <QuickCard
              icon={<GraduationCap className="h-5 w-5 text-[#2563eb]" strokeWidth={2} />}
              title="My Department"
              shortTitle="My Department"
              subtitle="View all members"
              onClick={() => {
                setTab("students");
                setDeptOpen(true);
                setSearch("");
              }}
            />
          </div>
        </div>

        {/* List body */}
        <div className="relative z-10 mt-2 min-h-0 flex-1 overflow-y-auto bg-transparent pb-20 sm:mt-3">
          {(tab === "chats" || tab === "groups") && (
            <ConversationList
              items={filteredChats}
              loading={convQuery.isLoading}
              error={
                convQuery.isError
                  ? (convQuery.error as Error)?.message || "Could not load conversations"
                  : null
              }
              emptyLabel={
                tab === "groups"
                  ? "No groups yet — create one to study together"
                  : "No conversations yet"
              }
              onOpen={openConversation}
              onEmptyAction={() => {
                if (tab === "groups") setCreateOpen(true);
                else setTab("students");
              }}
              emptyActionLabel={
                tab === "groups" ? "Create a group" : "Message a student"
              }
              onRetry={() => void convQuery.refetch()}
            />
          )}

          {tab === "students" && (
            <StudentDirectory
              students={studentsQuery.data || []}
              loading={studentsQuery.isLoading}
              error={
                studentsQuery.isError
                  ? (studentsQuery.error as Error)?.message || "Could not load people"
                  : null
              }
              departmentOnly={deptOpen}
              departmentName={student?.departmentName || "My Department"}
              onMessage={startDirect}
              onCloseDept={() => setDeptOpen(false)}
              onRetry={() => void studentsQuery.refetch()}
            />
          )}

          {tab === "officers" && (
            <div className="space-y-2 px-3 py-3">
              {officersQuery.isLoading ? (
                <div className="px-2 py-8 text-center text-sm text-slate-500">Loading officers…</div>
              ) : (officersQuery.data || []).length === 0 ? (
                <div className="rounded-2xl border border-slate-100 bg-white px-4 py-10 text-center text-sm text-slate-500 shadow-sm">
                  <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-[#eff6ff] text-[#2563eb]">
                    <Shield className="h-6 w-6" />
                  </div>
                  <p className="font-semibold text-slate-700">No officers listed yet</p>
                  <p className="mt-1 text-xs">
                    Officers appear here when their account is linked to your school.
                  </p>
                </div>
              ) : (
                (officersQuery.data || []).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={async () => {
                      if (!userId) {
                        toast.error("Sign in required");
                        return;
                      }
                      try {
                        const cid = await getOrCreateDirectConversation(
                          userId,
                          o.id,
                          schoolId || schoolIdHint || "",
                        );
                        void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
                        openConversation(cid);
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Could not open chat");
                      }
                    }}
                    className="flex w-full items-center gap-3 rounded-2xl border border-blue-100 bg-gradient-to-r from-[#eff6ff] to-white px-3 py-3 text-left shadow-sm transition hover:border-[#2563eb]/40 active:scale-[0.99]"
                  >
                    <Avatar name={o.full_name} url={o.avatar_url} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-900">
                        {o.full_name}
                      </p>
                      <p className="text-xs text-slate-500">{o.roleLabel}</p>
                    </div>
                    <span className="rounded-full bg-[#eff6ff] px-2 py-1 text-[10px] font-bold text-[#2563eb]">
                      Message
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {createOpen && (
        <CreateGroupModal
          schoolId={schoolId}
          userId={userId}
          myDepartmentId={student?.departmentId || null}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
            openConversation(id);
          }}
        />
      )}

      {/* Floating compose pen — writing motion; fades while scrolling */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFabHidden(false);
          setTab("students");
          setFindOpen(true);
          // scroll to students list area
          window.setTimeout(() => {
            const el = document.getElementById("msg-global-search");
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
            el?.focus();
          }, 50);
        }}
        className={cn(
          "fixed bottom-6 right-5 z-[60] grid h-[3.25rem] w-[3.25rem] place-items-center rounded-full bg-[#2563eb] text-white shadow-xl shadow-blue-500/35 sm:bottom-8 sm:right-8 sm:h-14 sm:w-14",
          "ring-4 ring-blue-400/30 transition-all duration-300 ease-out d4-fab-float cursor-pointer",
          fabHidden
            ? "pointer-events-none translate-y-4 scale-90 opacity-0"
            : "pointer-events-auto translate-y-0 scale-100 opacity-100",
        )}
        style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}
        aria-label="New message"
      >
        <style>{`@keyframes d4FabFloat{0%,100%{box-shadow:0 10px 25px rgba(37,99,235,.35)}50%{box-shadow:0 14px 32px rgba(37,99,235,.55)}}.d4-fab-float{animation:d4FabFloat 2.4s ease-in-out infinite}`}</style>

        <PenLine
          className="h-[1.35rem] w-[1.35rem] sm:h-6 sm:w-6 "
          strokeWidth={2.25}
        />
      </button>

      <MessagingProfileSheet
        userId={profileSheetUserId}
        open={Boolean(profileSheetUserId)}
        seedName={profileSheetSeed.name}
        seedAvatar={profileSheetSeed.avatar}
        seedMatric={profileSheetSeed.matric}
        onClose={() => setProfileSheetUserId(null)}
        onStartCall={(opts) => setActiveCall(opts)}
      />
      {activeCall && userId ? (
        <CallOverlay
          call={activeCall}
          myUserId={userId}
          onClose={() => setActiveCall(null)}
        />
      ) : null}

      <MinimizedCallBubble />
    </div>
  );
}

function QuickCard({
  icon,
  title,
  shortTitle,
  subtitle,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  shortTitle?: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-2xl border border-slate-200 bg-white px-1.5 py-2.5 text-center shadow-sm transition hover:border-[#2563eb]/35 hover:shadow-md active:scale-[0.98] sm:items-start sm:gap-1.5 sm:p-3 sm:text-left"
    >
      <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#eff6ff] text-[#2563eb] sm:h-11 sm:w-11 [&_svg]:h-5 [&_svg]:w-5 sm:[&_svg]:h-6 sm:[&_svg]:w-6">
        {icon}
      </div>
      <p className="line-clamp-2 text-[11px] font-bold leading-tight text-slate-900 sm:text-[13px]">
        <span className="sm:hidden">{shortTitle || title}</span>
        <span className="hidden sm:inline">{title}</span>
      </p>
      <p className="line-clamp-2 text-[9px] leading-snug text-slate-500 sm:text-[10px]">{subtitle}</p>
    </button>
  );
}

function ConversationList({
  items,
  loading,
  error,
  emptyLabel,
  onOpen,
  onEmptyAction,
  emptyActionLabel,
  onRetry,
}: {
  items: ConversationListItem[];
  loading: boolean;
  error?: string | null;
  emptyLabel: string;
  onOpen: (id: string) => void;
  onEmptyAction?: () => void;
  emptyActionLabel?: string;
  onRetry?: () => void;
}) {
  const { data: session } = useSessionUser();
  const myId = session?.userId || "";
  if (loading) {
    return (
      <div className="space-y-3 px-4 py-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex animate-pulse gap-3">
            <div className="h-12 w-12 rounded-full bg-slate-200" />
            <div className="flex-1 space-y-2 py-1">
              <div className="h-3 w-1/3 rounded bg-slate-200" />
              <div className="h-3 w-2/3 rounded bg-slate-100" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-3 my-6 rounded-2xl border border-red-100 bg-white px-4 py-10 text-center shadow-sm">
        <p className="text-sm font-bold text-slate-800">Could not load conversations</p>
        <p className="mt-1.5 text-xs text-slate-500">{error}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-full bg-[#2563eb] px-4 py-2 text-xs font-semibold text-white"
          >
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="mx-3 my-6 rounded-2xl border border-blue-100 bg-gradient-to-br from-[#eff6ff]/90 to-white/90 px-4 py-10 text-center shadow-sm backdrop-blur-sm">
        <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-[#2563eb]/10 text-[#2563eb]">
          <MessageSquare className="h-7 w-7" />
        </div>
        <p className="text-sm font-bold text-slate-800">{emptyLabel}</p>
        <p className="mt-1.5 text-xs text-slate-500">
          Start a conversation with a classmate, group, or departmental officer.
        </p>
        {onEmptyAction ? (
          <button
            type="button"
            onClick={onEmptyAction}
            className="mt-4 rounded-xl bg-[#2563eb] px-5 py-2.5 text-sm font-bold text-white shadow-sm active:scale-[0.98]"
          >
            {emptyActionLabel || "Find someone to message"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <ul className="space-y-2 px-3 py-3">
      {items.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onOpen(c.id)}
            className="flex w-full items-center gap-3 rounded-2xl border border-blue-100 bg-gradient-to-r from-[#eff6ff] to-white px-3 py-3 text-left shadow-sm transition active:scale-[0.99] hover:border-[#2563eb]/40"
          >
            <div className="relative">
              <Avatar
              name={c.title}
              url={c.avatar_url}
              group={c.isGroup}
              onOpenProfile={
                !c.isGroup && c.peerUserId
                  ? () =>
                      openUserProfile(c.peerUserId, {
                        name: c.title,
                        avatar: c.avatar_url,
                      })
                  : undefined
              }
            />
              {c.isGroup ? (
                <span className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-white bg-[#2563eb] text-white">
                  <UsersRound className="h-3 w-3" />
                </span>
              ) : c.online ? (
                <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate font-semibold text-slate-900">
                  {c.title}
                  {c.isGroup ? (
                    <span className="ml-1.5 rounded-full bg-[#2563eb]/10 px-1.5 py-0.5 text-[10px] font-bold text-[#2563eb]">
                      Group
                    </span>
                  ) : null}
                </p>
                <span className="shrink-0 text-[11px] text-slate-400">
                  {formatListTime(c.time)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                {(() => {
                  const p = c.preview || "";
                  const isVoice = /voice note/i.test(p) || p.includes("🎤");
                  const isForward = /forwarded/i.test(p) || p.includes("↗") || p.startsWith("↪");
                  const isReply =
                    !isForward &&
                    (p.startsWith("↩") || /you got a reply/i.test(p) || false);
                  // cleaner: reply marker only
                  const isReplyMark = p.startsWith("↩") || p.startsWith("↪ ");
                  const label = p
                    .replace(/^↩\s*/, "")
                    .replace(/^↪\s*/, "")
                    .replace(/^↗\s*/, "")
                    .replace(/🎤\s*/g, "")
                    .replace(/^Forwarded\s*[·•\-]?\s*/i, "")
                    .trim();
                  if (isVoice) {
                    const clean = label.replace(/^Voice note/i, "Voice note").trim() || "Voice note";
                    return (
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-slate-500">
                        {isForward ? (
                          <CornerUpRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        ) : isReplyMark ? (
                          <Reply className="h-3.5 w-3.5 shrink-0 text-[#2563eb]" />
                        ) : null}
                        <Mic className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                        <span className="truncate">{clean}</span>
                      </span>
                    );
                  }
                  if (isForward) {
                    return (
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-slate-500">
                        <CornerUpRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span className="truncate">{label || "Forwarded"}</span>
                      </span>
                    );
                  }
                  if (isReplyMark && c.lastSenderId && c.lastSenderId !== myId) {
                    return (
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-slate-500">
                        <Reply className="h-3.5 w-3.5 shrink-0 text-[#2563eb]" />
                        <span className="truncate">
                          <span className="font-semibold text-[#2563eb]">You got a reply · </span>
                          {label}
                        </span>
                      </span>
                    );
                  }
                  if (isReplyMark) {
                    return (
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-slate-500">
                        <Reply className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span className="truncate">{label}</span>
                      </span>
                    );
                  }
                  return (
                    <p className="truncate text-[13px] text-slate-500">
                      {p || (c.isGroup ? "No messages yet — say hello" : "No messages yet")}
                    </p>
                  );
                })()}
                {c.unread > 0 ? (
                  <span className="ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[#2563eb] px-1.5 text-[11px] font-bold text-white">
                    {c.unread > 99 ? "99+" : c.unread}
                  </span>
                ) : c.preview ? (
                  <CheckCheck className="ml-auto h-3.5 w-3.5 shrink-0 text-[#2563eb]/70" />
                ) : null}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function StudentDirectory({
  students,
  loading,
  error,
  departmentOnly,
  departmentName,
  onMessage,
  onCloseDept,
  onRetry,
}: {
  students: StudentDiscover[];
  loading: boolean;
  error?: string | null;
  departmentOnly: boolean;
  departmentName: string;
  onMessage: (s: StudentDiscover) => void;
  onCloseDept: () => void;
  onRetry?: () => void;
}) {
  const byLevel = useMemo(() => {
    const map = new Map<string, StudentDiscover[]>();
    for (const s of students) {
      const key = s.level || "Other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [students]);

  return (
    <div>
      {departmentOnly ? (
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <p className="text-sm font-bold text-slate-800">{departmentName}</p>
          <button
            type="button"
            onClick={onCloseDept}
            className="text-xs font-semibold text-[#2563eb]"
          >
            Show all
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="px-4 py-8 text-center text-sm text-slate-400">
          Loading students…
        </div>
      ) : error ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">
          <p className="font-semibold text-slate-700">Could not load people</p>
          <p className="mt-1 text-xs text-red-600">{error}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 rounded-full bg-[#2563eb] px-4 py-2 text-xs font-semibold text-white"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : students.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">
          <p className="font-semibold text-slate-700">No students found</p>
          <p className="mt-1 text-xs">
            Try clearing search, or open My Department. If this stays empty, run the messaging RLS fix SQL in Supabase.
          </p>
        </div>
      ) : departmentOnly ? (
        byLevel.map(([level, list]) => (
          <div key={level}>
            <p className="bg-slate-50 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">
              {level}
            </p>
            {list.map((s) => (
              <StudentRow key={s.id} s={s} onMessage={onMessage} />
            ))}
          </div>
        ))
      ) : (
        students.map((s) => (
          <StudentRow key={s.id} s={s} onMessage={onMessage} />
        ))
      )}
    </div>
  );
}

function StudentRow({
  s,
  onMessage,
}: {
  s: StudentDiscover;
  onMessage: (s: StudentDiscover) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (s.auth_user_id) onMessage(s);
      }}
      disabled={!s.auth_user_id}
      className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-2xl border border-blue-100 bg-gradient-to-r from-[#eff6ff] to-white px-3 py-3 text-left shadow-sm transition active:scale-[0.99] hover:border-[#2563eb]/40 disabled:opacity-50"
    >
      <Avatar name={s.full_name} url={s.avatar_url} onOpenProfile={() =>
        s.auth_user_id &&
        openUserProfile(s.auth_user_id, {
          name: s.full_name,
          avatar: s.avatar_url,
          matric: s.matric_number,
        })
      } />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold text-slate-900">
          {s.full_name}
        </p>
        <p className="mt-0.5 truncate text-[11px] font-medium text-slate-500">
          {[s.matric_number, s.level].filter(Boolean).join(" · ")}
        </p>
        {s.department ? (
          <p className="mt-0.5 truncate text-[10px] text-slate-400">
            {s.department}
          </p>
        ) : null}
      </div>
      <span className="shrink-0 rounded-xl bg-[#2563eb] px-3 py-1.5 text-[11px] font-bold text-white shadow-sm">
        Message
      </span>
    </button>
  );
}

function CreateGroupModal({
  schoolId,
  userId,
  myDepartmentId,
  onClose,
  onCreated,
}: {
  schoolId: string;
  userId: string;
  myDepartmentId: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<GroupKind>("study");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<StudentDiscover[]>([]);
  const [busy, setBusy] = useState(false);

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ["group-pick-students", schoolId, q, myDepartmentId],
    enabled: Boolean(schoolId),
    queryFn: () =>
      discoverStudents({
        schoolId,
        query: q,
        departmentId: myDepartmentId,
        excludeUserId: userId,
        limit: 40,
      }),
  });

  const toggle = (s: StudentDiscover) => {
    setSelected((prev) =>
      prev.some((x) => x.id === s.id)
        ? prev.filter((x) => x.id !== s.id)
        : [...prev, s],
    );
  };

  const submit = async () => {
    if (!title.trim()) {
      toast.error("Enter a group name");
      return;
    }
    const memberIds = selected
      .map((s) => s.auth_user_id)
      .filter((id): id is string => Boolean(id));
    setBusy(true);
    try {
      const id = await createGroup({
        schoolId,
        creatorId: userId,
        title: title.trim(),
        description,
        groupKind: kind,
        memberUserIds: memberIds,
      });
      toast.success("Group created");
      onCreated(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create group");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white shadow-xl sm:rounded-3xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-base font-bold text-slate-900">Create Group</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-semibold text-slate-500"
          >
            Cancel
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Group name</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/30"
              placeholder="e.g. 300 Level Mathematics"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/30"
              placeholder="Optional"
            />
          </label>
          <div>
            <span className="text-xs font-semibold text-slate-600">Type</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {(
                [
                  ["study", "Study"],
                  ["course", "Course"],
                  ["class", "Class"],
                  ["project", "Project"],
                  ["general", "General"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-semibold",
                    kind === k
                      ? "bg-[#2563eb] text-white"
                      : "bg-slate-100 text-slate-600",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-600">
              Add members ({selected.length})
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or matric…"
              className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:ring-2 focus:ring-[#2563eb]/30"
            />
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {isLoading ? (
                <p className="text-xs text-slate-400">Searching…</p>
              ) : (
                candidates.map((s) => {
                  const on = selected.some((x) => x.id === s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggle(s)}
                      disabled={!s.auth_user_id}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left",
                        on ? "bg-[#eff6ff]" : "hover:bg-slate-50",
                      )}
                    >
                      <Avatar name={s.full_name} url={s.avatar_url} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{s.full_name}</p>
                        <p className="truncate text-[11px] text-slate-500">
                          {[s.matric_number, s.level].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      {on ? (
                        <Check className="h-4 w-4 text-[#2563eb]" />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
        <div className="border-t border-slate-100 p-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="h-11 w-full rounded-xl bg-[#2563eb] text-sm font-bold text-white disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create Group"}
          </button>
        </div>
      </div>
    </div>
  );
}
