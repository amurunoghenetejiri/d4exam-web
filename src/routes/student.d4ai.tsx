import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  FileText,
  Loader2,
  Menu,
  Mic,
  Paperclip,
  Pause,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { d4aiChat } from "@/lib/d4ai.server";
import { cn } from "@/lib/utils";
import { appNavigate } from "@/lib/app-navigate";
import { useSessionUser } from "@/lib/session";
import {
  D4AiConnectionsSheet,
  isD4AiOwner,
  readGithubToken,
} from "@/components/d4ai/D4AiConnections";

export const Route = createFileRoute("/student/d4ai")({
  ssr: false,
  head: () => ({ meta: [{ title: "D4AI — D4TECH" }] }),
  component: D4AiPage,
});

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  imagePreview?: string;
  docName?: string;
};
type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Msg[];
};

const STORE_KEY = "d4ai_conversations_v1";
const ACTIVE_KEY = "d4ai_active_id_v1";
const LOGO = "/d4ai-logo.png";
const AVATAR = "/d4ai-avatar.png";
const WELCOME: Msg = {
  id: "welcome",
  role: "assistant",
  content:
    "Hello, Boss! 👋\n\nI'm D4AI, your all-round AI assistant.\nI'm here to help you with anything you need — from learning and research to coding, cybersecurity, and more.\nJust type a message, or use the mic to talk.\nLet's get started! 🚀",
};

function loadStore(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveStore(list: Conversation[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {}
}
function newId() {
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function compressImage(file: File, maxSide = 1280): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function extractPdfText(file: File): Promise<string> {
  try {
    const pdfjs = await import("pdfjs-dist");
    // @ts-expect-error worker
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const maxPages = Math.min(doc.numPages, 8);
    const parts: string[] = [];
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const line = tc.items
        .map((it) => ("str" in it ? String((it as { str: string }).str) : ""))
        .join(" ");
      if (line.trim()) parts.push(line.trim());
    }
    return parts.join("\n\n").slice(0, 18000);
  } catch {
    return "";
  }
}

async function ocrImageDataUrl(dataUrl: string): Promise<string> {
  try {
    const { runImageOcr } = await import("@/lib/material-ocr");
    const blob = await (await fetch(dataUrl)).blob();
    return (await runImageOcr(blob)).slice(0, 8000);
  } catch {
    return "";
  }
}

function LiveWave({ active }: { active: boolean }) {
  const heights = [6, 10, 14, 18, 12, 8, 16, 20, 14, 9, 13, 19, 11, 7, 15, 17, 12, 8, 14, 18, 10, 6, 12, 16];
  return (
    <div className="flex h-7 w-full max-w-[220px] items-center justify-center gap-[2px]">
      {heights.map((h, i) => (
        <span
          key={i}
          className={cn("w-[3px] rounded-full bg-[#3b82f6]", active && "animate-pulse")}
          style={{
            height: active ? `${h}px` : "6px",
            opacity: active ? 0.55 + (i % 5) * 0.08 : 0.35,
            animationDelay: active ? `${(i % 8) * 70}ms` : undefined,
            animationDuration: "0.9s",
          }}
        />
      ))}
    </div>
  );
}

function VoiceSttBar({
  liveText,
  seconds,
  paused,
  onCancel,
  onPause,
  onResume,
  onSend,
}: {
  liveText: string;
  seconds: number;
  paused: boolean;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
  onSend: () => void;
}) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return (
    <div className="mx-auto mb-0 w-full max-w-2xl select-none rounded-xl border border-blue-200/80 bg-gradient-to-b from-[#eff6ff] to-white px-3 py-2.5 shadow-sm">
      <div className="mb-2 flex flex-col items-center gap-1">
        <LiveWave active={!paused} />
        <p className="text-sm font-bold tabular-nums text-slate-800">
          {mm}:{ss}
        </p>
        {paused ? <p className="text-[10px] font-medium text-slate-500">Paused</p> : null}
        <p className="max-h-14 w-full overflow-y-auto text-center text-[12px] leading-snug text-slate-600">
          {liveText || (paused ? "Paused — tap Resume or Send" : "Listening… speak clearly")}
        </p>
      </div>
      <div className="flex items-center justify-center gap-4">
        <button type="button" onClick={onCancel} className="flex flex-col items-center gap-0.5 text-slate-500">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-100">
            <X className="h-4 w-4" />
          </span>
          <span className="text-[9px] font-semibold">Cancel</span>
        </button>
        {paused ? (
          <button type="button" onClick={onResume} className="flex flex-col items-center gap-0.5">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-[#2563eb] text-white shadow-md">
              <Mic className="h-5 w-5" />
            </span>
            <span className="text-[9px] font-semibold text-slate-600">Resume</span>
          </button>
        ) : (
          <button type="button" onClick={onPause} className="flex flex-col items-center gap-0.5">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-slate-800 text-white shadow-md">
              <Pause className="h-5 w-5" />
            </span>
            <span className="text-[9px] font-semibold text-slate-600">Pause</span>
          </button>
        )}
        <button type="button" onClick={onSend} className="flex flex-col items-center gap-0.5">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-[#2563eb] text-white shadow-lg ring-2 ring-blue-200">
            <Send className="h-5 w-5" />
          </span>
          <span className="text-[9px] font-bold text-[#2563eb]">Send</span>
        </button>
      </div>
    </div>
  );
}


function speakText(text: string) {
  try {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
    u.lang = "en-US";
    u.rate = 1;
    window.speechSynthesis.speak(u);
  } catch {}
}

function D4Avatar({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src={AVATAR}
      alt="D4AI"
      width={size}
      height={size}
      className={"rounded-full object-cover ring-1 ring-cyan-400/40 " + className}
      style={{ width: size, height: size }}
      onError={(e) => { (e.target as HTMLImageElement).src = LOGO; }}
    />
  );
}

function D4AiPage() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const { data: session } = useSessionUser();
  const owner = isD4AiOwner(session);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageB64, setImageB64] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [docText, setDocText] = useState<string | null>(null);
  const [docName, setDocName] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceText, setVoiceText] = useState("");
  const [voiceSecs, setVoiceSecs] = useState(0);
  const [voicePaused, setVoicePaused] = useState(false);
  const [longPress, setLongPress] = useState<Msg | null>(null);
  const [editMsg, setEditMsg] = useState<Msg | null>(null);
  const [editText, setEditText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<{ stop: () => void; start?: () => void } | null>(null);
  const voiceTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typewriterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalTranscriptRef = useRef("");
  const voicePausedRef = useRef(false);

  useEffect(() => {
    const list = loadStore();
    let id = localStorage.getItem(ACTIVE_KEY);
    if (!list.length) {
      const c: Conversation = { id: newId(), title: "New chat", updatedAt: Date.now(), messages: [WELCOME] };
      setConversations([c]);
      setActiveId(c.id);
      saveStore([c]);
      localStorage.setItem(ACTIVE_KEY, c.id);
      return;
    }
    if (!id || !list.find((c) => c.id === id)) id = list[0].id;
    setConversations(list);
    setActiveId(id);
  }, []);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);
  const messages = active?.messages ?? [WELCOME];

  const persist = useCallback((list: Conversation[], id: string | null) => {
    setConversations(list);
    saveStore(list);
    if (id) {
      setActiveId(id);
      localStorage.setItem(ACTIVE_KEY, id);
    }
  }, []);

  const updateActiveMessages = useCallback(
    (next: Msg[] | ((prev: Msg[]) => Msg[])) => {
      if (!activeId) return;
      setConversations((prev) => {
        const list = prev.map((c) => {
          if (c.id !== activeId) return c;
          const msgs = typeof next === "function" ? next(c.messages) : next;
          const firstUser = msgs.find((m) => m.role === "user");
          const title = firstUser?.content?.slice(0, 40) || firstUser?.docName || c.title || "Chat";
          return { ...c, messages: msgs, title, updatedAt: Date.now() };
        });
        saveStore(list);
        return list;
      });
    },
    [activeId],
  );

  const scrollDown = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 40);

  const startNewChat = () => {
    const c: Conversation = { id: newId(), title: "New chat", updatedAt: Date.now(), messages: [WELCOME] };
    persist([c, ...conversations].slice(0, 30), c.id);
    setDrawer(false);
    setError(null);
  };

  const deleteChat = (id: string) => {
    const list = conversations.filter((c) => c.id !== id);
    if (!list.length) {
      const c: Conversation = { id: newId(), title: "New chat", updatedAt: Date.now(), messages: [WELCOME] };
      persist([c], c.id);
    } else {
      persist(list, id === activeId ? list[0].id : activeId);
    }
  };

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    if (file.type.startsWith("image/")) {
      setStatus("Preparing image…");
      try {
        const dataUrl = await compressImage(file);
        setImagePreview(dataUrl);
        setImageB64(dataUrl);
      } finally {
        setStatus(null);
      }
      return;
    }
    const name = file.name;
    setStatus("Reading document…");
    try {
      if (file.type === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
        const text = await extractPdfText(file);
        setDocName(name);
        setDocText(
          text.trim().length > 20
            ? text
            : `[PDF "${name}" had little extractable text. Try a clearer PDF or photo of pages.]`,
        );
      } else {
        setDocName(name);
        setDocText((await file.text()).slice(0, 18000));
      }
    } finally {
      setStatus(null);
    }
  };

  const sendWithText = useCallback(
    async (text: string, opts?: { imgs?: string[]; dText?: string; dName?: string }) => {
      if (busy) return;
      const body = text.trim();
      const imgs = opts?.imgs;
      let dText = opts?.dText;
      const dName = opts?.dName;
      if (!body && !imgs?.length && !dText) return;

      setError(null);
      setBusy(true);
      setStatus(null);
      const userMsg: Msg = {
        id: `u-${Date.now()}`,
        role: "user",
        content:
          body ||
          (imgs?.length ? "Please analyse this image." : `Please use this document: ${dName}`),
        imagePreview: imgs?.[0],
        docName: dName || undefined,
      };
      updateActiveMessages((m) => [...m.filter((x) => x.id !== "welcome"), userMsg]);
      scrollDown();

      if (imgs?.[0] && !dText) {
        setStatus("Reading text from image…");
        const ocr = await ocrImageDataUrl(imgs[0]);
        if (ocr && ocr.replace(/\s/g, "").length > 12) dText = ocr;
        setStatus(null);
      }

      const history = [...(active?.messages ?? []), userMsg]
        .filter((m) => m.id !== "welcome")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      try {
        const ghToken = readGithubToken();
        const res = await d4aiChat({
          data: {
            messages: history.length ? history : [{ role: "user", content: userMsg.content }],
            images: dText ? undefined : imgs,
            documentText: dText,
            documentName: dName || (imgs ? "image-ocr.txt" : undefined),
            githubToken: ghToken || undefined,
            enableGithubTools: Boolean(owner && ghToken),
          },
        });
        if (!res.ok) {
          setError(res.error);
          updateActiveMessages((m) => [
            ...m,
            { id: `e-${Date.now()}`, role: "assistant", content: res.error || "Something went wrong." },
          ]);
        } else {
          const full = res.content || "";
          const aid = `a-${Date.now()}`;
          updateActiveMessages((m) => [...m, { id: aid, role: "assistant", content: "" }]);
          let i = 0;
          const step = Math.max(2, Math.ceil(full.length / 140));
          if (typewriterRef.current) clearInterval(typewriterRef.current);
          typewriterRef.current = setInterval(() => {
            i = Math.min(full.length, i + step);
            updateActiveMessages((list) =>
              list.map((x) => (x.id === aid ? { ...x, content: full.slice(0, i) } : x)),
            );
            scrollDown();
            if (i >= full.length) {
              if (typewriterRef.current) clearInterval(typewriterRef.current);
              typewriterRef.current = null;
            }
          }, 16);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to reach D4AI";
        setError(msg);
        updateActiveMessages((m) => [
          ...m,
          { id: `e-${Date.now()}`, role: "assistant", content: msg },
        ]);
      } finally {
        setBusy(false);
        setStatus(null);
        scrollDown();
      }
    },
    [busy, active?.messages, updateActiveMessages, owner],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    const imgs = imageB64 ? [imageB64] : undefined;
    const dText = docText || undefined;
    const dName = docName || undefined;
    setInput("");
    setImageB64(null);
    setImagePreview(null);
    setDocText(null);
    setDocName(null);
    await sendWithText(text, { imgs, dText, dName });
  }, [input, imageB64, docText, docName, sendWithText]);

  const stopVoice = (clearText = true) => {
    try {
      recognitionRef.current?.stop();
    } catch {}
    recognitionRef.current = null;
    if (voiceTimer.current) clearInterval(voiceTimer.current);
    voiceTimer.current = null;
    setVoiceOn(false);
    setVoicePaused(false);
    voicePausedRef.current = false;
    if (clearText) {
      setVoiceText("");
      finalTranscriptRef.current = "";
    }
  };

  const startVoice = () => {
    const w = window as unknown as {
      SpeechRecognition?: new () => any;
      webkitSpeechRecognition?: new () => any;
    };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      setError("Voice needs Chrome or a supported browser. Allow microphone access.");
      return;
    }
    stopVoice(true);
    setVoiceSecs(0);
    const rec = new SR();
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = "en-US";
    rec.onresult = (ev: any) => {
      let interim = "";
      let finalPart = finalTranscriptRef.current;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const piece = String(r[0]?.transcript || "").replace(/\s+/g, " ").trim();
        if (!piece) continue;
        if (r.isFinal) finalPart = (finalPart + " " + piece).trim();
        else interim = (interim + " " + piece).trim();
      }
      finalTranscriptRef.current = finalPart;
      setVoiceText([finalPart, interim].filter(Boolean).join(" ").trim());
    };
    rec.onerror = (ev: any) => {
      const err = String(ev?.error || "");
      if (err === "no-speech" || err === "aborted") return;
      if (err === "not-allowed") {
        setError("Microphone permission denied.");
        stopVoice(true);
      }
    };
    rec.onend = () => {
      if (!voicePausedRef.current && recognitionRef.current === rec) {
        try {
          rec.start();
        } catch {}
      }
    };
    try {
      rec.start();
      setVoiceOn(true);
      voiceTimer.current = setInterval(() => setVoiceSecs((x) => x + 1), 1000);
    } catch {
      setError("Could not start microphone.");
      stopVoice(true);
    }
  };

  const pauseVoice = () => {
    voicePausedRef.current = true;
    setVoicePaused(true);
    try {
      recognitionRef.current?.stop();
    } catch {}
    if (voiceTimer.current) {
      clearInterval(voiceTimer.current);
      voiceTimer.current = null;
    }
  };

  const resumeVoice = () => {
    voicePausedRef.current = false;
    setVoicePaused(false);
    try {
      recognitionRef.current?.start?.();
    } catch {
      const saved = finalTranscriptRef.current;
      startVoice();
      setTimeout(() => {
        finalTranscriptRef.current = saved;
        setVoiceText(saved);
      }, 50);
      return;
    }
    if (!voiceTimer.current) {
      voiceTimer.current = setInterval(() => setVoiceSecs((x) => x + 1), 1000);
    }
  };

  const finishVoiceAndSend = async () => {
    const text = (finalTranscriptRef.current || voiceText).trim();
    stopVoice(true);
    if (!text) return;
    await sendWithText(text);
  };

  const stopAi = () => {
    if (typewriterRef.current) {
      clearInterval(typewriterRef.current);
      typewriterRef.current = null;
    }
    setBusy(false);
    setStatus(null);
  };

  const goBack = () => {
    try {
      appNavigate(navigate, "/student");
    } catch {
      navigate({ to: "/student" });
    }
  };

  const onPressStart = (m: Msg) => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setLongPress(m), 450);
  };
  const onPressEnd = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col text-slate-100" style={{ background: "radial-gradient(ellipse at top, #0b1a3a 0%, #050b18 45%, #020617 100%)" }}>
      <header
        className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#0b1b3a] px-2 py-2.5"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <button type="button" onClick={goBack} className="rounded-xl p-2 text-white/90 hover:bg-white/10" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <D4Avatar size={36} />
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-white">D4AI</h1>
            <p className="truncate text-[11px] text-cyan-200/80">{busy ? "Typing…" : "Online · v5-Ultimate"}</p>
          </div>
        </div>
        <button type="button" onClick={() => setDrawer(true)} className="rounded-xl p-2 text-white/90 hover:bg-white/10" aria-label="Menu">
          <Menu className="h-5 w-5" />
        </button>
      </header>

      <D4AiConnectionsSheet open={connectionsOpen} onClose={() => setConnectionsOpen(false)} session={session ?? null} />

      {drawer ? (
        <div className="absolute inset-0 z-50 flex">
          <button type="button" className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} aria-label="Close" />
          <aside className="relative z-10 flex h-full w-[82%] max-w-sm flex-col bg-[#071428] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <span className="font-semibold text-white">Menu</span>
              <button type="button" onClick={() => setDrawer(false)} className="p-1 text-white/70">
                <X className="h-5 w-5" />
              </button>
            </div>
            <button type="button" onClick={startNewChat} className="m-3 flex items-center justify-center gap-2 rounded-xl bg-cyan-600 py-2.5 text-sm font-semibold text-white">
              <Plus className="h-4 w-4" /> New chat
            </button>
            {owner ? (
              <button
                type="button"
                onClick={() => {
                  setDrawer(false);
                  setConnectionsOpen(true);
                }}
                className="mx-3 mb-2 flex items-center justify-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-950/40 py-2.5 text-sm font-semibold text-cyan-200"
              >
                Add connectors
              </button>
            ) : null}
            <p className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Conversations</p>
            <div className="flex-1 overflow-y-auto px-2 pb-4">
              {conversations.map((c) => (
                <div key={c.id} className={cn("mb-1 flex items-center gap-1 rounded-xl px-2 py-2", c.id === activeId ? "bg-white/10" : "hover:bg-white/5")}>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { persist(conversations, c.id); setDrawer(false); }}>
                    <p className="truncate text-sm font-medium text-white">{c.title}</p>
                    <p className="text-[10px] text-slate-400">{new Date(c.updatedAt).toLocaleString()}</p>
                  </button>
                  <button type="button" className="rounded-lg p-2 text-slate-400 hover:text-red-400" onClick={() => deleteChat(c.id)} aria-label="Delete">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </aside>
        </div>
      ) : null}

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
        {messages.length <= 1 && messages[0]?.id === "welcome" ? (
          <div className="mx-auto mt-8 flex max-w-sm flex-col items-center text-center">
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-blue-700 shadow-xl">
              <Sparkles className="h-9 w-9 text-white" />
            </div>
            <h2 className="text-xl font-bold text-white">D4AI</h2>
            <p className="mt-1 text-sm text-cyan-100/80">Study · Build · Adapt</p>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{WELCOME.content}</p>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={cn("flex gap-2", m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "assistant" ? (
                <D4Avatar size={30} className="mt-1 shrink-0" />
              ) : null}
              <div
                role="button"
                tabIndex={0}
                onPointerDown={() => onPressStart(m)}
                onPointerUp={onPressEnd}
                onPointerLeave={onPressEnd}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setLongPress(m);
                }}
                className={cn(
                  "max-w-[85%] select-none rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed shadow",
                  m.role === "user"
                    ? "rounded-br-md bg-[#0ea5e9] text-white"
                    : "rounded-bl-md bg-[#132742] text-slate-100 ring-1 ring-white/10",
                )}
              >
                {m.imagePreview ? (
                  <img src={m.imagePreview} alt="" className="mb-2 max-h-48 w-full rounded-xl object-cover" />
                ) : null}
                {m.docName ? (
                  <p className="mb-1 flex items-center gap-1 text-xs opacity-90">
                    <FileText className="h-3.5 w-3.5" /> {m.docName}
                  </p>
                ) : null}
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            </div>
          ))
        )}
        {busy ? (
          <div className="flex w-full items-end justify-start gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-blue-600 shadow">
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-[#132742] px-3.5 py-2.5 ring-1 ring-white/10">
              <span className="d4ai-dot h-1.5 w-1.5 rounded-full bg-cyan-300" />
              <span className="d4ai-dot h-1.5 w-1.5 rounded-full bg-cyan-300" style={{ animationDelay: "0.15s" }} />
              <span className="d4ai-dot h-1.5 w-1.5 rounded-full bg-cyan-300" style={{ animationDelay: "0.3s" }} />
            </div>
          </div>
        ) : null}
        <style>{`.d4ai-dot{animation:d4ai-bounce 1s ease-in-out infinite}@keyframes d4ai-bounce{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-4px);opacity:1}}`}</style>
        {status ? (
          <p className="flex items-center gap-2 px-2 text-xs text-cyan-200/80">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {status}
          </p>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {error ? <p className="px-4 pb-1 text-xs text-amber-300">{error}</p> : null}

      {(imagePreview || docName) && !voiceOn ? (
        <div className="flex items-center gap-2 border-t border-white/10 px-3 py-2 text-xs text-slate-300">
          {imagePreview ? (
            <div className="relative">
              <img src={imagePreview} alt="" className="h-12 w-12 rounded-lg object-cover" />
              <button type="button" className="absolute -right-1 -top-1 rounded-full bg-[#0b1b3a] p-0.5" onClick={() => { setImageB64(null); setImagePreview(null); }}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          {docName ? (
            <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-1">
              <FileText className="h-3.5 w-3.5" />
              <span className="max-w-[160px] truncate">{docName}</span>
              <button type="button" onClick={() => { setDocText(null); setDocName(null); }}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-white/10 bg-[#071428] px-2 py-2" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        {voiceOn ? (
          <VoiceSttBar
            liveText={voiceText}
            seconds={voiceSecs}
            paused={voicePaused}
            onCancel={() => stopVoice(true)}
            onPause={pauseVoice}
            onResume={resumeVoice}
            onSend={() => void finishVoiceAndSend()}
          />
        ) : (
          <div className="mx-auto flex max-w-2xl items-end gap-1.5">
            <button type="button" onClick={() => fileRef.current?.click()} className="mb-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/10" aria-label="Attach">
              <Paperclip className="h-5 w-5" />
            </button>
            <input ref={fileRef} type="file" accept="image/*,.pdf,.txt,.md,.csv,application/pdf,text/plain" className="hidden" onChange={(e) => { void onPickFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Message D4AI…"
              className="max-h-28 min-h-[40px] flex-1 resize-none rounded-2xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
            />
            {busy ? (
              <button type="button" onClick={stopAi} className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full bg-rose-500 text-white shadow-lg" aria-label="Stop">
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : input.trim() || imageB64 || docText ? (
              <button type="button" onClick={() => void send()} className="mb-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#0ea5e9] text-white" aria-label="Send">
                <Send className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={startVoice}
                className={cn(
                  "mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-white shadow-lg transition active:scale-95",
                  "bg-gradient-to-b from-[#60a5fa] via-[#3b82f6] to-[#1d4ed8]",
                  "ring-2 ring-white/60 ring-offset-1 ring-offset-[#0b1b3a]",
                )}
                aria-label="Voice"
              >
                <Mic className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
      </div>

      {longPress ? (
        <div className="absolute inset-0 z-[80] flex items-end justify-center bg-black/40 p-4">
          <button type="button" className="absolute inset-0" onClick={() => setLongPress(null)} aria-label="Close" />
          <div className="relative z-10 w-full max-w-sm overflow-hidden rounded-2xl bg-[#0c2244] shadow-xl ring-1 ring-white/10">
            <button
              type="button"
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-sm text-white hover:bg-white/5"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(longPress.content);
                } catch {}
                setLongPress(null);
              }}
            >
              <Copy className="h-4 w-4 text-cyan-300" /> Copy
            </button>
            {longPress.role === "user" ? (
              <button
                type="button"
                className="flex w-full items-center gap-3 border-t border-white/10 px-4 py-3.5 text-left text-sm text-white hover:bg-white/5"
                onClick={() => {
                  setEditMsg(longPress);
                  setEditText(longPress.content);
                  setLongPress(null);
                }}
              >
                <Pencil className="h-4 w-4 text-cyan-300" /> Edit & resend
              </button>
            ) : null}
            <button type="button" className="flex w-full items-center justify-center border-t border-white/10 px-4 py-3 text-sm text-slate-400" onClick={() => setLongPress(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {editMsg ? (
        <div className="absolute inset-0 z-[90] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#0c2244] p-4 shadow-xl ring-1 ring-white/10">
            <h3 className="text-sm font-bold text-white">Edit & resend</h3>
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={4} className="mt-2 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white" />
            <div className="mt-3 flex gap-2">
              <button type="button" className="flex-1 rounded-xl bg-white/10 py-2 text-sm text-white" onClick={() => setEditMsg(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-cyan-600 py-2 text-sm font-semibold text-white"
                onClick={() => {
                  const t = editText.trim();
                  setEditMsg(null);
                  if (t) void sendWithText(t);
                }}
              >
                Resend
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
