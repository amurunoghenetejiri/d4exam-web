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
const WELCOME: Msg = {
  id: "welcome",
  role: "assistant",
  content:
    "Hey! I'm D4AI — built by Amurun Destiny under D4TECH.\n\nAsk anything, attach a file, or use the mic to talk.",
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
  const heights = [8, 14, 10, 18, 12, 20, 9, 16, 11, 19, 7, 15, 13, 17, 10, 18, 8, 14, 12, 16, 9, 15, 11, 13];
  return (
    <div className="flex h-8 w-full max-w-[240px] items-center justify-center gap-[2.5px]">
      {heights.map((h, i) => (
        <span
          key={i}
          className={cn(
            "w-[3px] rounded-full bg-[#60a5fa] transition-all duration-200",
            active && "animate-pulse",
          )}
          style={{
            height: active ? `${h}px` : "5px",
            opacity: active ? 0.5 + (i % 6) * 0.08 : 0.3,
            animationDelay: active ? `${(i % 10) * 55}ms` : undefined,
            animationDuration: "0.85s",
          }}
        />
      ))}
    </div>
  );
}

function cleanTranscript(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w, i, arr) => {
      if (!w) return false;
      if (i > 0 && w.toLowerCase() === arr[i - 1].toLowerCase()) return false;
      if (i > 1 && w.toLowerCase() === arr[i - 2].toLowerCase() && w.length > 2) return false;
      return true;
    })
    .join(" ");
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
    <div className="mx-auto w-full max-w-2xl select-none rounded-2xl border border-slate-200/90 bg-white px-3 py-3 shadow-md">
      <div className="mb-2.5 flex flex-col items-center gap-1">
        <LiveWave active={!paused} />
        <p className="text-[15px] font-bold tabular-nums tracking-wide text-slate-800">
          {mm}:{ss}
        </p>
        {paused ? (
          <p className="text-[10px] font-medium text-slate-500">Paused</p>
        ) : null}
        <p className="max-h-12 w-full overflow-y-auto px-1 text-center text-[12px] leading-snug text-slate-600">
          {liveText
            ? liveText
            : paused
              ? "Paused — tap Resume or Send"
              : "Listening… speak clearly"}
        </p>
      </div>
      <div className="flex items-center justify-center gap-5">
        <button type="button" onClick={onCancel} className="flex flex-col items-center gap-0.5 text-slate-500">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-slate-100 active:scale-95">
            <X className="h-4 w-4" />
          </span>
          <span className="text-[10px] font-semibold">Cancel</span>
        </button>
        {paused ? (
          <button type="button" onClick={onResume} className="flex flex-col items-center gap-0.5">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-[#2563eb] text-white shadow-md active:scale-95">
              <Mic className="h-5 w-5" />
            </span>
            <span className="text-[10px] font-semibold text-slate-600">Resume</span>
          </button>
        ) : (
          <button type="button" onClick={onPause} className="flex flex-col items-center gap-0.5">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-slate-900 text-white shadow-md active:scale-95">
              <Pause className="h-5 w-5" />
            </span>
            <span className="text-[10px] font-semibold text-slate-600">Pause</span>
          </button>
        )}
        <button type="button" onClick={onSend} className="flex flex-col items-center gap-0.5">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-[#2563eb] text-white shadow-lg ring-2 ring-blue-100 active:scale-95">
            <Send className="h-5 w-5" />
          </span>
          <span className="text-[10px] font-bold text-[#2563eb]">Send</span>
        </button>
      </div>
    </div>
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
  const abortRef = useRef<AbortController | null>(null);
  const voiceActiveRef = useRef(false);

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

  // NOTE: rest of component continues in next patch if needed - this is partial
  return <div className="fixed inset-0 bg-[#0b1b3a] text-white flex items-center justify-center">Loading D4AI…</div>;
}
