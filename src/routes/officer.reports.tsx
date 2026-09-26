import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Mic,
  Paperclip,
  Search,
  Send,
  User,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SplitHandle } from "@/components/dashboard/SplitHandle";
import { isOnlineNow } from "@/lib/offline-sync";
import { joinMessagingPresence, ticksFor } from "@/lib/messaging-presence";
import { uploadMessageMedia } from "@/lib/message-media";
import { VoiceBubble, ImageBubble, ImageLightbox, VoiceRecorderBar, lastSeenLabel, parseMediaUrls, attachmentLabel, encodeOfficerMedia, parseOfficerReply } from "@/components/messaging/MessageMedia";

export const Route = createFileRoute("/officer/reports")({
  head: () => ({
    meta: [{ title: "Messages — D4EXAM" }],
  }),
  component: Page,
});

type ReportRow = {
  id: string;
  school_id: string;
  student_id: string | null;
  student_user_id: string | null;
  student_name: string | null;
  student_matric: string | null;
  exam_id: string | null;
  exam_title: string | null;
  exam_titles?: string[] | null;
  subject: string | null;
  body: string;
  status: string | null;
  officer_reply: string | null;
  replied_at: string | null;
  created_at: string;
  officer_read_at?: string | null;
  student_read_at?: string | null;
  attachment_url?: string | null;
  attachment_type?: string | null;
};

type Thread = {
  key: string;
  student_id: string | null;
  student_user_id: string | null;
  student_name: string | null;
  student_matric: string | null;
  rows: ReportRow[];
  latestAt: string;
  preview: string;
  unread: number;
};

type TabKey = "inbox" | "sent" | "all";

const COLORS = ["bg-blue-600", "bg-violet-600", "bg-emerald-600", "bg-rose-500", "bg-amber-600", "bg-cyan-600"];
function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h + seed.charCodeAt(i) * 17) % COLORS.length;
  return COLORS[h];
}
function initials(name: string | null) {
  const p = (name || "S").trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : (p[0]?.[0] || "S").toUpperCase();
}
function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short" });
}
function formatTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function Ticks({ state }: { state: "none" | "sent" | "delivered" | "read" }) {
  if (state === "none") return null;
  if (state === "sent") return <Check className="inline h-3.5 w-3.5 text-blue-100" />;
  if (state === "delivered") return <CheckCheck className="inline h-3.5 w-3.5 text-blue-100" />;
  return <CheckCheck className="inline h-3.5 w-3.5 text-[#0b1b3a]" />;
}

function Page() {
  const navigate = useNavigate();
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId;
  const userId = user?.userId;
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("inbox");
  const [search, setSearch] = useState("");
  const [threadKey, setThreadKey] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [presenceMap, setPresenceMap] = useState<Map<string, { online: boolean; typing?: boolean; recording?: boolean }>>(new Map());
  const [recording, setRecording] = useState(false);
  const [recPaused, setRecPaused] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [pendingAudio, setPendingAudio] = useState<Blob | null>(null);
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [listPct, setListPct] = useState(36);
  const dragRef = useRef<{ startX: number; startPct: number } | null>(null);
  const swipeRef = useRef<{ id: string; x: number } | null>(null);
  const [replyTo, setReplyTo] = useState<{ id: string; text: string } | null>(null);
  const mediaRec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const presenceApi = useRef<ReturnType<typeof joinMessagingPresence> | null>(null);
  const sendLock = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingAttach, setPendingAttach] = useState<{ url: string; type: string } | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [locallyReadThreads, setLocallyReadThreads] = useState<Record<string, boolean>>({});
  const [renameOpen, setRenameOpen] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [nickMap, setNickMap] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("d4exam.msg.nick.students") || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });

  const listQ = useQuery({
    queryKey: ["officer-student-reports", schoolId],
    enabled: Boolean(schoolId),
    refetchInterval: 8_000,
    queryFn: async () => {
      if (!schoolId) return [] as ReportRow[];
      const full = await supabase
        .from("student_officer_reports")
        .select(
          "id, school_id, student_id, student_user_id, student_name, student_matric, exam_id, exam_title, exam_titles, subject, body, status, officer_reply, replied_at, created_at, officer_read_at, student_read_at, attachment_url, attachment_type",
        )
        .eq("school_id", schoolId)
        .order("created_at", { ascending: true })
        .limit(400);
      if (full.error) {
        const { data } = await supabase
          .from("student_officer_reports")
          .select(
            "id, school_id, student_id, student_user_id, student_name, student_matric, exam_id, exam_title, exam_titles, subject, body, status, officer_reply, replied_at, created_at",
          )
          .eq("school_id", schoolId)
          .order("created_at", { ascending: true })
          .limit(400);
        return (data ?? []) as ReportRow[];
      }
      return (full.data ?? []) as ReportRow[];
    },
  });

  const rows = listQ.data ?? [];

  const threads: Thread[] = useMemo(() => {
    const map = new Map<string, Thread>();
    for (const r of rows) {
      const key = r.student_id || r.student_user_id || r.student_name || r.id;
      let t = map.get(key);
      if (!t) {
        t = {
          key,
          student_id: r.student_id,
          student_user_id: r.student_user_id,
          student_name: r.student_name,
          student_matric: r.student_matric,
          rows: [],
          latestAt: r.created_at,
          preview: r.body,
          unread: 0,
        };
        map.set(key, t);
      }
      t.rows.push(r);
      t.student_name = r.student_name || t.student_name;
      t.student_matric = r.student_matric || t.student_matric;
      const lastAt = r.replied_at && r.officer_reply ? r.replied_at : r.created_at;
      if (new Date(lastAt) >= new Date(t.latestAt)) {
        t.latestAt = lastAt;
        t.preview = r.officer_reply || r.body;
        if (!t.preview || t.preview === "(attachment)") {
          t.preview = attachmentLabel(r.attachment_type, r.attachment_url);
        }
      }
    }
    for (const t of map.values()) {
      t.unread = t.rows.filter((r) => {
        if (String(r.status || "open").toLowerCase() === "replied" && r.officer_reply) {
          return !r.officer_read_at;
        }
        return String(r.status || "open").toLowerCase() !== "replied" || !r.officer_read_at;
      }).length;
    }
    return [...map.values()].sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime());
  }, [rows]);

  const inboxCount = useMemo(() => threads.reduce((s, t) => s + (t.unread > 0 ? 1 : 0), 0), [threads]);

  const filteredThreads = useMemo(() => {
    let list = threads;
    if (tab === "inbox") list = threads.filter((t) => t.unread > 0 || t.rows.some((r) => !r.officer_reply));
    if (tab === "sent") list = threads.filter((t) => t.rows.some((r) => r.officer_reply));
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((t) =>
      `${t.student_name} ${t.student_matric} ${t.preview} ${t.rows.map((r) => r.subject).join(" ")}`
        .toLowerCase()
        .includes(q),
    );
  }, [threads, tab, search]);

  const active = threads.find((t) => t.key === threadKey) || null;

  const chatMessages = useMemo(() => {
    if (!active) return [];
    const out: { key: string; side: "in" | "out"; text: string; at: string; subject?: string | null; attachment_url?: string | null; attachment_type?: string | null; reportId: string }[] = [];
    for (const r of active.rows) {
      const bodyText = (r.body || "").trim();
      if (bodyText || r.attachment_url) {
        out.push({
          key: `${r.id}-s`,
          side: "in",
          text: r.body,
          at: r.created_at,
          subject: r.subject,
          attachment_url: r.attachment_url,
          attachment_type: r.attachment_type,
          reportId: r.id,
        });
      }
      const replyText = (r.officer_reply || "").trim();
      if (replyText) {
        out.push({
          key: `${r.id}-o`,
          side: "out",
          text: (parseOfficerReply(r.officer_reply).text || (parseOfficerReply(r.officer_reply).mediaUrl ? "(attachment)" : r.officer_reply!)),
          at: r.replied_at || r.created_at,
          reportId: r.id,
          attachment_url: parseOfficerReply(r.officer_reply).mediaUrl || undefined,
          attachment_type: parseOfficerReply(r.officer_reply).mediaType || undefined,
        });
      }
    }
    return out;
  }, [active]);

  useEffect(() => {
    if (!schoolId || !userId) return;
    const api = joinMessagingPresence(schoolId, { userId, role: "officer" }, {
      onPresence(map) {
        const next = new Map<string, { online: boolean; typing?: boolean; recording?: boolean }>();
        map.forEach((p, id) => {
          if (p.role === "student") next.set(id, { online: p.online, typing: p.typing, recording: p.recording });
        });
        setPresenceMap(next);
      },
    });
    presenceApi.current = api;
    return () => api.leave();
  }, [schoolId, userId]);

  // Mark officer read when open thread
  useEffect(() => {
    if (!active) return;
    const now = new Date().toISOString();
    const ids = active.rows.map((r) => r.id);
    if (ids.length) {
      void supabase
        .from("student_officer_reports")
        .update({ officer_read_at: now } as never)
        .in("id", ids)
        .then(() => {
          void qc.invalidateQueries({ queryKey: ["officer-student-reports"] });
          void qc.invalidateQueries({ queryKey: ["nav-student-reports-open"] });
        });
    }
  }, [active?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (threadKey) chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [threadKey, chatMessages.length]);

  const studentOnline = active
    ? Boolean(
        (active.student_user_id && presenceMap.get(active.student_user_id)?.online) ||
          [...presenceMap.entries()].some(([, v]) => v.online),
      )
    : false;
  const studentTyping = active
    ? Boolean(active.student_user_id && presenceMap.get(active.student_user_id)?.typing)
    : false;
  const studentRecording = active
    ? Boolean(active.student_user_id && presenceMap.get(active.student_user_id)?.recording)
    : false;

  const studentReadAt = useMemo(() => {
    if (!active) return null;
    let m = 0;
    for (const r of active.rows) {
      if (r.student_read_at) m = Math.max(m, new Date(r.student_read_at).getTime());
    }
    return m ? new Date(m).toISOString() : null;
  }, [active]);

  async function uploadBlob(blob: Blob, kind: string) {
    return uploadMessageMedia(blob, kind || blob.type || "application/octet-stream", `officer-msg/${schoolId || "s"}/${userId || "u"}`);
  }

  const sendReply = useCallback(async (text: string, attach?: { url: string; type: string } | null) => {
    if (sendLock.current || !active || !userId) return;
    if (!text.trim() && !attach) return;
sendLock.current = true;
    setSending(true);
    try {
      // Prefer reply on latest student message without officer_reply
      const openRow = [...active.rows].reverse().find((r) => !r.officer_reply);
      const target = openRow || active.rows[active.rows.length - 1];
      if (!target) return;
      const payload: Record<string, unknown> = {
        officer_reply: (attach ? encodeOfficerMedia(text, attach.type, attach.url) : text.trim()) || "(attachment)",
        replied_at: new Date().toISOString(),
        status: "replied",
        officer_user_id: userId,
        updated_at: new Date().toISOString(),
      };
      let { error } = await supabase.from("student_officer_reports").update(payload as never).eq("id", target.id);
      if (error) {
        const { error: e2 } = await supabase
          .from("student_officer_reports")
          .update({
            officer_reply: text.trim() || "(attachment)",
            replied_at: new Date().toISOString(),
            status: "replied",
            officer_user_id: userId,
          } as never)
          .eq("id", target.id);
        if (e2) throw e2;
      }
      if (active.student_user_id) {
        try {
          await supabase.from("notifications").insert({
            recipient_user_id: active.student_user_id,
            school_id: schoolId,
            title: "Officer replied to your message",
            message: (text.trim() || "New reply").slice(0, 280),
            type: "info",
            entity_type: "student_officer_report",
            entity_id: target.id,
            link: "/student/contact-officer",
          } as never);
        } catch {
          /* optional */
        }
      }
      setReply("");
      setPendingAttach(null);
      await qc.invalidateQueries({ queryKey: ["officer-student-reports"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send");
    } finally {
      setSending(false);
      sendLock.current = false;
    }
  }, [active, userId, schoolId, qc]);

  function onTyping(v: string) {
    setReply(v);
    presenceApi.current?.setTyping(v.trim().length > 0, active?.key);
  }

  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        presenceApi.current?.setRecording(false, active?.key);
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        if (blob.size >= 200) {
          setPendingAudio(blob);
          if (pendingAudioUrl) URL.revokeObjectURL(pendingAudioUrl);
          setPendingAudioUrl(URL.createObjectURL(blob));
        }
        setRecording(false);
        setRecPaused(false);
        if (recTimer.current) clearInterval(recTimer.current);
      };
      mediaRec.current = rec;
      rec.start(250);
      setRecording(true);
      setRecPaused(false);
      setRecSecs(0);
      setPendingAudio(null);
      if (recTimer.current) clearInterval(recTimer.current);
      recTimer.current = setInterval(() => setRecSecs((s) => s + 1), 1000);
      presenceApi.current?.setRecording(true, active?.key);
    } catch {
      toast.error("Microphone permission required");
    }
  }

  function cancelRec() {
    try { mediaRec.current?.stop(); } catch { /* ignore */ }
    chunks.current = [];
    setPendingAudio(null);
    if (pendingAudioUrl) { URL.revokeObjectURL(pendingAudioUrl); setPendingAudioUrl(null); }
    setRecording(false);
    setRecPaused(false);
    setRecSecs(0);
    if (recTimer.current) clearInterval(recTimer.current);
    presenceApi.current?.setRecording(false, active?.key);
  }

  async function sendVoiceNow() {
    if (recording) {
      try { mediaRec.current?.stop(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const blob = pendingAudio || (chunks.current.length ? new Blob(chunks.current, { type: "audio/webm" }) : null);
    if (!blob || blob.size < 200) {
      cancelRec();
      return;
    }
    try {
      const up = await uploadBlob(blob, "audio/webm");
      await sendReply("", { url: up.url, type: "audio" });
    } catch {
      toast.error("Could not upload voice note");
    } finally {
      setPendingAudio(null);
      if (pendingAudioUrl) { URL.revokeObjectURL(pendingAudioUrl); setPendingAudioUrl(null); }
      setRecSecs(0);
    }
  }

  useEffect(() => {
    const onBack = () => {
      if (threadKey) setThreadKey(null);
    };
    window.addEventListener("d4-messaging-back", onBack);
    return () => window.removeEventListener("d4-messaging-back", onBack);
  }, [threadKey]);

  useEffect(() => {
    (window as unknown as { __d4MsgInChat?: boolean }).__d4MsgInChat = Boolean(threadKey);
    return () => { (window as unknown as { __d4MsgInChat?: boolean }).__d4MsgInChat = false; };
  }, [threadKey]);

  return (
    <div className="flex h-dvh max-h-dvh w-full flex-col bg-white lg:flex-row lg:overflow-hidden select-none">
      <div
        className={cn(
          "flex min-h-0 flex-col bg-white",
          threadKey ? "hidden lg:flex" : "flex w-full flex-1",
          "lg:w-[min(var(--lp),48%)] lg:min-w-[280px] lg:max-w-[48%] lg:flex-none lg:border-r lg:border-slate-200",
        )}
        style={{ ["--lp"]: `${listPct}%` } as Record<string, string>}
      >
          <div className="shrink-0 border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="mb-2 flex items-center gap-2">
              <button type="button" onClick={() => navigate({ to: "/officer" })} className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10" aria-label="Back">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-lg font-extrabold">Messages</h1>
                <p className="text-[11px] text-slate-500">Student conversations</p>
              </div>
            </div>
            <div className="flex gap-1 rounded-full bg-slate-100 p-1">
              {([
                { k: "inbox" as const, label: "Inbox", count: inboxCount },
                { k: "sent" as const, label: "Sent" },
                { k: "all" as const, label: "All" },
              ] as const).map((t) => (
                <button
                  key={t.k}
                  type="button"
                  onClick={() => setTab(t.k)}
                  className={cn("flex flex-1 items-center justify-center gap-1 rounded-full py-2 text-xs font-bold", tab === t.k ? "bg-[#2563eb] text-white" : "text-slate-600")}
                >
                  {t.label}
                  {"count" in t && t.count > 0 ? (
                    <span className="grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] text-white">{t.count}</span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search messages…" className="h-10 rounded-xl bg-slate-50 pl-9" />
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {filteredThreads.length === 0 ? (
              <li className="px-4 py-12 text-center text-sm text-slate-500">No student messages yet.</li>
            ) : (
              filteredThreads.map((t) => {
                const online = Boolean(t.student_user_id && presenceMap.get(t.student_user_id)?.online);
                return (
                  <li key={t.key}>
                    <button
                      type="button"
                      onClick={() => { setThreadKey(t.key); setLocallyReadThreads((m) => ({ ...m, [t.key]: true })); }}
                      className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] items-start gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm hover:border-blue-200 hover:shadow-md"
                    >
                      <span className={cn("relative grid h-10 w-10 place-items-center rounded-full text-sm font-bold text-white", avatarColor(t.key))}>
                        {initials(t.student_name)}
                        <span className={cn("absolute bottom-0.5 right-0.5 h-3 w-3 rounded-full border-2 border-white", online ? "bg-emerald-400" : "bg-slate-300")} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between gap-2">
                          <p className="truncate text-sm font-bold">{nickMap[t.key] || t.student_name || "Student"}</p>
                          <span className="text-[10px] text-slate-400">{formatWhen(t.latestAt)}</span>
                        </div>
                        <p className="truncate text-xs text-slate-600">
                          {t.student_matric ? `${t.student_matric} · ` : ""}
                          {t.rows[t.rows.length - 1]?.subject || t.rows[t.rows.length - 1]?.exam_title || "Message"}
                        </p>
                        <p className="line-clamp-1 text-xs text-slate-500">{t.preview}</p>
                      </div>
                      {t.unread > 0 && !locallyReadThreads[t.key] ? (
                        <span className="mt-1 grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                          {t.unread > 99 ? "99+" : t.unread}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
      </div>

      <SplitHandle
        className="hidden lg:flex"
        onPointerDown={(e) => {
          dragRef.current = { startX: e.clientX, startPct: listPct };
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const dx = e.clientX - dragRef.current.startX;
          setListPct(Math.min(58, Math.max(20, dragRef.current.startPct + (dx / window.innerWidth) * 100)));
        }}
        onPointerUp={() => { dragRef.current = null; }}
      />

      {active ? (
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !threadKey && "hidden lg:flex")}>
          <div className="relative z-40 flex shrink-0 items-center gap-3 border-b border-white/10 bg-[#0b1b3a] px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white">
            <button type="button" onClick={() => setThreadKey(null)} className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <span className={cn("relative grid h-10 w-10 place-items-center rounded-full text-sm font-bold text-white", avatarColor(active.key))}>
              {initials(active.student_name)}
              <span className={cn("absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white", studentOnline ? "bg-emerald-400" : "bg-slate-300")} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">
                {nickMap[active.key] || active.student_name || "Student"}
                {active.student_matric ? <span className="ml-1 text-xs font-semibold text-slate-500">· {active.student_matric}</span> : null}
              </p>
              <p className={cn("text-[11px] font-medium", studentOnline ? "text-emerald-600" : "text-slate-400")}>
                {studentRecording ? "Recording…" : studentTyping ? "Typing…" : studentRecording ? "Recording…" : studentTyping ? "Typing…" : studentOnline ? "Online" : lastSeenLabel(null)}
              </p>
            </div>
            <div className="relative">
              <button type="button" className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10" onClick={() => setChatMenuOpen((v) => !v)} aria-label="Chat actions">
                <span className="text-lg leading-none">⋮</span>
              </button>
              {chatMenuOpen ? (
                <div className="absolute right-0 z-[70] mt-1 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                  <button type="button" className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50" onClick={() => {
                    setRenameOpen(true);
                    setRenameVal(nickMap[active.key] || active.student_name || "Student");
                    setChatMenuOpen(false);
                  }}>Rename contact</button>
                  <button type="button" className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50" onClick={() => {
                    setChatMenuOpen(false);
                    void qc.invalidateQueries({ queryKey: ["officer-student-reports"] });
                  }}>Refresh chat</button>
                  <button type="button" className="block w-full px-3 py-2.5 text-left text-sm text-red-600 hover:bg-red-50" onClick={() => {
                    setClearOpen(true);
                    setChatMenuOpen(false);
                  }}>Clear chat</button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3" style={{ background: "linear-gradient(180deg, #f0f7ff 0%, #f8fafc 40%, #eef6ff 100%)" }}>
            {chatMessages.map((m) => {
              const tick =
                m.side === "out"
                  ? ticksFor({ isMine: true, createdAt: m.at, peerOnline: true, peerReadAt: studentReadAt })
                  : "none";
              const outTick = tick === "read" ? "read" : tick === "none" ? "none" : "delivered";
              const hasContent =
                Boolean(m.attachment_url) ||
                (Boolean(m.text) && m.text.trim() !== "" && m.text.trim() !== "(attachment)");
              if (!hasContent) return null;
              return (
                <div key={m.key} className={cn("flex w-full select-none", m.side === "out" ? "justify-end" : "justify-start gap-2")}
                  onCopy={(e) => e.preventDefault()}
                  onContextMenu={(e) => e.preventDefault()}
                  onTouchStart={(e) => { swipeRef.current = { id: m.reportId, x: e.touches[0]?.clientX ?? 0 }; }}
                  onTouchEnd={(e) => {
                    const s = swipeRef.current;
                    swipeRef.current = null;
                    if (!s) return;
                    const x = e.changedTouches[0]?.clientX ?? 0;
                    if (x - s.x > 56) {
                      setReplyTo({ id: m.reportId, text: (m.text && m.text !== "(attachment)" ? m.text : attachmentLabel(m.attachment_type, m.attachment_url)).slice(0, 120) });
                    }
                  }}>
                  {m.side === "in" ? (
                    <span className={cn("mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white", avatarColor(active.key))}>
                      {initials(active.student_name)}
                    </span>
                  ) : null}
                  {m.attachment_type === "audio" && m.attachment_url ? (
                    <VoiceBubble src={m.attachment_url} mine={m.side === "out"} timeLabel={formatTime(m.at)} tick={m.side === "out" ? outTick : "none"} />
                  ) : (m.attachment_type === "image" || m.attachment_type === "images") && m.attachment_url ? (
                    (() => {
                      const urls = parseMediaUrls(m.attachment_url);
                      return (
                        <ImageBubble
                          src={urls[0]}
                          count={urls.length}
                          timeLabel={formatTime(m.at)}
                          tick={m.side === "out" ? outTick : "none"}
                          onOpen={() => setLightboxSrc(JSON.stringify(urls))}
                        />
                      );
                    })()
                  ) : (
                    <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm", m.side === "out" ? "rounded-br-md border border-slate-200 bg-white text-slate-800" : "rounded-bl-md bg-[#2563eb] text-white")}>
                      {m.subject && m.side === "in" ? <p className="mb-0.5 text-[11px] font-semibold text-slate-500">{m.subject}</p> : null}
                      {m.text && m.text !== "(attachment)" ? <p className="whitespace-pre-wrap break-words">{m.text}</p> : null}
                      <p className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", m.side === "out" ? "text-slate-400" : "text-blue-100")}>
                        {formatTime(m.at)}
                        {m.side === "out" ? <Ticks state={outTick === "none" ? "delivered" : outTick} /> : null}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
            {studentTyping ? <p className="text-center text-xs text-slate-500">Student is typing…</p> : null}
            {studentRecording ? <p className="text-center text-xs text-slate-500">Student is recording…</p> : null}
            <div ref={chatEndRef} />
          </div>
          <div className="shrink-0 border-t border-white/10 bg-[#0b1b3a] px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-white">
            {replyTo ? (
              <div className="mb-2 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-bold text-blue-800">Replying</p>
                  <p className="line-clamp-2 text-xs text-slate-700">{replyTo.text}</p>
                </div>
                <button type="button" onClick={() => setReplyTo(null)} className="text-slate-400" aria-label="Cancel reply">×</button>
              </div>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*,.pdf" multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (!files?.length) return;
                void (async () => {
                  try {
                    const urls: string[] = [];
                    let kind: "image" | "audio" | "file" = "file";
                    for (const f of Array.from(files)) {
                      const up = await uploadBlob(f, f.type);
                      urls.push(up.url);
                      if (up.type === "image") kind = "image";
                    }
                    const url = urls.length > 1 ? JSON.stringify(urls) : urls[0];
                    setPendingAttach({ url, type: kind });
                    // auto-send multi immediately
                    await sendReply("", { url, type: kind });
                    setPendingAttach(null);
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Upload failed");
                  }
                })();
                e.target.value = "";
              }}
            />
            <div className="flex items-end gap-1.5">
              <button type="button" className="mb-1 grid h-9 w-9 place-items-center rounded-full text-white/90 hover:bg-white/10" onClick={() => fileRef.current?.click()}>
                <Paperclip className="h-5 w-5" />
              </button>
              <div className="flex min-w-0 flex-1 items-end rounded-full border border-white/20 bg-white px-3">
                <textarea value={reply} onChange={(e) => onTyping(e.target.value)} rows={1} placeholder="Type your message…" className="max-h-24 min-h-[36px] w-full resize-none bg-transparent py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400" />
              </div>
              {reply.trim() || pendingAttach ? (
                <button type="button" disabled={sending} onClick={() => void sendReply(reply, pendingAttach)} className="mb-0.5 grid h-10 w-10 place-items-center rounded-full bg-[#2563eb] text-white">
                  <Send className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  className={cn("mb-0.5 grid h-10 w-10 place-items-center rounded-full text-white", recording ? "bg-red-500" : "bg-[#0b1b3a]")}
                  onClick={() => { if (!recording) void startRec(); }}
                >
                  <Mic className="h-4 w-4" />
                </button>
              )}
            </div>
            {recording || pendingAudioUrl ? (
              <VoiceRecorderBar
                recording={recording}
                paused={recPaused}
                seconds={recSecs}
                previewUrl={pendingAudioUrl}
                onCancel={cancelRec}
                onPause={() => {
                  try {
                    mediaRec.current?.pause();
                    setRecPaused(true);
                    const blob = new Blob(chunks.current, { type: "audio/webm" });
                    if (blob.size >= 200) {
                      if (pendingAudioUrl) URL.revokeObjectURL(pendingAudioUrl);
                      setPendingAudio(blob);
                      setPendingAudioUrl(URL.createObjectURL(blob));
                    }
                  } catch { /* ignore */ }
                }}
                onContinue={() => {
                  try { mediaRec.current?.resume(); setRecPaused(false); } catch { /* ignore */ }
                }}
                onPreviewPlay={() => {
                  if (pendingAudioUrl) void new Audio(pendingAudioUrl).play().catch(() => {});
                }}
                onSend={() => void sendVoiceNow()}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="hidden min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-slate-50 p-8 text-center lg:flex">
          <p className="text-sm font-semibold text-slate-600">Select a conversation</p>
          <p className="text-xs text-slate-400">Messages appear here when you open a student thread</p>
        </div>
      )}

      {lightboxSrc ? (
        <ImageLightbox
          urls={(() => {
            try {
              const p = JSON.parse(lightboxSrc);
              if (Array.isArray(p)) return p as string[];
            } catch { /* single */ }
            return [lightboxSrc];
          })()}
          onClose={() => setLightboxSrc(null)}
        />
      ) : null}
      {renameOpen && active ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-extrabold text-slate-900">Rename contact</h3>
            <p className="mt-1 text-xs text-slate-500">Display name only on your device.</p>
            <input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} className="mt-3 h-11 w-full rounded-xl border px-3 text-sm" autoFocus />
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl border py-2.5 text-sm font-bold" onClick={() => setRenameOpen(false)}>Cancel</button>
              <button type="button" className="flex-1 rounded-xl bg-[#2563eb] py-2.5 text-sm font-bold text-white" onClick={() => {
                const n = renameVal.trim() || active.student_name || "Student";
                const next = { ...nickMap, [active.key]: n };
                setNickMap(next);
                try { localStorage.setItem("d4exam.msg.nick.students", JSON.stringify(next)); } catch { /* ignore */ }
                setRenameOpen(false);
              }}>Save</button>
            </div>
          </div>
        </div>
      ) : null}

      {clearOpen && active ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-extrabold text-slate-900">Clear this chat?</h3>
            <p className="mt-1 text-xs text-slate-500">All messages with this student will be deleted.</p>
            <div className="mt-4 flex gap-2">
              <button type="button" className="flex-1 rounded-xl border py-2.5 text-sm font-bold" onClick={() => setClearOpen(false)}>Cancel</button>
              <button type="button" className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-bold text-white" onClick={async () => {
                const ids = active.rows.map((r) => r.id);
                const { error } = await supabase.from("student_officer_reports").delete().in("id", ids);
                if (error) toast.error(error.message);
                else {
                  setThreadKey(null);
                  setClearOpen(false);
                  await qc.invalidateQueries({ queryKey: ["officer-student-reports"] });
                }
              }}>Clear chat</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
