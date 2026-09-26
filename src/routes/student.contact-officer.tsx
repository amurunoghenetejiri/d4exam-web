import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Mic,
  Paperclip,
  Reply,
  Search,
  Send,
  User,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSessionUser } from "@/lib/session";
import { useStudentContext } from "@/lib/student";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SplitHandle } from "@/components/dashboard/SplitHandle";
import { isOnlineNow } from "@/lib/offline-sync";
import { joinMessagingPresence, ticksFor } from "@/lib/messaging-presence";
import { uploadMessageMedia } from "@/lib/message-media";
import { VoiceBubble, ImageBubble, ImageLightbox, VideoBubble, FileBubble, VideoLightbox, LongPressMenu, VoiceRecorderBar, lastSeenLabel, parseMediaUrls, attachmentLabel, parseOfficerReply } from "@/components/messaging/MessageMedia";

export const Route = createFileRoute("/student/contact-officer")({
  head: () => ({ meta: [{ title: "Messages — D4EXAM" }] }),
  component: Page,
});

type ExamOpt = { id: string; title: string };
type ReportRow = {
  id: string;
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
  reply_to_id?: string | null;
};

type ChatMsg = {
  key: string;
  side: "out" | "in";
  text: string;
  at: string;
  subject?: string | null;
  attachment_url?: string | null;
  attachment_type?: string | null;
  reportId: string;
  replyPreview?: string | null;
  replyToKey?: string | null;
};

type TabKey = "inbox" | "sent" | "all";

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
  if (state === "sent") return <Check className="inline h-3.5 w-3.5 text-slate-400" aria-label="Sent" />;
  if (state === "delivered") return <CheckCheck className="inline h-3.5 w-3.5 text-slate-400" aria-label="Delivered" />;
  return <CheckCheck className="inline h-3.5 w-3.5 text-[#2563eb]" aria-label="Read" />;
}

function Page() {
  const navigate = useNavigate();
  const { data: session } = useSessionUser();
  const { data: student } = useStudentContext();
  const qc = useQueryClient();
  const schoolId = session?.schoolId ?? student?.schoolId;
  const studentId = student?.studentId;
  const userId = session?.userId;

  const [tab, setTab] = useState<TabKey>("all");
  const [search, setSearch] = useState("");
  const [inChat, setInChat] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [officerOnline, setOfficerOnline] = useState(false);
  const [officerLastSeen, setOfficerLastSeen] = useState<number | null>(null);
  const [officerTyping, setOfficerTyping] = useState(false);
  const [officerRecording, setOfficerRecording] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [pendingAudio, setPendingAudio] = useState<Blob | null>(null);
  const [pendingAttach, setPendingAttach] = useState<{ url: string; type: string } | null>(null);
  const [replyTo, setReplyTo] = useState<{ id: string; text: string; fromSelf?: boolean } | null>(null);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [officerNickname, setOfficerNickname] = useState(() => {
    try {
      return localStorage.getItem("d4exam.msg.nick.officer") || "Departmental Officer";
    } catch {
      return "Departmental Officer";
    }
  });
  const [renameVal, setRenameVal] = useState("");
  const [listPct, setListPct] = useState(38);
  const [locallyRead, setLocallyRead] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [videoLightboxSrc, setVideoLightboxSrc] = useState<string | null>(null);
  const [menuMsg, setMenuMsg] = useState<ChatMsg | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");
  const [pendingAudioUrl, setPendingAudioUrl] = useState<string | null>(null);
  const [recPaused, setRecPaused] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ startX: number; startPct: number } | null>(null);
  const mediaRec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const presenceApi = useRef<ReturnType<typeof joinMessagingPresence> | null>(null);
  const sendLock = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const swipeRef = useRef<{ key: string; id: string; x: number } | null>(null);
  const [swipeDx, setSwipeDx] = useState<Record<string, number>>({});
  const [highlightKey, setHighlightKey] = useState<string | null>(null);

  const scrollToMessage = useCallback((reportId: string, prefer: "s" | "o" | "any" = "any") => {
    const tryIds =
      prefer === "s"
        ? [`msg-${reportId}-s`, `msg-${reportId}-o`]
        : prefer === "o"
          ? [`msg-${reportId}-o`, `msg-${reportId}-s`]
          : [`msg-${reportId}-s`, `msg-${reportId}-o`, `msg-${reportId}`];
    for (const id of tryIds) {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightKey(id.replace(/^msg-/, ""));
        window.setTimeout(() => setHighlightKey(null), 1600);
        return;
      }
    }
  }, []);

  const [examSearch, setExamSearch] = useState("");
  const [selectedExamIds, setSelectedExamIds] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const examsQ = useQuery({
    queryKey: ["student-contact-exams", schoolId, studentId],
    enabled: Boolean(schoolId),
    staleTime: 60_000,
    queryFn: async () => {
      if (!schoolId) return [] as ExamOpt[];
      const map = new Map<string, string>();
      if (studentId) {
        const { data } = await supabase
          .from("exam_attempts")
          .select("exam_id, examinations(id, title)")
          .eq("student_id", studentId)
          .order("created_at", { ascending: false })
          .limit(60);
        for (const a of data ?? []) {
          const ex = (a as { examinations?: { id?: string; title?: string } | null }).examinations;
          const id = ex?.id || (a as { exam_id?: string }).exam_id;
          if (id) map.set(String(id), String(ex?.title || "Examination"));
        }
      }
      const { data: exams } = await supabase
        .from("examinations")
        .select("id, title")
        .eq("school_id", schoolId)
        .in("status", ["published", "approved", "scheduled", "active", "closed", "ongoing", "completed"])
        .order("created_at", { ascending: false })
        .limit(80);
      for (const e of exams ?? []) {
        const id = String((e as { id: string }).id);
        if (!map.has(id)) map.set(id, String((e as { title?: string }).title || "Examination"));
      }
      return [...map.entries()].map(([id, title]) => ({ id, title }));
    },
  });

  const mineQ = useQuery({
    queryKey: ["student-my-reports", schoolId, studentId, userId],
    enabled: Boolean(schoolId && (studentId || userId)),
    refetchInterval: 8_000,
    queryFn: async () => {
      let q = supabase
        .from("student_officer_reports")
        .select(
          "id, exam_id, exam_title, exam_titles, subject, body, status, officer_reply, replied_at, created_at, officer_read_at, student_read_at, attachment_url, attachment_type, reply_to_id",
        )
        .eq("school_id", schoolId!)
        .order("created_at", { ascending: true })
        .limit(200);
      if (studentId) q = q.eq("student_id", studentId);
      else if (userId) q = q.eq("student_user_id", userId);
      const { data, error } = await q;
      if (error) {
        let q2 = supabase
          .from("student_officer_reports")
          .select("id, exam_id, exam_title, exam_titles, subject, body, status, officer_reply, replied_at, created_at")
          .eq("school_id", schoolId!)
          .order("created_at", { ascending: true })
          .limit(200);
        if (studentId) q2 = q2.eq("student_id", studentId);
        else if (userId) q2 = q2.eq("student_user_id", userId);
        const r2 = await q2;
        return (r2.data ?? []) as ReportRow[];
      }
      return (data ?? []) as ReportRow[];
    },
  });

  const rows = mineQ.data ?? [];
  const exams = examsQ.data ?? [];

  const hiddenKeys = useMemo(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("d4exam.msg.hidden") || "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  }, [rows]);

  const chatMessages: ChatMsg[] = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ChatMsg[] = [];
    for (const r of rows) {
      let replyPreview: string | null = null;
      let replyToKey: string | null = null;
      if (r.reply_to_id && byId.has(r.reply_to_id)) {
        const parent = byId.get(r.reply_to_id)!;
        // Prefer linking to the officer bubble if that report was answered, else student body
        if ((parent.officer_reply || "").trim()) {
          replyPreview = parent.officer_reply;
          replyToKey = `${parent.id}-o`;
        } else {
          replyPreview = parent.body;
          replyToKey = `${parent.id}-s`;
        }
      }
      const bodyText = (r.body || "").trim();
      const hasMedia = Boolean(r.attachment_url);
      if (bodyText || hasMedia) {
        out.push({
          key: `${r.id}-s`,
          side: "out",
          text: r.body,
          at: r.created_at,
          subject: r.subject,
          attachment_url: r.attachment_url,
          attachment_type: r.attachment_type,
          reportId: r.id,
          replyPreview,
          replyToKey,
        });
      }
      const replyText = (r.officer_reply || "").trim();
      if (replyText) {
        out.push({
          key: `${r.id}-o`,
          side: "in",
          text: (parseOfficerReply(r.officer_reply).text || (parseOfficerReply(r.officer_reply).mediaUrl ? "(attachment)" : r.officer_reply!)),
          at: r.replied_at || r.created_at,
          reportId: r.id,
          attachment_url: parseOfficerReply(r.officer_reply).mediaUrl || undefined,
          attachment_type: parseOfficerReply(r.officer_reply).mediaType || undefined,
        });
      }
    }
    return out.filter((m) => !hiddenKeys.has(m.key));
  }, [rows, hiddenKeys]);

  const latest = rows.length ? rows[rows.length - 1] : null;
  const inboxUnread = useMemo(() => {
    if (locallyRead) return 0;
    return rows.filter((r) => {
      if (!r.officer_reply) return false;
      if (!r.student_read_at) return true;
      return new Date(r.replied_at || r.created_at).getTime() > new Date(r.student_read_at).getTime();
    }).length;
  }, [rows, locallyRead]);


  useEffect(() => {
    if (!schoolId || !userId) return;
    const api = joinMessagingPresence(schoolId, { userId, role: "student", conversationKey: studentId || userId }, {
      onPresence(map) {
        let online = false;
        let typing = false;
        let recording = false;
        let lastAt: number | null = null;
        map.forEach((p) => {
          if (p.role === "officer") {
            if (p.at) lastAt = Math.max(lastAt || 0, p.at);
            if (p.online) {
              online = true;
              if (p.typing) typing = true;
              if (p.recording) recording = true;
            }
          }
        });
        setOfficerOnline(online);
        if (lastAt) setOfficerLastSeen(lastAt);
        setOfficerTyping(typing);
        setOfficerRecording(recording);
      },
    });
    presenceApi.current = api;
    return () => api.leave();
  }, [schoolId, userId, studentId]);

  useEffect(() => {
    if (!inChat || !rows.length) return;
    setLocallyRead(true);
    const now = new Date().toISOString();
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      void supabase
        .from("student_officer_reports")
        .update({ student_read_at: now } as never)
        .in("id", ids)
        .then(() => qc.invalidateQueries({ queryKey: ["student-my-reports"] }));
    }
  }, [inChat]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (inChat) chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [inChat, chatMessages.length, officerTyping]);

  useEffect(() => {
    (window as unknown as { __d4MsgInChat?: boolean }).__d4MsgInChat = inChat || composeOpen;
    return () => { (window as unknown as { __d4MsgInChat?: boolean }).__d4MsgInChat = false; };
  }, [inChat, composeOpen]);

  useEffect(() => {
    const onBack = () => {
      if (composeOpen) {
        setComposeOpen(false);
        return;
      }
      if (inChat) {
        setInChat(false);
        return;
      }
    };
    window.addEventListener("d4-messaging-back", onBack);
    return () => window.removeEventListener("d4-messaging-back", onBack);
  }, [inChat, composeOpen]);

  useEffect(() => {
    if (!recording) {
      if (recTimer.current) clearInterval(recTimer.current);
      recTimer.current = null;
      setRecSecs(0);
      return;
    }
    if (recPaused) {
      if (recTimer.current) clearInterval(recTimer.current);
      recTimer.current = null;
      return;
    }
    // Keep seconds when resuming; only start interval when actively recording
    if (!recTimer.current) {
      recTimer.current = setInterval(() => setRecSecs((s) => s + 1), 1000);
    }
    return () => {
      if (recTimer.current) {
        clearInterval(recTimer.current);
        recTimer.current = null;
      }
    };
  }, [recording, recPaused]);

  const selectedTitles = useMemo(
    () => exams.filter((e) => selectedExamIds.includes(e.id)).map((e) => e.title),
    [exams, selectedExamIds],
  );
  const filteredExams = useMemo(() => {
    const q = examSearch.trim().toLowerCase();
    return q ? exams.filter((e) => e.title.toLowerCase().includes(q)) : exams;
  }, [exams, examSearch]);

  const maxOfficerRead = useMemo(() => {
    let m = 0;
    for (const r of rows) {
      if (r.officer_read_at) m = Math.max(m, new Date(r.officer_read_at).getTime());
    }
    return m ? new Date(m).toISOString() : null;
  }, [rows]);

  const listPreview = useMemo(() => {
    if (!latest) return null;
    const lastMsg = chatMessages[chatMessages.length - 1];
    let preview = "";
    if (lastMsg) {
      if (lastMsg.attachment_type === "audio") {
        preview = "🎤 " + attachmentLabel(lastMsg.attachment_type, lastMsg.attachment_url);
      } else if (lastMsg.attachment_type === "image" || lastMsg.attachment_type === "images") {
        preview = "📷 " + attachmentLabel(lastMsg.attachment_type, lastMsg.attachment_url);
      } else if (lastMsg.attachment_type === "video" || lastMsg.attachment_type === "videos") {
        preview = "🎥 " + attachmentLabel(lastMsg.attachment_type, lastMsg.attachment_url);
      } else if (lastMsg.attachment_type) {
        preview = "📎 " + attachmentLabel(lastMsg.attachment_type, lastMsg.attachment_url);
      } else if (lastMsg.text && lastMsg.text !== "(attachment)") {
        preview = lastMsg.text;
      } else {
        preview = "Conversation";
      }
    }
    const isOut = lastMsg?.side === "out";
    const tick = isOut
      ? ticksFor({
          isMine: true,
          createdAt: lastMsg?.at || latest.created_at,
          peerOnline: true,
          peerReadAt: maxOfficerRead,
        })
      : "none";
    return {
      preview,
      at: lastMsg?.at || latest.created_at,
      unread: inboxUnread,
      isOut,
      tick: tick as "none" | "sent" | "delivered" | "read",
    };
  }, [latest, chatMessages, inboxUnread, maxOfficerRead]);

  const sendMessage = useCallback(
    async (text: string, attach?: { url: string; type: string } | null) => {
      if (sendLock.current) return;
      if (!schoolId) return;
      if (!text.trim() && !attach) return;
      sendLock.current = true;
      setSending(true);
      try {
        const name = session?.fullName || student?.fullName || "Student";
        const payload: Record<string, unknown> = {
          school_id: schoolId,
          student_id: studentId || null,
          student_user_id: userId || null,
          student_name: name,
          student_matric: student?.matric || null,
          exam_id: selectedExamIds[0] || null,
          exam_title: selectedTitles[0] || null,
          exam_ids: selectedExamIds.length ? selectedExamIds : [],
          exam_titles: selectedTitles.length ? selectedTitles : [],
          subject: replyTo ? `Re: ${(replyTo.text || "").slice(0, 40)}` : subject.trim() || null,
          body: text.trim() || (attach ? "(attachment)" : ""),
          status: "open",
          attachment_url: attach?.url || null,
          attachment_type: attach?.type || null,
          reply_to_id: replyTo?.id || null,
        };
        let { error } = await supabase.from("student_officer_reports").insert(payload as never);
        if (error) {
          const { error: e2 } = await supabase.from("student_officer_reports").insert({
            school_id: schoolId,
            student_id: studentId || null,
            student_user_id: userId || null,
            student_name: name,
            student_matric: student?.matric || null,
            exam_id: selectedExamIds[0] || null,
            exam_title: selectedTitles[0] || null,
            subject: subject.trim() || "Message",
            body: text.trim() || "(attachment)",
            status: "open",
          } as never);
          if (e2) throw e2;
        }
        setBody("");
        setSubject("");
        setReplyText("");
        setPendingAttach(null);
        setReplyTo(null);
        setComposeOpen(false);
        setInChat(true);
        setLocallyRead(false);
        await qc.invalidateQueries({ queryKey: ["student-my-reports"] });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not send");
      } finally {
        setSending(false);
        sendLock.current = false;
      }
    },
    [schoolId, session, student, studentId, userId, selectedExamIds, selectedTitles, subject, replyTo, qc],
  );

  function onTyping(v: string) {
    setReplyText(v);
    presenceApi.current?.setTyping(v.trim().length > 0, studentId || userId);
  }

  async function startRec() {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        presenceApi.current?.setRecording(false, studentId || userId);
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        if (blob.size >= 200) {
          setPendingAudio(blob);
          setPendingAudioUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
          });
        }
        setRecording(false);
        setRecPaused(false);
      };
      mediaRec.current = rec;
      // timeslice so pause captures data up to the pause point
      rec.start(250);
      setRecording(true);
      setRecPaused(false);
      setRecSecs(0);
      setPendingAudio(null);
      setPendingAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      presenceApi.current?.setRecording(true, studentId || userId);
    } catch {
      toast.error("Microphone permission is required for voice notes");
    }
  }

  function cancelRec() {
    try {
      if (mediaRec.current && mediaRec.current.state !== "inactive") {
        mediaRec.current.stop();
      }
    } catch {
      /* ignore */
    }
    mediaRec.current = null;
    chunks.current = [];
    setPendingAudio(null);
    setPendingAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setRecording(false);
    setRecPaused(false);
    setRecSecs(0);
    presenceApi.current?.setRecording(false, studentId || userId);
  }

  function stopRecKeep() {
    try {
      if (mediaRec.current && mediaRec.current.state !== "inactive") {
        mediaRec.current.stop();
      }
    } catch {
      /* ignore */
    }
  }

  async function sendPendingAudio() {
    if (sendLock.current) return;
    if (!pendingAudio && !recording && !(mediaRec.current && mediaRec.current.state !== "inactive")) return;
    const wasRecording = recording || Boolean(mediaRec.current && mediaRec.current.state !== "inactive");
    setRecording(false);
    setRecPaused(false);
    presenceApi.current?.setRecording(false, studentId || userId);
    try {
      if (wasRecording && mediaRec.current && mediaRec.current.state !== "inactive") {
        await new Promise<void>((resolve) => {
          const rec = mediaRec.current!;
          const prev = rec.onstop;
          rec.onstop = (ev) => {
            try {
              if (typeof prev === "function") (prev as (this: MediaRecorder, ev: Event) => void).call(rec, ev);
            } finally {
              resolve();
            }
          };
          try { rec.stop(); } catch { resolve(); }
        });
        await new Promise((r) => setTimeout(r, 80));
      }
      const blob =
        pendingAudio ||
        (chunks.current.length ? new Blob(chunks.current, { type: "audio/webm" }) : null);
      if (!blob || blob.size < 200) {
        cancelRec();
        return;
      }
      setPendingAudio(null);
      setPendingAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      mediaRec.current = null;
      chunks.current = [];
      const up = await uploadMessageMedia(blob, "audio/webm", `msg/${schoolId}/${userId}`);
      await sendMessage("", { url: up.url, type: "audio" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send voice note");
    }
  }

  async function onFile(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    try {
      const uploaded: string[] = [];
      let kind: "image" | "audio" | "file" = "file";
      for (const file of list) {
        const up = await uploadMessageMedia(file, file.type || "application/octet-stream", `msg/${schoolId}/${userId}`);
        uploaded.push(up.url);
        if (up.type === "image") kind = "image";
        else if (up.type === "audio") kind = "audio";
      }
      const url = uploaded.length > 1 ? JSON.stringify(uploaded) : uploaded[0];
      await sendMessage("", { url, type: kind });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    }
  }

  async function clearChat() {
    if (!rows.length) {
      setClearOpen(false);
      return;
    }
    const ids = rows.map((r) => r.id);
    const { error } = await supabase.from("student_officer_reports").delete().in("id", ids);
    if (error) {
      toast.error(error.message);
      return;
    }
    setClearOpen(false);
    setInChat(false);
    setChatMenuOpen(false);
    await qc.invalidateQueries({ queryKey: ["student-my-reports"] });
  }

  const filteredShow =
    !search.trim() ||
    (listPreview && `${listPreview.preview} ${officerNickname}`.toLowerCase().includes(search.trim().toLowerCase()));

  const showDesktopSplit = true; // layout handles lg

  const listPane = (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50 lg:bg-white">
      <div className="shrink-0 border-b border-slate-100 bg-white px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:pt-4">
        <div className="mb-2 flex items-center gap-2">
          <button type="button" onClick={() => navigate({ to: "/student" })} className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 lg:hidden" aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-extrabold text-slate-900">Messages</h1>
            <p className="text-[11px] text-slate-500">Contact your departmental officer</p>
          </div>
        </div>
        <Button type="button" className="h-11 w-full rounded-xl bg-[#2563eb] font-bold hover:bg-[#1d4ed8]" onClick={() => setComposeOpen(true)}>
          + New Message
        </Button>
        <div className="mt-3 flex gap-1 rounded-full bg-slate-100 p-1">
          {([
            { k: "inbox" as const, label: "Inbox", count: inboxUnread },
            { k: "sent" as const, label: "Sent" },
            { k: "all" as const, label: "All" },
          ] as const).map((t) => (
            <button key={t.k} type="button" onClick={() => setTab(t.k)} className={cn("flex flex-1 items-center justify-center gap-1 rounded-full py-2 text-xs font-bold", tab === t.k ? "bg-[#2563eb] text-white" : "text-slate-600")}>
              {t.label}
              {"count" in t && t.count > 0 ? <span className="grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] text-white">{t.count > 99 ? "99+" : t.count}</span> : null}
            </button>
          ))}
        </div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search messages…" className="h-10 rounded-xl bg-slate-50 pl-9" />
        </div>
      </div>
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {listPreview && filteredShow && (tab !== "inbox" || inboxUnread > 0 || rows.some((r) => r.officer_reply)) ? (
          <li>
            <button
              type="button"
              onClick={() => {
                setInChat(true);
                setComposeOpen(false);
              }}
              className={cn(
                "flex w-full items-start gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-blue-200 hover:shadow-md",
                inChat && "border-blue-300 ring-2 ring-blue-100",
              )}
            >
              <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#0b1b3a] text-white">
                <User className="h-5 w-5" />
                <span className={cn("absolute bottom-0.5 right-0.5 h-3 w-3 rounded-full border-2 border-white", officerOnline ? "bg-emerald-400" : "bg-slate-300")} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2">
                  <p className="truncate text-sm font-bold text-slate-900">{officerNickname}</p>
                  <span className="shrink-0 text-[10px] font-medium text-slate-400">{formatWhen(listPreview.at)}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="line-clamp-1 min-w-0 flex-1 text-xs text-slate-500">
                    {officerRecording
                      ? "🎤 Recording…"
                      : officerTyping
                        ? "Typing…"
                        : listPreview.preview || "Conversation"}
                  </p>
                  <span className="flex shrink-0 items-center gap-1">
                    {listPreview.isOut && listPreview.tick !== "none" ? (
                      listPreview.tick === "read" ? (
                        <CheckCheck className="h-3.5 w-3.5 text-[#2563eb]" />
                      ) : listPreview.tick === "sent" ? (
                        <Check className="h-3.5 w-3.5 text-slate-400" />
                      ) : (
                        <CheckCheck className="h-3.5 w-3.5 text-slate-400" />
                      )
                    ) : null}
                    {listPreview.unread > 0 ? (
                      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                        {listPreview.unread > 99 ? "99+" : listPreview.unread}
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            </button>
          </li>
        ) : (
          <li className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-12 text-center text-sm text-slate-500">No messages yet. Tap New Message.</li>
        )}
      </ul>
    </div>
  );

  const schoolLogoUrl = (student as { schoolLogoUrl?: string | null; logoUrl?: string | null } | null | undefined)?.schoolLogoUrl
    || (student as { logoUrl?: string | null } | null | undefined)?.logoUrl
    || null;
  const schoolName = (student as { schoolName?: string | null } | null | undefined)?.schoolName || null;

  const chatPane = inChat ? (
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col select-none" style={{ background: "linear-gradient(180deg, #f0f7ff 0%, #f8fafc 40%, #eef6ff 100%)" }}>
      {/* School logo watermark — soft, non-interactive */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center overflow-hidden">
        {schoolLogoUrl ? (
          <img
            src={schoolLogoUrl}
            alt=""
            className="h-[min(55vh,420px)] w-auto max-w-[70%] select-none object-contain opacity-[0.08]"
            style={{ filter: "grayscale(1) brightness(0.95)" }}
            loading="eager"
            decoding="async"
          />
        ) : (
          <img
            src="/logo.png"
            alt=""
            className="h-[min(55vh,420px)] w-auto max-w-[70%] select-none object-contain opacity-[0.07]"
            style={{ filter: "grayscale(1) brightness(0.9)" }}
            loading="eager"
            decoding="async"
          />
        )}
      </div>
      <div className="relative z-30 flex shrink-0 items-center gap-3 border-b border-white/10 bg-[#0b1b3a] px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white lg:pt-3">
        <button type="button" onClick={() => setInChat(false)} className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 lg:hidden">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <span className="relative grid h-10 w-10 place-items-center rounded-full bg-white/15 ring-2 ring-white/90 shadow-md">
          <User className="h-5 w-5 text-white" />
          <span className={cn("absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white", officerOnline ? "bg-emerald-400" : "bg-slate-300")} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{officerNickname}</p>
          <p className={cn("text-[11px] font-medium", officerOnline ? "text-emerald-600" : "text-slate-400")}>
            {officerRecording
              ? "Recording…"
              : officerTyping
                ? "Typing…"
                : officerOnline
                  ? "Online"
                  : lastSeenLabel(officerLastSeen)}
          </p>
        </div>
        <div className="relative">
          <button type="button" className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10" onClick={() => setChatMenuOpen((v) => !v)} aria-label="Chat actions">
            <span className="text-lg leading-none">⋮</span>
          </button>
          {chatMenuOpen ? (
            <div className="absolute right-0 z-[70] mt-1 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
              <button type="button" className="block w-full px-3 py-2.5 text-left text-sm hover:bg-slate-50" onClick={() => { setRenameVal(officerNickname); setRenameOpen(true); setChatMenuOpen(false); }}>Rename</button>
              <button type="button" className="block w-full px-3 py-2.5 text-left text-sm text-red-600 hover:bg-red-50" onClick={() => { setClearOpen(true); setChatMenuOpen(false); }}>Clear chat</button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="relative z-10 min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {chatMessages.map((m) => {
          const tick =
            m.side === "out"
              ? ticksFor({
                  isMine: true,
                  createdAt: m.at,
                  peerOnline: true,
                  peerReadAt: maxOfficerRead,
                })
              : "none";
          const startLP = () => {
            if (longPressTimer.current) clearTimeout(longPressTimer.current);
            longPressTimer.current = setTimeout(() => setMenuMsg(m), 480);
          };
          const endLP = () => {
            if (longPressTimer.current) clearTimeout(longPressTimer.current);
          };
          const outTick = tick === "read" ? "read" : tick === "none" ? "none" : "delivered";
          const hasContent =
            Boolean(m.attachment_url) ||
            (Boolean(m.text) && m.text.trim() !== "" && m.text.trim() !== "(attachment)");
          if (!hasContent) return null;
          const dx = swipeDx[m.key] || 0;
          const replyArmed = dx > 48;
          return (
            <div
              key={m.key}
              className={cn(
                "relative flex w-full select-none",
                m.side === "out" ? "justify-end" : "justify-start gap-2",
                highlightKey === m.key && "z-10",
              )}
              onCopy={(e) => e.preventDefault()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {/* Reply affordance revealed while dragging */}
              <div
                className={cn(
                  "pointer-events-none absolute left-2 top-1/2 z-0 flex -translate-y-1/2 items-center transition-opacity",
                  replyArmed ? "opacity-100" : "opacity-0",
                )}
                aria-hidden
              >
                <span className="grid h-8 w-8 place-items-center rounded-full bg-[#2563eb] text-white shadow">
                  <Reply className="h-4 w-4" />
                </span>
              </div>
              <div
                className={cn(
                  "relative z-[1] flex max-w-full touch-pan-y will-change-transform",
                  m.side === "out" ? "justify-end" : "justify-start gap-2",
                  highlightKey === m.key && "rounded-2xl ring-2 ring-[#2563eb] ring-offset-2",
                )}
                style={{ transform: `translateX(${Math.min(Math.max(dx, 0), 72)}px)`, transition: dx === 0 ? "transform 0.2s ease-out" : "none" }}
                onTouchStart={(e) => {
                  swipeRef.current = { key: m.key, id: m.reportId, x: e.touches[0]?.clientX ?? 0 };
                  startLP();
                }}
                onTouchMove={(e) => {
                  endLP();
                  const s = swipeRef.current;
                  if (!s || s.key !== m.key) return;
                  const x = e.touches[0]?.clientX ?? 0;
                  const next = Math.min(Math.max(x - s.x, 0), 72);
                  setSwipeDx((prev) => (prev[m.key] === next ? prev : { ...prev, [m.key]: next }));
                }}
                onTouchEnd={(e) => {
                  endLP();
                  const s = swipeRef.current;
                  swipeRef.current = null;
                  const finalDx = swipeDx[m.key] || 0;
                  setSwipeDx((prev) => {
                    const n = { ...prev };
                    delete n[m.key];
                    return n;
                  });
                  if (!s) return;
                  const x = e.changedTouches[0]?.clientX ?? 0;
                  if (x - s.x > 56 || finalDx > 48) {
                    setReplyTo({
                      id: m.reportId,
                      text: (m.text && m.text !== "(attachment)" ? m.text : attachmentLabel(m.attachment_type, m.attachment_url)).slice(0, 120),
                      fromSelf: m.side === "out",
                    });
                  }
                }}
                onTouchCancel={() => {
                  endLP();
                  swipeRef.current = null;
                  setSwipeDx((prev) => {
                    const n = { ...prev };
                    delete n[m.key];
                    return n;
                  });
                }}
                onMouseDown={startLP}
                onMouseUp={endLP}
                onMouseLeave={endLP}
              >
              {m.side === "in" ? (
                <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#0b1b3a] text-white">
                  <User className="h-3.5 w-3.5" />
                </span>
              ) : null}
              {m.attachment_type === "audio" && m.attachment_url ? (
                <VoiceBubble id={`msg-${m.key}`} src={m.attachment_url} mine={m.side === "out"} timeLabel={formatTime(m.at)} tick={m.side === "out" ? outTick : "none"} />
              ) : (m.attachment_type === "image" || m.attachment_type === "images") && m.attachment_url ? (
                (() => {
                  const urls = parseMediaUrls(m.attachment_url);
                  return (
                    <ImageBubble
                      id={`msg-${m.key}`}
                      src={urls[0]}
                      count={urls.length}
                      mine={m.side === "out"}
                      timeLabel={formatTime(m.at)}
                      tick={m.side === "out" ? outTick : "none"}
                      onOpen={() => setLightboxSrc(JSON.stringify(urls))}
                    />
                  );
                })()
              ) : (m.attachment_type === "video" || m.attachment_type === "videos") && m.attachment_url ? (
                <VideoBubble id={`msg-${m.key}`} src={parseMediaUrls(m.attachment_url)[0]} mine={m.side === "out"} timeLabel={formatTime(m.at)} tick={m.side === "out" ? outTick : "none"} onOpen={() => setVideoLightboxSrc(parseMediaUrls(m.attachment_url)[0])} />
              ) : m.attachment_type === "file" && m.attachment_url ? (
                <FileBubble id={`msg-${m.key}`} src={m.attachment_url} mine={m.side === "out"} timeLabel={formatTime(m.at)} tick={m.side === "out" ? outTick : "none"} />
              ) : (
                <div
                  id={`msg-${m.key}`}
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm",
                    m.side === "out" ? "rounded-br-md border border-slate-200 bg-white text-slate-800" : "rounded-bl-md bg-[#2563eb] text-white",
                  )}
                >
                  {m.replyPreview ? (
                    <button
                      type="button"
                      className={cn("mb-1.5 w-full rounded-lg border-l-2 px-2 py-1 text-left text-[11px]", m.side === "out" ? "border-blue-400 bg-slate-50 text-slate-600" : "border-white/50 bg-white/15 text-blue-50")}
                      onClick={() => {
                        if (m.replyToKey) {
                          const el = document.getElementById(`msg-${m.replyToKey}`);
                          if (el) {
                            el.scrollIntoView({ behavior: "smooth", block: "center" });
                            setHighlightKey(m.replyToKey);
                            window.setTimeout(() => setHighlightKey(null), 1600);
                            return;
                          }
                        }
                        const parentId = (rows.find((r) => r.id === m.reportId)?.reply_to_id) || m.reportId;
                        scrollToMessage(parentId);
                      }}
                    >
                      {m.replyPreview.slice(0, 100)}
                    </button>
                  ) : null}
{m.text && m.text !== "(attachment)" ? <p className="whitespace-pre-wrap break-words">{m.text}</p> : null}
                  <p className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", m.side === "out" ? "text-slate-400" : "text-blue-100")}>
                    {formatTime(m.at)}
                    {m.side === "out" ? <Ticks state={outTick === "none" ? "delivered" : outTick} /> : null}
                  </p>
                </div>
              )}
              </div>
            </div>
          );
        })}
        {officerTyping ? <p className="text-center text-xs text-slate-500">Officer is typing…</p> : null}
        <div ref={chatEndRef} />
      </div>
      <div className="relative z-10 shrink-0 border-t border-white/10 bg-[#0b1b3a] px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-white">
        {replyTo ? (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#0b1b3a] text-white">
              <User className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold text-blue-800">{replyTo.fromSelf ? "You" : officerNickname}</p>
              <p className="line-clamp-2 text-xs text-slate-700">{replyTo.text}</p>
            </div>
            <button type="button" onClick={() => setReplyTo(null)} className="text-slate-400" aria-label="Cancel reply">
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        {pendingAttach ? (
          <div className="mb-2 flex items-center gap-2 rounded-xl border bg-slate-50 px-3 py-2 text-xs">
            {pendingAttach.type === "image" ? <img src={pendingAttach.url} alt="" className="h-12 w-12 rounded object-cover" /> : <span>Attachment ready</span>}
            <button type="button" onClick={() => setPendingAttach(null)} className="ml-auto text-slate-500">
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        {recording || pendingAudio || pendingAudioUrl ? (
          <VoiceRecorderBar
            recording={recording}
            paused={recPaused}
            seconds={recSecs}
            previewUrl={pendingAudioUrl}
            onCancel={() => {
              cancelRec();
              if (pendingAudioUrl) {
                URL.revokeObjectURL(pendingAudioUrl);
                setPendingAudioUrl(null);
              }
              setPendingAudio(null);
            }}
            onPause={() => {
              try {
                if (mediaRec.current && mediaRec.current.state === "recording") {
                  mediaRec.current.pause();
                  setRecPaused(true);
                  const blob = new Blob(chunks.current, { type: "audio/webm" });
                  if (blob.size >= 200) {
                    setPendingAudio(blob);
                    setPendingAudioUrl((prev) => {
                      if (prev) URL.revokeObjectURL(prev);
                      return URL.createObjectURL(blob);
                    });
                  }
                }
              } catch { /* ignore */ }
            }}
            onContinue={() => {
              try {
                if (mediaRec.current && mediaRec.current.state === "paused") {
                  mediaRec.current.resume();
                  setRecPaused(false);
                }
              } catch { /* ignore */ }
            }}
            onPreviewPlay={() => {
              if (!pendingAudioUrl) return;
              const a = new Audio(pendingAudioUrl);
              void a.play().catch(() => {});
            }}
            onSend={() => {
              void sendPendingAudio();
            }}
          />
        ) : null}
        <input ref={fileRef} type="file" accept="image/*,video/*,.pdf,.doc,.docx" multiple className="hidden" onChange={(e) => { const fs = e.target.files; if (fs?.length) void onFile(fs); e.target.value = ""; }} />
        <div className="flex items-end gap-1.5">
          <button type="button" className="mb-1 grid h-9 w-9 place-items-center rounded-full text-white/90 hover:bg-white/10" onClick={() => fileRef.current?.click()} aria-label="Attach file">
            <Paperclip className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-end rounded-full border border-white/20 bg-white px-3">
            <textarea value={replyText} onChange={(e) => onTyping(e.target.value)} rows={1} placeholder="Type your message…" className="max-h-24 min-h-[36px] w-full resize-none bg-transparent py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400" />
          </div>
          {replyText.trim() || pendingAttach ? (
            <button type="button" disabled={sending} onClick={() => void sendMessage(replyText, pendingAttach)} className="mb-0.5 grid h-10 w-10 place-items-center rounded-full bg-[#2563eb] text-white" aria-label="Send">
              <Send className="h-4 w-4" />
            </button>
          ) : (
            <button type="button" className={cn("mb-0.5 grid h-10 w-10 place-items-center rounded-full shadow-md", recording || pendingAudio || pendingAudioUrl ? "bg-[#2563eb] text-white ring-2 ring-white/40" : "bg-white text-[#0b1b3a] ring-2 ring-white/70")} onClick={() => (recording || pendingAudio || pendingAudioUrl ? void sendPendingAudio() : void startRec())} aria-label={recording || pendingAudio || pendingAudioUrl ? "Send voice note" : "Record voice"}>
              {recording || pendingAudio || pendingAudioUrl ? <Send className="h-5 w-5" /> : <Mic className="h-5 w-5 stroke-[2.5]" />}
            </button>
          )}
        </div>
      </div>
    </div>
  ) : (
    <div className="hidden flex-1 flex-col items-center justify-center gap-2 p-8 text-center lg:flex">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-slate-100 text-slate-400">
        <User className="h-8 w-8" />
      </span>
      <p className="text-sm font-semibold text-slate-700">Select a conversation</p>
      <p className="max-w-xs text-xs text-slate-500">Choose a message on the left, or start a new one.</p>
    </div>
  );

  return (
    <div className="flex h-dvh max-h-dvh flex-col bg-white lg:flex-row">
      {/* List — full on mobile when not in chat; left column on desktop */}
      <div
        className={cn(
          "flex h-full min-h-0 flex-col bg-white",
          (inChat || composeOpen) ? "hidden lg:flex" : "flex w-full flex-1",
          "lg:w-[min(var(--list-pct),55%)] lg:min-w-[280px] lg:max-w-[55%] lg:flex-none lg:border-r lg:border-slate-200",
        )}
        style={{ ["--list-pct"]: `${listPct}%` } as Record<string, string>}
      >
        {listPane}
      </div>

      <SplitHandle
        className="hidden lg:flex"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          dragRef.current = { startX: e.clientX, startPct: listPct };
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const parent = e.currentTarget.parentElement?.clientWidth || window.innerWidth;
          const dx = e.clientX - dragRef.current.startX;
          setListPct(Math.min(58, Math.max(20, dragRef.current.startPct + (dx / parent) * 100)));
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
      />

      <div className={cn("flex h-full min-h-0 w-full min-w-0 flex-1 flex-col", !inChat && !composeOpen && "hidden lg:flex")}>
        {composeOpen ? (
          <div className="flex min-h-0 flex-1 flex-col bg-white">
            <div className="flex items-center gap-2 border-b px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
              <button type="button" onClick={() => setComposeOpen(false)} className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <h2 className="font-extrabold">New Message</h2>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              <div>
                <label className="text-xs font-bold uppercase text-slate-500">Examination(s)</label>
                <button type="button" onClick={() => setPickerOpen((o) => !o)} className="mt-1 flex h-11 w-full items-center justify-between rounded-xl border px-3 text-sm">
                  <span className="truncate">{selectedTitles.length ? selectedTitles.join(", ") : "Select examination(s)…"}</span>
                  <Search className="h-4 w-4 text-slate-400" />
                </button>
                {pickerOpen ? (
                  <div className="mt-2 rounded-xl border shadow-lg">
                    <Input value={examSearch} onChange={(e) => setExamSearch(e.target.value)} placeholder="Search…" className="border-0" />
                    <ul className="max-h-40 overflow-y-auto">
                      {filteredExams.map((e) => {
                        const on = selectedExamIds.includes(e.id);
                        return (
                          <li key={e.id}>
                            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => setSelectedExamIds((p) => (on ? p.filter((x) => x !== e.id) : [...p, e.id]))}>
                              <span className={cn("grid h-5 w-5 place-items-center rounded border", on && "bg-blue-600 text-white")}>{on ? <Check className="h-3 w-3" /> : null}</span>
                              {e.title}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <Button size="sm" className="m-2" onClick={() => setPickerOpen(false)}>Done</Button>
                  </div>
                ) : null}
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-slate-500">Subject</label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1 h-11 rounded-xl" placeholder="Subject" />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-slate-500">Message</label>
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="mt-1 min-h-[120px] rounded-xl" placeholder="Write your message…" />
              </div>
            </div>
            <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button className="h-12 w-full rounded-xl bg-[#2563eb] font-bold" disabled={sending || !body.trim()} onClick={() => void sendMessage(body, pendingAttach)}>
                <Send className="mr-2 h-4 w-4" /> Send
              </Button>
            </div>
          </div>
        ) : (
          chatPane
        )}
      </div>

      {/* Branded rename dialog */}
      {renameOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-extrabold text-slate-900">Rename contact</h3>
            <p className="mt-1 text-xs text-slate-500">Choose a display name for this officer in your messages list.</p>
            <Input value={renameVal} onChange={(e) => setRenameVal(e.target.value)} className="mt-3 h-11 rounded-xl" autoFocus />
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="outline" className="flex-1 rounded-xl" onClick={() => setRenameOpen(false)}>Cancel</Button>
              <Button type="button" className="flex-1 rounded-xl bg-[#2563eb] font-bold" onClick={() => {
                const n = renameVal.trim() || "Departmental Officer";
                setOfficerNickname(n);
                try { localStorage.setItem("d4exam.msg.nick.officer", n); } catch { /* ignore */ }
                setRenameOpen(false);
              }}>Save</Button>
            </div>
          </div>
        </div>
      ) : null}

      {videoLightboxSrc ? (
        <VideoLightbox src={videoLightboxSrc} onClose={() => setVideoLightboxSrc(null)} />
      ) : null}
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
      <LongPressMenu
        open={Boolean(menuMsg)}
        onClose={() => setMenuMsg(null)}
        items={
          menuMsg
            ? [
                ...(menuMsg.text && menuMsg.text !== "(attachment)"
                  ? [{
                      label: "Copy",
                      onClick: () => {
                        void navigator.clipboard?.writeText(menuMsg.text).catch(() => {});
                      },
                    }]
                  : []),
                ...(menuMsg.side === "out" && menuMsg.text && menuMsg.text !== "(attachment)"
                  ? [{ label: "Edit", icon: "edit" as const, onClick: () => { setEditText(menuMsg.text); setEditOpen(true); } }]
                  : []),
                ...(menuMsg.attachment_url
                  ? [{
                      label: menuMsg.attachment_type === "audio" ? "Save voice note" : "Save media",
                      icon: "download" as const,
                      onClick: () => {
                        const a = document.createElement("a");
                        a.href = menuMsg.attachment_url!;
                        a.download = menuMsg.attachment_type === "audio" ? "voice-note.webm" : "photo.jpg";
                        a.click();
                      },
                    }]
                  : []),
                {
                  label: "Delete for me",
                  icon: "delete" as const,
                  danger: true,
                  onClick: () => {
                    try {
                      const key = "d4exam.msg.hidden";
                      const prev = JSON.parse(localStorage.getItem(key) || "[]") as string[];
                      localStorage.setItem(key, JSON.stringify([...new Set([...prev, menuMsg.key])]));
                    } catch { /* ignore */ }
                    void qc.invalidateQueries({ queryKey: ["student-my-reports"] });
                  },
                },
                ...(menuMsg.side === "out"
                  ? [{
                      label: "Delete for everyone",
                      icon: "delete" as const,
                      danger: true,
                      onClick: () => {
                        void supabase.from("student_officer_reports").delete().eq("id", menuMsg.reportId).then(() =>
                          qc.invalidateQueries({ queryKey: ["student-my-reports"] }),
                        );
                      },
                    }]
                  : []),
              ]
            : []
        }
      />
      {editOpen && menuMsg ? (
        <div className="fixed inset-0 z-[86] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-extrabold">Edit message</h3>
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="mt-3 min-h-[100px] w-full rounded-xl border p-3 text-sm" />
            <div className="mt-3 flex gap-2">
              <Button variant="outline" className="flex-1 rounded-xl" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button className="flex-1 rounded-xl bg-[#2563eb] font-bold" onClick={() => {
                void supabase.from("student_officer_reports").update({ body: editText.trim() } as never).eq("id", menuMsg.reportId).then(() => {
                  setEditOpen(false);
                  setMenuMsg(null);
                  void qc.invalidateQueries({ queryKey: ["student-my-reports"] });
                });
              }}>Save</Button>
            </div>
          </div>
        </div>
      ) : null}
      {clearOpen ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-extrabold text-slate-900">Clear this chat?</h3>
            <p className="mt-1 text-xs text-slate-500">All messages in this conversation will be deleted. This cannot be undone.</p>
            <div className="mt-4 flex gap-2">
              <Button type="button" variant="outline" className="flex-1 rounded-xl" onClick={() => setClearOpen(false)}>Cancel</Button>
              <Button type="button" className="flex-1 rounded-xl bg-red-600 font-bold hover:bg-red-700" onClick={() => void clearChat()}>Clear chat</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
