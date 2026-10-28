import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bell,
  CheckCheck,
  ChevronRight,
  Copy,
  Cpu,
  FileText,
  Flag,
  Globe,
  HelpCircle,
  History,
  Home,
  Image as ImageIcon,
  Info,
  Keyboard,
  Loader2,
  LogOut,
  Menu,
  MessageCircle,
  Mic,
  Moon,
  MoreVertical,
  Paperclip,
  Link2,
  Camera,
  Music2,
  Pencil,
  Phone,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Share2,
  Shield,
  Square,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
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
  validateSearch: (s: Record<string, unknown>) => ({
    from: typeof s.from === "string" ? s.from : undefined,
  }),
  head: () => ({
    meta: [
      { title: "D4AI — D4TECH" },
      { name: "description", content: "D4AI — your study companion and all-round AI assistant on D4EXAM." },
      { property: "og:title", content: "D4AI — D4TECH" },
      { property: "og:description", content: "Chat, speak, and learn with D4AI on D4EXAM." },
      { property: "og:type", content: "website" },
      { name: "theme-color", content: "#050b18" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
    ],
  }),
  component: D4AiPage,
});

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  imagePreview?: string;
  docName?: string;
  createdAt?: number;
};
type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Msg[];
};

const STORE_KEY = "d4ai_conversations_v1";
const ACTIVE_KEY = "d4ai_active_id_v1";
// Backend is only reached via same-origin /api/d4ai/chat (Vercel → Flask). Never call :11434 or :5000 from the browser.
const THEME_KEY = "d4ai_theme_v1";
const SPEAK_KEY = "d4ai_autospeak_v1";
const LOGO = "/d4ai-avatar.png";
const WELCOME_TEXT =
  "Hey! 👋 I'm D4AI — your AI buddy on D4EXAM.\n\nI'm here anytime you need help: study, code, ideas, or just figuring something out. Talk to me like a friend.\n\nIntroduce yourself and ask me anything — what's on your mind?";
const WELCOME: Msg = { id: "welcome", role: "assistant", content: WELCOME_TEXT };
const NICK_KEY = "d4ai_nickname_v1";

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
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 40)));
  } catch {}
}
function newId() {
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function fmtTime(ts?: number) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDay(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  if (same) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const yest = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
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

const VOICE_KEY = "d4ai_voice_v1";
const SILENCE_MS = 1200;

type VoicePreset =
  | "auto"
  | "rex"
  | "atlas"
  | "nova"
  | "luna"
  | "cipher"
  | "echo"
  | "kai"
  | "aria"
  | "bolt"
  | "sage"
  | "pixel"
  | "volt";

type VoiceChar = {
  id: VoicePreset;
  name: string;
  tag: string;
  emoji: string;
  /** StreamElements / similar TTS voice id */
  seVoice: string;
  rate: number;
  pitch: number;
  sample: string;
};

const VOICE_CHARS: VoiceChar[] = [
  { id: "rex", name: "Rex", tag: "Deep male · calm", emoji: "🧑", seVoice: "en-US-ChristopherNeural", rate: 0.95, pitch: 0.85, sample: "Hey, I'm Rex. Clear, calm, and ready when you are." },
  { id: "atlas", name: "Atlas", tag: "Deep bass · wise", emoji: "🧔", seVoice: "en-US-EricNeural", rate: 0.82, pitch: 0.55, sample: "I am Atlas. Deep, calm, and grounded." },
  { id: "nova", name: "Nova", tag: "Female · warm", emoji: "👩", seVoice: "en-US-JennyNeural", rate: 1.0, pitch: 1.05, sample: "Hi, I'm Nova. Warm, clear, and easy to listen to." },
  { id: "luna", name: "Luna", tag: "Female · soft", emoji: "✨", seVoice: "en-US-AriaNeural", rate: 0.92, pitch: 1.15, sample: "Hello, I'm Luna. Soft, gentle, and relaxed." },
  { id: "cipher", name: "Cipher", tag: "Robotic · AI", emoji: "🤖", seVoice: "en-US-JasonNeural", rate: 1.1, pitch: 0.45, sample: "System online. I am Cipher, your robotic assistant." },
  { id: "echo", name: "Echo", tag: "British male", emoji: "🔮", seVoice: "en-GB-RyanNeural", rate: 1.0, pitch: 0.95, sample: "Echo here. Modern AI voice, sharp and precise." },
  { id: "kai", name: "Kai", tag: "Young · energetic", emoji: "⚡", seVoice: "en-US-GuyNeural", rate: 1.15, pitch: 1.1, sample: "Kai online! Fast, sharp, and full of energy." },
  { id: "aria", name: "Aria", tag: "Female · bright", emoji: "💫", seVoice: "en-US-MichelleNeural", rate: 0.95, pitch: 1.2, sample: "I'm Aria. Soft, smooth, and a little romantic." },
  { id: "bolt", name: "Bolt", tag: "Sharp · active", emoji: "🔥", seVoice: "en-US-GuyNeural", rate: 1.2, pitch: 1.15, sample: "Bolt here — bright, energetic, let's go!" },
  { id: "sage", name: "Sage", tag: "Old wise · slow", emoji: "📚", seVoice: "en-US-EricNeural", rate: 0.78, pitch: 0.6, sample: "I am Sage. Deep, thoughtful, and measured." },
  { id: "pixel", name: "Pixel", tag: "Playful · high", emoji: "🎮", seVoice: "en-US-AnaNeural", rate: 1.22, pitch: 1.4, sample: "Hi hi! Pixel here — fun, bouncy, cartoon energy!" },
  { id: "volt", name: "Volt", tag: "Narrator · strong", emoji: "⚡", seVoice: "en-US-SteffanNeural", rate: 1.05, pitch: 0.9, sample: "Volt charged. Unlimited power. Let's build." },
];

function loadVoicePreset(): VoicePreset {
  try {
    const v = localStorage.getItem(VOICE_KEY);
    if (v && VOICE_CHARS.some((c) => c.id === v)) return v as VoicePreset;
    if (v === "male") return "rex";
    if (v === "female") return "nova";
    if (v === "deep") return "atlas";
    if (v === "soft") return "luna";
    if (v === "auto") return "rex";
  } catch {}
  return "rex";
}

function getVoiceChar(id: VoicePreset): VoiceChar {
  return VOICE_CHARS.find((c) => c.id === id) || VOICE_CHARS[0];
}

function pickVoice(preset: VoicePreset): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const en = voices.filter((v) => /en[-_]?/i.test(v.lang));
    const pool = en.length ? en : [...voices];
    const char = getVoiceChar(preset);
    const idx = Math.max(0, VOICE_CHARS.findIndex((c) => c.id === char.id));
    const female = pool.filter((v) => /female|samantha|karen|zira|amy|emma|salli|ivy|joanna|woman|girl|fiona|moira|veena|tessa/i.test(v.name));
    const male = pool.filter((v) => /male|david|daniel|mark|george|fred|brian|matthew|joey|alex|thomas|ravi|man/i.test(v.name) || !/female|samantha|karen|zira|amy|emma|salli|ivy|joanna|woman|girl/i.test(v.name));
    const preferFemale = /nova|luna|aria|pixel|echo/.test(char.id);
    const list = preferFemale ? (female.length ? female : pool) : (male.length ? male : pool);
    // Pick different voice per character index so 12 characters map across available voices
    return list[idx % list.length] || pool[idx % pool.length] || null;
  } catch {
    return null;
  }
}

let activeAudio: HTMLAudioElement | null = null;
let speakingCancelled = false;


function friendlyError(raw: string): string {
  const m = String(raw || "").toLowerCase();
  if (/failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(m)) {
    return "I'm having trouble reaching the D4AI server right now. Please check your connection and try again in a moment.";
  }
  if (/timeout|timed out|abort/i.test(m)) {
    return "That took too long on my side. Please try again — a shorter question often works better.";
  }
  if (/too_big|at most \d+ element/i.test(m)) {
    return "This chat got very long. I trimmed the history — send your question once more.";
  }
  if (m.length > 200 || /error|exception|stack/i.test(m)) {
    return "Something went wrong on my side. Please try again in a moment.";
  }
  return String(raw || "Something went wrong. Please try again.").slice(0, 220);
}

function needsLiveSearch(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t || t.length < 3) return false;
  // Never live-search pure greetings / short chat
  if (/^(hi|hello|hey|how far|good morning|good evening|good afternoon|thanks|thank you|ok|okay|yo|sup|wassup)[\s!?.]*$/i.test(t)) {
    return false;
  }
  if (/https?:\/\//i.test(text)) return true;
  if (/\b(current|today|latest|live|right now|this year|2024|2025|2026)\b/i.test(t)) return true;
  if (/\b(who is the|governor|president|minister|mayor|prime minister)\b/i.test(t)) return true;
  if (/\b(price of|how much|stock|exchange rate|news about|weather in)\b/i.test(t)) return true;
  if (/\b(itel|gsmarena|specs of|features of)\b/i.test(t) && /\b(phone|mobile|device)\b/i.test(t)) return true;
  if (/\b(when did|when was|released in)\b/i.test(t) && /\b(movie|film|album|game)\b/i.test(t)) return true;
  return false;
}
function punctuateSpeech(text: string): string {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return t;
  t = t.replace(/(^\s*\w|[.!?]\s+\w)/g, (m) => m.toUpperCase());
  if (/^(who|what|when|where|why|how|is|are|can|do|does|did|will|would|should|could)\b/i.test(t) && !/[?]$/.test(t)) {
    t = t.replace(/[.!]*$/, "") + "?";
  } else if (!/[.!?]$/.test(t)) {
    t += ".";
  }
  return t;
}

function stripForSpeech(text: string): string {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_>`\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2500);
}

function chunkSpeech(text: string, maxLen = 320): string[] {
  const parts = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if ((buf + " " + t).trim().length > maxLen) {
      if (buf) out.push(buf.trim());
      buf = t.length > maxLen ? t.slice(0, maxLen) : t;
    } else {
      buf = (buf + " " + t).trim();
    }
  }
  if (buf) out.push(buf.trim());
  return out.length ? out : [text.slice(0, maxLen)];
}

function ttsUrl(text: string, voiceId: string): string {
  return `/api/d4ai/tts?voice=${encodeURIComponent(voiceId)}&text=${encodeURIComponent(text)}`;
}

function playAudioQueue(
  urls: string[],
  opts?: { onend?: () => void; onstart?: () => void; fallbackText?: string; preset?: VoicePreset },
) {
  speakingCancelled = false;
  let started = false;
  let anyPlayed = false;
  void (async () => {
    for (const url of urls) {
      if (speakingCancelled) break;
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (blob.size < 80) continue;
        if (speakingCancelled) break;
        const obj = URL.createObjectURL(blob);
        await new Promise<void>((resolve) => {
          const audio = new Audio();
          audio.volume = 1;
          audio.src = obj;
          activeAudio = audio;
          audio.onplay = () => {
            anyPlayed = true;
            if (!started) {
              started = true;
              try {
                opts?.onstart?.();
              } catch {}
            }
          };
          audio.onended = () => {
            try {
              URL.revokeObjectURL(obj);
            } catch {}
            resolve();
          };
          audio.onerror = () => {
            try {
              URL.revokeObjectURL(obj);
            } catch {}
            resolve();
          };
          const p = audio.play();
          if (p && typeof p.catch === "function") p.catch(() => resolve());
        });
      } catch {
        /* next chunk */
      }
    }
    activeAudio = null;
    // Browser speechSynthesis fallback if audio produced nothing
    if (!anyPlayed && !speakingCancelled && opts?.fallbackText && typeof window !== "undefined" && window.speechSynthesis) {
      try {
        const u = new SpeechSynthesisUtterance(opts.fallbackText.slice(0, 1500));
        u.lang = "en-US";
        u.volume = 1;
        const char = getVoiceChar(opts.preset || loadVoicePreset());
        u.rate = char.rate;
        u.pitch = char.pitch;
        try {
          const v = pickVoice(opts.preset || loadVoicePreset());
          if (v) u.voice = v;
        } catch {}
        u.onstart = () => {
          if (!started) {
            started = true;
            try {
              opts?.onstart?.();
            } catch {}
          }
        };
        u.onend = () => {
          try {
            opts?.onend?.();
          } catch {}
        };
        u.onerror = () => {
          try {
            opts?.onend?.();
          } catch {}
        };
        window.speechSynthesis.cancel();
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(u);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      opts?.onend?.();
    } catch {}
  })();
}

function speakText(
  text: string,
  opts?: { preset?: VoicePreset; onend?: () => void; onstart?: () => void },
) {
  const clean = stripForSpeech(text);
  if (!clean) {
    try { opts?.onend?.(); } catch {}
    return;
  }

  // Stop previous speech only
  speakingCancelled = false;
  try {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = "";
      activeAudio = null;
    }
  } catch {}
  try {
    window.speechSynthesis?.cancel();
  } catch {}

  const preset = opts?.preset || loadVoicePreset();
  const char = getVoiceChar(preset);

  const finish = () => {
    try { opts?.onend?.(); } catch {}
  };
  const start = () => {
    try { opts?.onstart?.(); } catch {}
  };

  // Prefer server audio (Google TTS via proxy) — more reliable volume in WebView
  const chunks = chunkSpeech(clean, 160);
  const urls = chunks.map((c) => ttsUrl(c, char.id));

  // Run speechSynthesis in parallel as backup if audio fails; started on same tick as gesture
  let audioStarted = false;
  let synthStarted = false;
  let finished = false;
  const onceEnd = () => {
    if (finished) return;
    finished = true;
    finish();
  };

  // Kick audio queue
  void (async () => {
    for (const url of urls) {
      if (speakingCancelled || finished) break;
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (blob.size < 200) continue;
        if (speakingCancelled) break;
        // Cancel synth if audio works
        try { window.speechSynthesis?.cancel(); } catch {}
        const obj = URL.createObjectURL(blob);
        await new Promise<void>((resolve) => {
          const audio = new Audio();
          audio.volume = 1;
          audio.src = obj;
          activeAudio = audio;
          audio.onplay = () => {
            audioStarted = true;
            if (!synthStarted) start();
          };
          audio.onended = () => {
            try { URL.revokeObjectURL(obj); } catch {}
            resolve();
          };
          audio.onerror = () => {
            try { URL.revokeObjectURL(obj); } catch {}
            resolve();
          };
          const p = audio.play();
          if (p && typeof p.catch === "function") p.catch(() => resolve());
        });
      } catch {
        /* next */
      }
    }
    if (audioStarted) {
      onceEnd();
      return;
    }
    // Audio failed — use speechSynthesis
    if (speakingCancelled || finished) {
      onceEnd();
      return;
    }
    if (typeof window === "undefined" || !window.speechSynthesis) {
      onceEnd();
      return;
    }
    try {
      const ensureVoices = () =>
        new Promise<void>((resolve) => {
          const vs = window.speechSynthesis.getVoices();
          if (vs.length) {
            resolve();
            return;
          }
          const t = window.setTimeout(() => resolve(), 600);
          window.speechSynthesis.onvoiceschanged = () => {
            window.clearTimeout(t);
            resolve();
          };
        });
      await ensureVoices();
      if (speakingCancelled) {
        onceEnd();
        return;
      }
      const u = new SpeechSynthesisUtterance(clean.slice(0, 1500));
      u.lang = "en-US";
      u.volume = 1;
      u.rate = char.rate;
      u.pitch = Math.max(0.1, Math.min(2, char.pitch));
      try {
        const v = pickVoice(preset);
        if (v) u.voice = v;
      } catch {}
      u.onstart = () => {
        synthStarted = true;
        start();
      };
      u.onend = () => onceEnd();
      u.onerror = () => onceEnd();
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(u);
      // Safety: if onstart never fires within 2s, end
      window.setTimeout(() => {
        if (!synthStarted && !audioStarted) onceEnd();
      }, 2500);
    } catch {
      onceEnd();
    }
  })();
}

function stopSpeaking() {
  speakingCancelled = true;
  try {
    window.speechSynthesis?.cancel();
  } catch {}
  try {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = "";
      activeAudio = null;
    }
  } catch {}
}

function dedupeTranscript(text: string): string {
  let s = text.replace(/\s+/g, " ").trim();
  if (!s) return "";
  // strip common STT artifacts
  s = s.replace(/[.]{2,}/g, " ");
  // collapse immediate word repeats: "okay okay okay" -> "okay"
  for (let n = 0; n < 4; n++) s = s.replace(/\b(\w+)(?:\s+\1\b)+/gi, "$1");
  // collapse repeated 2-word phrases
  for (let n = 0; n < 3; n++) s = s.replace(/\b((?:\w+\s+)\w+)(?:\s+\1)+\b/gi, "$1");
  // collapse longer repeated runs of 3-6 words
  for (let n = 0; n < 3; n++) s = s.replace(/\b((?:\w+\s+){2,5}\w+)(?:\s+\1)+\b/gi, "$1");
  // sliding window: drop if last 3-5 words equal previous 3-5
  const words = s.split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = out[out.length - 1];
    if (prev && prev.toLowerCase() === w.toLowerCase()) continue;
    let skip = false;
    for (let k = 2; k <= 5 && out.length >= k && i + k - 1 < words.length; k++) {
      const a = out.slice(-k).map((x) => x.toLowerCase()).join(" ");
      const b = words.slice(i, i + k).map((x) => x.toLowerCase()).join(" ");
      if (a === b) { skip = true; break; }
    }
    if (skip) continue;
    out.push(w);
  }
  return out.join(" ").trim();
}


function prettyMath(raw: string): string {
  let s = String(raw || "");
  // Remove LaTeX delimiters
  s = s.replace(/\$\$/g, "\n").replace(/\$/g, "");
  s = s.replace(/\\\[/g, "\n").replace(/\\\]/g, "\n");
  s = s.replace(/\\\(/g, "").replace(/\\\)/g, "");
  // Nested-ish fractions (repeat)
  for (let i = 0; i < 8; i++) {
    s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
  }
  s = s
    .replace(/\\pm\b/g, "±")
    .replace(/\\mp\b/g, "∓")
    .replace(/\\times\b/g, "×")
    .replace(/\\div\b/g, "÷")
    .replace(/\\cdot\b/g, "·")
    .replace(/\\sqrt\{([^{}]+)\}/g, "√($1)")
    .replace(/\\sqrt\s*([0-9a-zA-Z]+)/g, "√$1")
    .replace(/\\leq\b/g, "≤")
    .replace(/\\geq\b/g, "≥")
    .replace(/\\neq\b/g, "≠")
    .replace(/\\approx\b/g, "≈")
    .replace(/\\infty\b/g, "∞")
    .replace(/\\pi\b/g, "π")
    .replace(/\\theta\b/g, "θ")
    .replace(/\\alpha\b/g, "α")
    .replace(/\\beta\b/g, "β")
    .replace(/\\gamma\b/g, "γ")
    .replace(/\\Delta\b/g, "Δ")
    .replace(/\\sum\b/g, "Σ")
    .replace(/\\int\b/g, "∫")
    .replace(/\^2\b/g, "²")
    .replace(/\^3\b/g, "³")
    .replace(/\^\{2\}/g, "²")
    .replace(/\^\{3\}/g, "³")
    .replace(/\\left\(/g, "(")
    .replace(/\\right\)/g, ")")
    .replace(/\\left\[/g, "[")
    .replace(/\\right\]/g, "]")
    .replace(/\\,/g, " ")
    .replace(/\\;/g, " ")
    .replace(/\\\\/g, "\n")
    .replace(/[{}]/g, "");
  s = s.replace(/\\[a-zA-Z]+/g, "");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/  +/g, " ").trim();
}

function formatInline(text: string, dark: boolean): ReactNode[] {
  // Math-ish plain replacements
  let s = text
    .replace(/\^2\b/g, "²")
    .replace(/\^3\b/g, "³")
    .replace(/\bsqrt\(([^)]+)\)/gi, "√($1)")
    .replace(/!=/g, "≠")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/->/g, "→");
  const nodes: ReactNode[] = [];
  // **bold**, *italic*, `code`
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) nodes.push(<span key={key++}>{s.slice(last, m.index)}</span>);
    const tok = m[0];
    if (tok.startsWith("**") && tok.endsWith("**")) {
      nodes.push(<strong key={key++} className="font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*") && tok.endsWith("*")) {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      nodes.push(
        <code key={key++} className={dark ? "rounded bg-white/10 px-1 text-[12px]" : "rounded bg-slate-100 px-1 text-[12px]"}>
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < s.length) nodes.push(<span key={key++}>{s.slice(last)}</span>);
  return nodes;
}

function MarkdownText({ text, dark }: { text: string; dark: boolean }) {
  const parts: { type: "text" | "code"; lang?: string; content: string }[] = [];
  const re = /```([\w-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", content: text.slice(last, m.index) });
    parts.push({ type: "code", lang: (m[1] || "").toLowerCase(), content: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", content: text.slice(last) });
  if (!parts.length) parts.push({ type: "text", content: text });

  return (
    <div className="min-w-0 max-w-full space-y-2 overflow-hidden">
      {parts.map((p, i) =>
        p.type === "code" ? (
          <CodeBlock key={i} lang={p.lang || ""} content={p.content} dark={dark} />
        ) : (
          <div key={i} className="space-y-1.5">
            {p.content.split("\n").map((line, li) => {
              const t = line.trimEnd();
              if (!t) return <div key={li} className="h-2" />;
              // headings ## /
              if (/^#{1,3}\s+/.test(t)) {
                const body = t.replace(/^#{1,3}\s+/, "");
                return (
                  <p key={li} className="text-[14px] font-bold leading-snug">
                    {formatInline(body, dark)}
                  </p>
                );
              }
              if (/^[-*•]\s+/.test(t)) {
                return (
                  <p key={li} className="flex gap-2 text-[13px] leading-relaxed">
                    <span className="text-cyan-400">•</span>
                    <span>{formatInline(t.replace(/^[-*•]\s+/, ""), dark)}</span>
                  </p>
                );
              }
              return (
                <p key={li} className="text-[13px] leading-relaxed">
                  {formatInline(t, dark)}
                </p>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}

function CodeBlock({ lang, content, dark }: { lang: string; content: string; dark: boolean }) {
  const [preview, setPreview] = useState(false);
  const isHtml = /html|htm|xml|svg/.test(lang) || /^\s*<(!doctype|html|div|section|body)/i.test(content);
  return (
    <div className={cn("max-w-full overflow-hidden rounded-xl border", dark ? "border-cyan-500/20 bg-[#061018]" : "border-slate-200 bg-slate-50")}>
      <div className={cn("flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[11px]", dark ? "bg-white/5 text-cyan-200" : "bg-slate-100 text-slate-600")}>
        <span className="font-medium uppercase tracking-wide">{lang || "code"}</span>
        <div className="flex items-center gap-1">
          {isHtml ? (
            <button
              type="button"
              className="rounded-md px-2 py-0.5 font-semibold hover:bg-white/10"
              onClick={() => setPreview((v) => !v)}
            >
              {preview ? "Hide" : "Play"}
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md px-2 py-0.5 font-semibold hover:bg-white/10"
            onClick={() => {
              void navigator.clipboard.writeText(content);
            }}
          >
            Copy
          </button>
        </div>
      </div>
      {preview && isHtml ? (
        <iframe
          title="preview"
          sandbox="allow-scripts"
          className="h-56 w-full max-w-full border-0 bg-white"
          srcDoc={content}
        />
      ) : (
        <pre className={cn("max-h-64 max-w-full overflow-auto p-3 text-[11px] leading-relaxed break-all whitespace-pre-wrap sm:text-[12px]", dark ? "text-slate-100" : "text-slate-800")}>
          <code>{content}</code>
        </pre>
      )}
    </div>
  );
}

function D4Avatar({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src={LOGO}
      alt="D4AI"
      width={size}
      height={size}
      className={cn("rounded-full object-cover ring-1 ring-cyan-400/50 bg-[#04101f]", className)}
      style={{ width: size, height: size }}
    />
  );
}

function LiveWave({ active }: { active: boolean }) {
  const heights = [6, 10, 14, 18, 12, 8, 16, 20, 14, 9, 13, 19, 11, 7, 15, 17, 12, 8, 14, 18, 10, 6, 12, 16];
  return (
    <div className="flex h-7 w-full max-w-[240px] items-center justify-center gap-[2px]">
      {heights.map((h, i) => (
        <span
          key={i}
          className={cn("w-[3px] rounded-full bg-cyan-400", active && "animate-pulse")}
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

function GlowHero({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex flex-col items-center pt-4 text-center">
      <div className="relative">
        <div className="absolute -inset-7 rounded-full bg-cyan-500/20 blur-2xl" />
        <div className="absolute -inset-3 animate-[d4ai-pulse_3s_ease-in-out_infinite] rounded-full border border-cyan-400/40" />
        <img
          src={LOGO}
          alt="D4AI"
          className={cn(
            "relative rounded-full object-cover shadow-[0_0_70px_rgba(34,211,238,0.35)] ring-2 ring-cyan-400/60",
            compact ? "h-24 w-24" : "h-36 w-36",
          )}
        />
      </div>
      <h1
        className={cn(
          "bg-gradient-to-r from-cyan-400 via-sky-400 to-fuchsia-500 bg-clip-text font-extrabold tracking-wide text-transparent",
          compact ? "mt-2 text-2xl" : "mt-5 text-4xl",
        )}
      >
        D4AI
      </h1>
      <p className="text-[11px] font-semibold tracking-[0.4em] text-slate-300">D4TECH</p>
      <p className="mt-1 text-[13px] text-cyan-200/80">Creating Solutions. Innovating Lives.</p>
    </div>
  );
}

function TypingIndicator({ dark: _dark }: { dark?: boolean }) {
  return (
    <div className="flex w-full flex-col items-center gap-2 py-3">
      <div className="relative flex h-20 w-20 items-center justify-center">
        <span className="d4ai-ring absolute inset-0 rounded-full border-2 border-cyan-400/45" />
        <span className="d4ai-ring absolute inset-0 rounded-full border-2 border-fuchsia-400/30" style={{ animationDelay: "0.7s" }} />
        <img src={LOGO} alt="" className="relative h-16 w-16 rounded-full object-cover shadow-[0_0_28px_rgba(34,211,238,0.35)] ring-2 ring-cyan-400/50" />
      </div>
      <div className="d4ai-write-label text-base font-bold tracking-[0.28em]">
        <span className="d4ai-write-char" style={{ animationDelay: "0ms" }}>D</span>
        <span className="d4ai-write-char" style={{ animationDelay: "120ms" }}>4</span>
        <span className="d4ai-write-char" style={{ animationDelay: "240ms" }}>A</span>
        <span className="d4ai-write-char" style={{ animationDelay: "360ms" }}>I</span>
      </div>
    </div>
  );
}

const GLOBAL_CSS = `
.d4ai-dot{animation:d4ai-bounce 1s ease-in-out infinite}
@keyframes d4ai-bounce{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-4px);opacity:1}}
.d4ai-orb{background:radial-gradient(circle at 35% 32%, #7dd3fc 0%, #3b82f6 40%, #172554 78%, #0b1023 100%);box-shadow:0 0 34px rgba(59,130,246,.55),0 0 12px rgba(217,70,239,.35)}
@keyframes d4ai-pulse{0%,100%{transform:scale(1);opacity:.55}50%{transform:scale(1.12);opacity:.95}}
.d4ai-ring{animation:d4ai-ring 1.8s ease-out infinite}
@keyframes d4ai-ring{0%{transform:scale(.85);opacity:.75}100%{transform:scale(1.55);opacity:0}}
.d4ai-write-label{background:linear-gradient(90deg,#67e8f9,#3b82f6,#c084fc,#67e8f9);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:d4ai-grad 2.4s linear infinite}
.d4ai-write-char{display:inline-block;opacity:0;animation:d4ai-write-in 1.6s ease-in-out infinite}
@keyframes d4ai-write-in{0%,10%{opacity:0;transform:translateY(4px)}20%,70%{opacity:1;transform:translateY(0)}85%,100%{opacity:.35}}
.d4ai-talk-mouth{position:absolute;left:50%;bottom:26%;width:30%;height:10%;margin-left:0;border-radius:0 0 50% 50%/0 0 100% 100%;background:linear-gradient(180deg,#67e8f9,#2563eb);box-shadow:0 0 10px rgba(34,211,238,.5);transform:translateX(-50%) scaleY(.4);transform-origin:50% 0%;opacity:.9}
.d4ai-talk-mouth.on{animation:d4ai-mouth .26s ease-in-out infinite alternate}
@keyframes d4ai-mouth{from{transform:translateX(-50%) scaleY(.3)}to{transform:translateX(-50%) scaleY(1.2)}}
.d4ai-write-cursor{display:inline-block;width:2px;height:1em;margin-left:3px;vertical-align:-2px;background:linear-gradient(180deg,#67e8f9,#3b82f6);animation:d4ai-blink .9s step-end infinite}
@keyframes d4ai-blink{0%,100%{opacity:1}50%{opacity:0}}
@keyframes d4ai-grad{0%{background-position:0% 50%}100%{background-position:200% 50%}}
.d4ai-title-grad{background:linear-gradient(90deg,#67e8f9 0%,#3b82f6 45%,#c084fc 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
`;

function D4AiPage() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<"home" | "chat">("home");
  const [drawer, setDrawer] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const { data: session } = useSessionUser();
  const owner = isD4AiOwner(session);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [thoughtSeconds, setThoughtSeconds] = useState(0);
  const [welcomeTyped, setWelcomeTyped] = useState("");
  const [welcomeDone, setWelcomeDone] = useState(false);
  const thinkStartRef = useRef<number>(0);
  const [status, setStatus] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageB64, setImageB64] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [docText, setDocText] = useState<string | null>(null);
  const [docName, setDocName] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceText, setVoiceText] = useState("");
  const [voiceSecs, setVoiceSecs] = useState(0);
  const [voicePaused, setVoicePaused] = useState(false);
  const [callMode, setCallMode] = useState(false);
  const [callMinimized, setCallMinimized] = useState(false);
  const [callBubbleOpen, setCallBubbleOpen] = useState(false);
  const [bubblePos, setBubblePos] = useState({ x: 0, y: 0 });
  const [nearBottom, setNearBottom] = useState(true);
  const [attachOpen, setAttachOpen] = useState(false);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [voicePreset, setVoicePreset] = useState<VoicePreset>(() => loadVoicePreset());
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
  const [nickname, setNickname] = useState<string>(() => {
    try { return localStorage.getItem(NICK_KEY) || ""; } catch { return ""; }
  });
  const [longPress, setLongPress] = useState<Msg | null>(null);
  const [editMsg, setEditMsg] = useState<Msg | null>(null);
  const [editText, setEditText] = useState("");
  const [thumbs, setThumbs] = useState<Record<string, "up" | "down">>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setNearBottom(Boolean(entry?.isIntersecting)),
      { root: null, threshold: 0.05 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [tab, activeId, streaming, busy]);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<{ stop: () => void; start?: () => void } | null>(null);
  const voiceTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typewriterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalTranscriptRef = useRef("");
  const voicePausedRef = useRef(false);
  const autoSpeakRef = useRef(autoSpeak);
  const voicePresetRef = useRef(voicePreset);
  const callModeRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsSpeakingRef = useRef(false);
  const isAiSpeakingRef = useRef(false);
  const welcomeTypedForRef = useRef<string | null>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);
  const cameraFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
  }, [autoSpeak]);

  useEffect(() => {
    voicePresetRef.current = voicePreset;
  }, [voicePreset]);

  useEffect(() => {
    callModeRef.current = callMode;
  }, [callMode]);

  useEffect(() => {
    ttsSpeakingRef.current = ttsSpeaking;
  }, [ttsSpeaking]);

  // Match phone status bar + system nav bar to D4AI background (not exam navy)
  useEffect(() => {
    const color = theme === "dark" ? "#050b18" : "#f5f9ff";
    let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.setAttribute("data-d4ai", "theme-color-d4ai");
      document.head.appendChild(meta);
    }
    meta.content = color;
    try {
      document.documentElement.style.backgroundColor = color;
      document.body.style.backgroundColor = color;
    } catch {}
    // Capacitor native bars when available
    void (async () => {
      try {
        const w = window as unknown as {
          Capacitor?: { Plugins?: Record<string, any>; isNativePlatform?: () => boolean };
        };
        const plugins = w.Capacitor?.Plugins;
        if (!plugins) return;
        if (plugins.StatusBar) {
          await plugins.StatusBar.setBackgroundColor?.({ color });
          await plugins.StatusBar.setStyle?.({
            style: theme === "dark" ? "DARK" : "LIGHT",
          });
          await plugins.StatusBar.show?.();
        }
        if (plugins.NavigationBar) {
          await plugins.NavigationBar.setColor?.({ color, darkButtons: theme !== "dark" });
        }
        // Some builds expose NavigationBar under different names
        if (plugins.App) {
          // no-op; keeps WebView chrome aligned via theme-color
        }
      } catch {
        /* web or plugin missing */
      }
    })();
    return () => {
      // restore a neutral color when leaving D4AI so other pages can set their own
      try {
        const restore = "#0a1628";
        const m = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
        if (m) m.content = restore;
      } catch {}
    };
  }, [theme]);


  useEffect(() => {
    try {
      localStorage.setItem(VOICE_KEY, voicePreset);
    } catch {}
  }, [voicePreset]);

  // Smooth welcome typewriter — once per chat id, no loop
  useEffect(() => {
    if (!activeId) return;
    const conv = conversations.find((c) => c.id === activeId);
    const realCount = (conv?.messages || []).filter((m) => m.id !== "welcome").length;

    // Existing conversation with real messages: show static welcome, never re-type
    if (realCount > 0) {
      const existing =
        (conv?.messages || []).find((m) => m.id === "welcome")?.content || WELCOME_TEXT;
      setWelcomeTyped(existing);
      setWelcomeDone(true);
      welcomeTypedForRef.current = activeId;
      return;
    }

    // Already typed this chat
    if (welcomeTypedForRef.current === activeId && welcomeDone) return;

    const rawName = String(session?.fullName || nickname || "").trim();
    const parts = rawName.split(/\s+/).filter(Boolean);
    const two = parts.slice(0, 2).join(" ");
    const full = two
      ? `Hi ${two}! 👋\n\nI'm D4AI — your study companion and AI buddy on D4EXAM.\n\nAsk me anything: lessons, code, research, or ideas. I'm right here with you.`
      : `Hi there! 👋\n\nI'm D4AI — your study companion and AI buddy on D4EXAM.\n\nAsk me anything: lessons, code, research, or ideas. I'm right here with you.`;

    let i = 0;
    let cancelled = false;
    setWelcomeTyped("");
    setWelcomeDone(false);
    const id = window.setInterval(() => {
      if (cancelled) return;
      i = Math.min(full.length, i + 1);
      setWelcomeTyped(full.slice(0, i));
      if (i >= full.length) {
        window.clearInterval(id);
        setWelcomeDone(true);
        welcomeTypedForRef.current = activeId;
      }
    }, 32);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // intentionally NOT depending on conversations (that caused the hi-hi-hi loop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, session?.fullName, nickname]);

  // Warm up voices for TTS
  useEffect(() => {
    try {
      const load = () => window.speechSynthesis?.getVoices();
      load();
      window.speechSynthesis.onvoiceschanged = load;
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === "light" || t === "dark") setTheme(t);
      setAutoSpeak(localStorage.getItem(SPEAK_KEY) === "1");
    } catch {}
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
    // Always land on most recently updated chat
    const sorted = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    id = sorted[0]?.id || list[0].id;
    setConversations(list);
    setActiveId(id);
    try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
    const activeConv = list.find((c) => c.id === id);
    if (activeConv && activeConv.messages.filter((m) => m.id !== "welcome").length > 0) {
      setTab("chat");
      // Jump to latest messages
      window.setTimeout(() => {
        try {
          bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
        } catch {}
      }, 120);
      window.setTimeout(() => {
        try {
          bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        } catch {}
      }, 400);
    }
  }, []);




  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);
  const messages = active?.messages ?? [WELCOME];
  const dark = theme === "dark";

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

  const scrollDown = (smooth = false) => {
    try {
      bottomRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "end" });
    } catch {}
  };

  const startNewChat = () => {
    const c: Conversation = { id: newId(), title: "New chat", updatedAt: Date.now(), messages: [WELCOME] };
    persist([c, ...conversations].slice(0, 40), c.id);
    setDrawer(false);
    setHistoryOpen(false);
    setTab("home");
    setError(null);
  };

  const deleteChat = (id: string) => {
    const list = conversations.filter((c) => c.id !== id);
    if (!list.length) {
      const c: Conversation = { id: newId(), title: "New chat", updatedAt: Date.now(), messages: [WELCOME] };
      persist([c], c.id);
      setTab("home");
    } else {
      persist(list, id === activeId ? list[0].id : activeId);
    }
  };

  const clearChat = () => {
    setDrawer(false);
    if (!activeId) return;
    updateActiveMessages([WELCOME]);
    setTab("home");
    setToast("Chat cleared");
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
      setStreaming(false);
      setStatus(null);
      setTab("chat");
      const userMsg: Msg = {
        id: `u-${Date.now()}`,
        role: "user",
        content:
          body ||
          (imgs?.length ? "Please analyse this image." : `Please use this document: ${dName}`),
        imagePreview: imgs?.[0],
        docName: dName || undefined,
        createdAt: Date.now(),
      };
      // Capture display name from early short replies after welcome
      if (!nickname && body && body.trim().split(/\s+/).length <= 3 && body.length <= 24 && !/[?]/.test(body)) {
        const name = body.trim().replace(/[^a-zA-Z0-9 \-']/g, "").slice(0, 24);
        if (name) {
          setNickname(name);
          try { localStorage.setItem(NICK_KEY, name); } catch {}
        }
      }
      updateActiveMessages((m) => {
        const base = m.some((x) => x.id === "welcome") ? m : [WELCOME, ...m];
        return [...base, userMsg];
      });
      setStreaming(false);
      setStatus(null);
      scrollDown();

      if (imgs?.[0] && !dText) {
        setStatus(null);
        const ocr = await ocrImageDataUrl(imgs[0]);
        if (ocr && ocr.replace(/\s/g, "").length > 12) dText = ocr;
        setStatus(null);
      }

      // API allows max 24 messages — keep only the latest turns
      let history = [...(active?.messages ?? []), userMsg]
        .filter((m) => m.id !== "welcome")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      // Prefer recent context; hard cap under schema max(24)
      if (history.length > 20) history = history.slice(-20);
      if (nickname && history.length) {
        const last = history[history.length - 1];
        if (last.role === "user") {
          last.content = `(Call me ${nickname}.)\n${last.content}`;
        }
      }
      if (!history.length) {
        history = [{ role: "user", content: userMsg.content }];
      }

      try {
        thinkStartRef.current = Date.now();
        setThoughtSeconds(0);
        const thinkTimer = window.setInterval(() => {
          setThoughtSeconds(Math.max(1, Math.round((Date.now() - thinkStartRef.current) / 1000)));
        }, 250);

        const aid = `a-${Date.now()}`;
        let assistantInserted = false;
        setStreaming(true);
        scrollDown();

        const ensureAssistant = (content: string) => {
          if (!assistantInserted) {
            assistantInserted = true;
            updateActiveMessages((m) => [...m, { id: aid, role: "assistant", content, createdAt: Date.now() }]);
          } else {
            updateActiveMessages((list) =>
              list.map((x) => (x.id === aid ? { ...x, content } : x)),
            );
          }
          scrollDown();
        };

        const userText = body || userMsg.content;

        // Client-side identity (always works even if proxy is old)
        const identityQ =
          /\b(what('?s| is) (your|ur) name|who are you|your name|ur name|who made you|who created you)\b/i.test(
            userText,
          );
        let full = "";
        if (identityQ) {
          full =
            /who (made|created) you|who is your (ceo|creator|founder)/i.test(userText)
              ? "I was created by **Amurun Destiny O**, founder and CEO of **D4TECH**. I'm **D4AI** — here to help you learn and solve problems."
              : "I'm **D4AI** — your AI assistant on D4EXAM by D4TECH. I help with study, code, and questions. What do you need?";
        } else {
          const ac = new AbortController();
          const to = window.setTimeout(() => ac.abort(), 45000);
          let chatRes: Response;
          try {
            chatRes = await fetch("/api/d4ai/chat", {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({
                message: userText,
                messages: history.slice(-4).map((m) => ({
                  role: m.role,
                  content: String(m.content || "").slice(0, 500),
                })),
              }),
              cache: "no-store",
              signal: ac.signal,
            });
          } finally {
            window.clearTimeout(to);
          }

          let payload: { ok?: boolean; answer?: string; error?: string; sources?: string[] } = {};
          try {
            payload = (await chatRes.json()) as typeof payload;
          } catch {
            throw new Error("Invalid response from D4AI server");
          }

          if (!chatRes.ok || payload.ok === false || !String(payload.answer || "").trim()) {
            throw new Error(payload.error || `HTTP ${chatRes.status}`);
          }

          full = String(payload.answer)
            .replace(/\n*Thought for [\d.]+s\s*$/i, "")
            .replace(/\n*---\s*\n*[\d.]+s.*$/i, "")
            .replace(/\n*⚡\s*[\d.]+s.*$/i, "")
            .trim();
          if (payload.sources?.length) {
            const extra = payload.sources.filter((s) => !full.includes(s));
            if (extra.length) full += "\n\n" + extra.map((s) => `🔗 ${s}`).join("\n");
          }
        }

        // Typewriter + TTS
        const inCall = callModeRef.current;
        if (inCall) {
          // Call mode: show no typing UI; speak without blocking chat flow
          try {
            recognitionRef.current?.stop();
          } catch {}
          ensureAssistant(full);
          setTtsSpeaking(true);
          ttsSpeakingRef.current = true;
          isAiSpeakingRef.current = true;
          speakingCancelled = false;
          speakText(full, {
            preset: voicePresetRef.current,
            onstart: () => {
              setTtsSpeaking(true);
              ttsSpeakingRef.current = true;
              isAiSpeakingRef.current = true;
            },
            onend: () => {
              setTtsSpeaking(false);
              ttsSpeakingRef.current = false;
              isAiSpeakingRef.current = false;
              if (callModeRef.current && !voicePausedRef.current) {
                window.setTimeout(() => {
                  if (callModeRef.current && !isAiSpeakingRef.current) {
                    finalTranscriptRef.current = "";
                    setVoiceText("");
                    startVoice();
                  }
                }, 500);
              }
            },
          });
        } else {
          // Chat mode: typewriter; optional auto-speak after (or progressive if autoSpeak)
          let i = 0;
          const step = Math.max(6, Math.ceil(full.length / 50));
          const doSpeak = Boolean(autoSpeakRef.current);
          if (doSpeak) {
            setTtsSpeaking(true);
            ttsSpeakingRef.current = true;
            setSpeakingMsgId(aid);
            speakText(full, {
              preset: voicePresetRef.current,
              onstart: () => {
                setTtsSpeaking(true);
                ttsSpeakingRef.current = true;
                setSpeakingMsgId(aid);
              },
              onend: () => {
                setTtsSpeaking(false);
                ttsSpeakingRef.current = false;
                setSpeakingMsgId(null);
              },
            });
          }
          await new Promise<void>((resolve) => {
            typewriterRef.current = setInterval(() => {
              i = Math.min(full.length, i + step);
              ensureAssistant(full.slice(0, i));
              if (i >= full.length) {
                if (typewriterRef.current) clearInterval(typewriterRef.current);
                typewriterRef.current = null;
                resolve();
              }
            }, 12);
          });
        }

        window.clearInterval(thinkTimer);
        setThoughtSeconds(Math.max(1, Math.round((Date.now() - thinkStartRef.current) / 1000)));
        setStreaming(false);
            } catch (e) {
        const msg = friendlyError(e instanceof Error ? e.message : "Failed to reach D4AI");
        setError(msg);
        // Prefer updating empty assistant bubble if we created one; else append once
        updateActiveMessages((m) => {
          const last = m[m.length - 1];
          if (last && last.role === "assistant" && !String(last.content || "").trim()) {
            return m.map((x, i) => (i === m.length - 1 ? { ...x, content: msg } : x));
          }
          // avoid stacking identical error bubbles
          if (last && last.role === "assistant" && last.content === msg) return m;
          return [...m, { id: `e-${Date.now()}`, role: "assistant", content: msg, createdAt: Date.now() }];
        });
      } finally {
        setBusy(false);
        setStreaming(false);
        setStatus(null);
        scrollDown();
      }
    },
    [busy, active?.messages, updateActiveMessages, owner, nickname],
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
    // Stop mic only — never clear callMode here (that broke live call)
    try {
      recognitionRef.current?.stop();
    } catch {}
    recognitionRef.current = null;
    if (voiceTimer.current) clearInterval(voiceTimer.current);
    voiceTimer.current = null;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setVoiceOn(false);
    setVoicePaused(false);
    voicePausedRef.current = false;
    if (clearText) {
      setVoiceText("");
      finalTranscriptRef.current = "";
    }
  };

  const startVoice = () => {
    try {
    const w = window as unknown as {
      SpeechRecognition?: new () => any;
      webkitSpeechRecognition?: new () => any;
    };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      setError("Voice needs Chrome or a supported browser. Allow microphone access.");
      setToast("Microphone / speech not available on this device");
      return;
    }
    // Stop previous recognition without wiping call mode or throwing
    try {
      recognitionRef.current?.stop();
    } catch {}
    recognitionRef.current = null;
    if (voiceTimer.current) {
      clearInterval(voiceTimer.current);
      voiceTimer.current = null;
    }
    setVoiceSecs(0);
    setVoiceOn(true);
    const rec = new SR();
    recognitionRef.current = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = "en-US";
    rec.onresult = (ev: any) => {
      // Hard mute: ignore everything while D4AI is talking
      if (ttsSpeakingRef.current || isAiSpeakingRef.current) {
        try {
          recognitionRef.current?.stop();
        } catch {}
        return;
      }
      let interim = "";
      let addedFinal = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const piece = String(r[0]?.transcript || "").replace(/\s+/g, " ").trim();
        if (!piece) continue;
        if (r.isFinal) {
          const prev = finalTranscriptRef.current;
          const low = piece.toLowerCase();
          if (!prev.toLowerCase().endsWith(low) && !prev.toLowerCase().includes(low + " ")) {
            addedFinal = (addedFinal + " " + piece).trim();
          }
        } else {
          interim = piece;
        }
      }
      if (addedFinal) {
        finalTranscriptRef.current = dedupeTranscript(
          (finalTranscriptRef.current + " " + addedFinal).trim(),
        );
      }
      const display = dedupeTranscript(
        [finalTranscriptRef.current, interim].filter(Boolean).join(" ").trim(),
      );
      setVoiceText(display);

      // Call mode only: after silence, auto-send to AI
      if (callModeRef.current && !voicePausedRef.current) {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          const text = (finalTranscriptRef.current || "").trim();
          if (text && callModeRef.current) {
            void finishCallTurn(text);
          }
        }, SILENCE_MS);
      }
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
      // Do NOT restart mic while D4AI is speaking (prevents self-interrupt loop)
      if (ttsSpeakingRef.current || isAiSpeakingRef.current) return;
      if (!voicePausedRef.current && recognitionRef.current === rec && voiceOn) {
        try {
          setTimeout(() => {
            try {
              if (
                !voicePausedRef.current &&
                !ttsSpeakingRef.current &&
                !isAiSpeakingRef.current &&
                recognitionRef.current === rec
              ) {
                rec.start();
              }
            } catch {}
          }, 200);
        } catch {}
      }
    };
    try {
      rec.start();
      setVoiceOn(true);
      voiceTimer.current = setInterval(() => setVoiceSecs((x) => x + 1), 1000);
    } catch {
      setError("Could not start microphone. Check permission.");
      setToast("Could not start microphone");
      try {
        recognitionRef.current = null;
        setVoiceOn(false);
      } catch {}
    }
    } catch (e) {
      console.error("startVoice", e);
      setError("Voice could not start. Try again.");
      setToast("Voice error — try again");
      setVoiceOn(false);
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

  const voiceToDraft = () => {
    // Live call: minimize to floating bubble, keep session alive
    if (callModeRef.current || callMode) {
      setCallMinimized(true);
      setCallBubbleOpen(false);
      setTab("chat");
      return;
    }
    const text = punctuateSpeech((finalTranscriptRef.current || voiceText).trim());
    stopVoice(false);
    setVoiceText("");
    finalTranscriptRef.current = "";
    if (text) setInput(text);
  };

  const expandCallFromBubble = () => {
    setCallMinimized(false);
    setCallBubbleOpen(false);
    setCallMode(true);
    callModeRef.current = true;
    setTab("chat");
  };

  const endCallSession = () => {
    setCallBubbleOpen(false);
    setCallMinimized(false);
    setCallMode(false);
    callModeRef.current = false;
    stopSpeaking();
    setTtsSpeaking(false);
    ttsSpeakingRef.current = false;
    isAiSpeakingRef.current = false;
    stopVoice(true);
  };


  const finishVoiceAndSend = async () => {
    const text = dedupeTranscript((finalTranscriptRef.current || voiceText).trim());
    stopVoice(true);
    if (!text) return;
    await sendWithText(text);
  };

  const finishCallTurn = async (text: string) => {
    const clean = punctuateSpeech(dedupeTranscript(text.trim()));
    if (!clean || busy) return;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    // Keep mic running in call mode; just clear transcript for next turn
    finalTranscriptRef.current = "";
    setVoiceText("");
    setTab("chat");
    await sendWithText(clean);
  };


  const startVoiceNote = () => {
    setCallMode(false);
    callModeRef.current = false;
    finalTranscriptRef.current = "";
    setVoiceText("");
    startVoice();
  };

  const startCallMode = () => {
    try {
      setCallMode(true);
      callModeRef.current = true;
      setCallMinimized(false);
      setCallBubbleOpen(false);
      setAutoSpeak(true);
      autoSpeakRef.current = true;
      try {
        localStorage.setItem(SPEAK_KEY, "1");
      } catch {}
      startVoice();
    } catch (e) {
      console.error("startCallMode", e);
      setToast("Could not start voice call");
      setError("Voice call could not start. Allow microphone and try again.");
    }
  };

  const doSpeak = (text: string, msgId?: string) => {
    if (msgId && speakingMsgId === msgId) {
      stopSpeaking();
      setTtsSpeaking(false);
      ttsSpeakingRef.current = false;
      setSpeakingMsgId(null);
      return;
    }
    // Pause mic so we never transcribe our own TTS
    try {
      recognitionRef.current?.stop();
    } catch {}
    try {
      window.speechSynthesis?.cancel();
      window.speechSynthesis?.resume();
    } catch {}
    if (msgId) setSpeakingMsgId(msgId);
    setTtsSpeaking(true);
    ttsSpeakingRef.current = true;
    isAiSpeakingRef.current = true;
    try {
      recognitionRef.current?.stop();
    } catch {}
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    finalTranscriptRef.current = "";
    setVoiceText("");
    speakText(text, {
      preset: voicePreset,
      onstart: () => {
        setTtsSpeaking(true);
        ttsSpeakingRef.current = true;
        isAiSpeakingRef.current = true;
        try {
          recognitionRef.current?.stop();
        } catch {}
        finalTranscriptRef.current = "";
        setVoiceText("");
      },
      onend: () => {
        setTtsSpeaking(false);
        ttsSpeakingRef.current = false;
        isAiSpeakingRef.current = false;
        setSpeakingMsgId(null);
        finalTranscriptRef.current = "";
        setVoiceText("");
        // Resume live-call listening only after AI finishes + cooldown (avoids hearing itself)
        if (callModeRef.current && voiceOn) {
          window.setTimeout(() => {
            if (callModeRef.current && !isAiSpeakingRef.current) {
              finalTranscriptRef.current = "";
              setVoiceText("");
              startVoice();
            }
          }, 900);
        }
      },
    });
  };

  const stopAi = () => {
    if (typewriterRef.current) {
      clearInterval(typewriterRef.current);
      typewriterRef.current = null;
    }
    setBusy(false);
    setStreaming(false);
    setStatus(null);
  };

  const goBack = () => {
    try {
      appNavigate(navigate, "/student");
    } catch {
      navigate({ to: "/student" });
    }
  };

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  };

  const toggleAutoSpeak = () => {
    const next = !autoSpeak;
    setAutoSpeak(next);
    try {
      localStorage.setItem(SPEAK_KEY, next ? "1" : "0");
    } catch {}
    setToast(next ? "Voice replies on" : "Voice replies off");
  };

  const onPressStart = (m: Msg) => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setLongPress(m), 550);
  };
  const onPressEnd = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const deleteMsg = (m: Msg) => {
    updateActiveMessages((list) => list.filter((x) => x.id !== m.id));
    setToast("Message deleted");
  };

  const shareMsg = async (m: Msg) => {
    try {
      if (navigator.share) {
        await navigator.share({ text: m.content });
      } else {
        await navigator.clipboard.writeText(m.content);
        setToast("Copied to share");
      }
    } catch {}
    setLongPress(null);
  };

  const filteredHistory = conversations.filter((c) => {
    if (!historyQuery.trim()) return true;
    const q = historyQuery.toLowerCase();
    return (
      c.title.toLowerCase().includes(q) ||
      c.messages.some((m) => m.content.toLowerCase().includes(q))
    );
  });

  const search = Route.useSearch();
  const fromPage = typeof search?.from === "string" ? search.from : "";
  const showBack = fromPage === "messages" || fromPage === "materials";

  const header = (
    <header
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-3 py-2.5",
        dark ? "border-cyan-400/15 bg-[#0a1a33]/90" : "border-slate-200 bg-white/90",
      )}
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      {showBack ? (
        <button
          type="button"
          onClick={() => {
            try {
              if (fromPage === "messages") appNavigate(navigate, "/student/messages");
              else if (fromPage === "materials") appNavigate(navigate, "/student/materials");
              else goBack();
            } catch {
              navigate({ to: fromPage === "materials" ? "/student/materials" : "/student/messages" });
            }
          }}
          className={cn("rounded-xl p-2", dark ? "text-white/90 hover:bg-white/10" : "text-slate-700 hover:bg-slate-100")}
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      ) : (
        <D4Avatar size={38} />
      )}
      {!showBack ? null : <D4Avatar size={32} />}
      <div className="min-w-0 flex-1">
        <h1 className="d4ai-title-grad text-base font-bold">D4AI</h1>
        <p className="flex items-center gap-1 text-[11px] text-cyan-300/90">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          {"Online · v5-Ultimate"}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          const next = !autoSpeak;
          setAutoSpeak(next);
          autoSpeakRef.current = next;
          try {
            localStorage.setItem(SPEAK_KEY, next ? "1" : "0");
          } catch {}
          setToast(next ? "Auto-talk on — AI will speak replies" : "Auto-talk off");
        }}
        className={cn(
          "mr-1 rounded-full px-2.5 py-1 text-[10px] font-bold",
          autoSpeak
            ? "bg-cyan-500/25 text-cyan-100 ring-1 ring-cyan-400/50"
            : dark
              ? "bg-white/5 text-slate-400 ring-1 ring-white/10"
              : "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
        )}
        aria-label="Toggle auto-talk"
      >
        {autoSpeak ? "Auto-talk On" : "Auto-talk"}
      </button>
      <button type="button" onClick={() => setDrawer(true)} className={cn("rounded-xl p-2", dark ? "text-white/90 hover:bg-white/10" : "text-slate-700 hover:bg-slate-100")} aria-label="Menu">
        <Menu className="h-5 w-5" />
      </button>
    </header>
  );

  const bubbleClasses = (role: Msg["role"]) =>
    role === "user"
      ? "rounded-2xl rounded-br-md bg-gradient-to-br from-[#2563eb] to-[#3b82f6] text-white shadow-lg shadow-blue-900/30"
      : dark
        ? "rounded-2xl rounded-bl-md bg-[#0e2038] text-slate-100 ring-1 ring-cyan-400/15"
        : "rounded-2xl rounded-bl-md bg-white text-slate-800 ring-1 ring-slate-200 shadow-sm";

  const chatView = (
    <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
      {/* Persistent hero + welcome — never disappears */}
      <div className="mx-auto flex max-w-md flex-col items-center px-2 pb-2">
        <GlowHero />
        <div className={cn("mt-6 w-full rounded-2xl p-3.5", dark ? "bg-[#0e2038] ring-1 ring-cyan-400/15" : "bg-white ring-1 ring-slate-200 shadow-sm")}>
          <div className="flex items-start gap-2">
            <D4Avatar size={28} className="mt-0.5 shrink-0" />
            <p className={cn("whitespace-pre-wrap text-[13px] leading-relaxed", dark ? "text-slate-300" : "text-slate-700")}>{welcomeTyped}{!welcomeDone ? <span className="d4ai-write-cursor ml-0.5 inline-block" /> : null}</p>
          </div>
        </div>
      </div>
      {messages
        .filter((m) => m.id !== "welcome" && !(m.role === "assistant" && !String(m.content || "").trim()))
        .map((m) => (
          <div key={m.id} className={cn("flex gap-2", m.role === "user" ? "justify-end" : "justify-start")}>
            {m.role === "assistant" ? <D4Avatar size={30} className="mt-1 shrink-0" /> : null}
            <div className={cn("flex min-w-0 max-w-[min(85%,100%)] flex-col", m.role === "user" ? "items-end" : "items-start")}>
              <div
                onPointerDown={(e) => {
                  // long-press only (do not steal scroll / tap)
                  if (e.button !== 0) return;
                  onPressStart(m);
                }}
                onPointerUp={onPressEnd}
                onPointerCancel={onPressEnd}
                onPointerLeave={onPressEnd}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setLongPress(m);
                }}
                className={cn("px-3.5 py-2.5 text-[15px] leading-relaxed shadow select-none", bubbleClasses(m.role))}
              >
                {m.imagePreview ? (
                  <img src={m.imagePreview} alt="" className="mb-2 max-h-48 w-full rounded-xl object-cover" />
                ) : null}
                {m.docName ? (
                  <p className="mb-1 flex items-center gap-1 text-xs opacity-90">
                    <FileText className="h-3.5 w-3.5" /> {m.docName}
                  </p>
                ) : null}
                <MarkdownText text={prettyMath(m.content)} dark={dark} />
              </div>
              {m.role === "user" ? (
                <div className="mt-1 flex items-center gap-1 pr-1 text-[10px] text-slate-400">
                  <span>{fmtTime(m.createdAt)}</span>
                  <CheckCheck className="h-3 w-3 text-cyan-300" />
                </div>
              ) : m.content ? (
                <div className="mt-1 flex items-center gap-0.5 pl-1">
                  <button
                    type="button"
                    onClick={() => doSpeak(m.content, m.id)}
                    className={cn("rounded-lg p-1.5 hover:bg-white/5", speakingMsgId === m.id ? "text-cyan-300" : "text-slate-400 hover:text-cyan-300")}
                    aria-label={speakingMsgId === m.id ? "Stop" : "Speak"}
                  >
                    {speakingMsgId === m.id ? <Square className="h-3.5 w-3.5 fill-current" /> : <Volume2 className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(m.content);
                        setToast("Copied");
                      } catch {}
                    }}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-cyan-300"
                    aria-label="Copy"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setThumbs((p) => ({ ...p, [m.id]: p[m.id] === "up" ? "up" : "up" }))}
                    className={cn("rounded-lg p-1.5 hover:bg-white/5", thumbs[m.id] === "up" ? "text-cyan-300" : "text-slate-400 hover:text-cyan-300")}
                    aria-label="Good response"
                  >
                    <ThumbsUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setThumbs((p) => ({ ...p, [m.id]: "down" }))}
                    className={cn("rounded-lg p-1.5 hover:bg-white/5", thumbs[m.id] === "down" ? "text-rose-400" : "text-slate-400 hover:text-rose-400")}
                    aria-label="Bad response"
                  >
                    <ThumbsDown className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => setLongPress(m)} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-cyan-300" aria-label="More">
                    <MoreVertical className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      {busy ? <TypingIndicator /> : null}
      {status ? (
        <p className="flex items-center gap-2 px-2 text-xs text-cyan-200/80">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {status}
        </p>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );

  const homeView = (
    <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
      <GlowHero />
      <div className={cn("mx-auto mt-2 w-full max-w-md rounded-2xl p-3.5", dark ? "bg-[#0e2038] ring-1 ring-cyan-400/15" : "bg-white ring-1 ring-slate-200 shadow-sm")}>
        <div className="flex items-start gap-2">
          <D4Avatar size={28} className="mt-0.5 shrink-0" />
          <p className={cn("whitespace-pre-wrap text-[13px] leading-relaxed", dark ? "text-slate-300" : "text-slate-700")}>{welcomeTyped}{!welcomeDone ? <span className="d4ai-write-cursor ml-0.5 inline-block" /> : null}</p>
        </div>
      </div>
      {active && active.messages.length > 1 ? (
        <button
          type="button"
          onClick={() => setTab("chat")}
          className={cn("mx-auto flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold", dark ? "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-400/30" : "bg-blue-50 text-blue-700 ring-1 ring-blue-200")}
        >
          <MessageCircle className="h-3.5 w-3.5" /> Continue last conversation
        </button>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );

  const composer = (
    <div
      className={cn("shrink-0 border-t px-2 py-2", dark ? "border-cyan-400/15 bg-[#081426]" : "border-slate-200 bg-white")}
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      {(imagePreview || docName) && !voiceOn ? (
        <div className="mb-2 flex items-center gap-2 px-1 text-xs text-slate-300">
          {imagePreview ? (
            <div className="relative">
              <img src={imagePreview} alt="" className="h-12 w-12 rounded-lg object-cover" />
              <button type="button" className="absolute -right-1 -top-1 rounded-full bg-[#0b1b3a] p-0.5 text-white" onClick={() => { setImageB64(null); setImagePreview(null); }}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          {docName ? (
            <span className={cn("flex items-center gap-1 rounded-full px-2 py-1", dark ? "bg-white/10 text-slate-200" : "bg-slate-100 text-slate-700")}>
              <FileText className="h-3.5 w-3.5" />
              <span className="max-w-[160px] truncate">{docName}</span>
              <button type="button" onClick={() => { setDocText(null); setDocName(null); }}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : null}
        </div>
      ) : null}

      {null}

      <div className="mx-auto flex max-w-2xl items-end gap-1.5">
        <button
          type="button"
          onClick={() => setAttachOpen(true)}
          className={cn("mb-1 grid h-9 w-9 shrink-0 place-items-center rounded-full", dark ? "text-white/90 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100")}
          aria-label="Attach"
        >
          <Link2 className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => {
            try {
              startVoiceNote();
            } catch (e) {
              console.error(e);
              setToast("Voice note failed to start");
            }
          }}
          className={cn("mb-1 grid h-9 w-9 shrink-0 place-items-center rounded-full", dark ? "text-white hover:bg-white/10" : "text-slate-700 hover:bg-slate-100")}
          aria-label="Voice note"
        >
          <Mic className="h-5 w-5" />
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,application/pdf,text/plain" className="hidden" onChange={(e) => { void onPickFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <input ref={imageFileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onPickFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <input ref={cameraFileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void onPickFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <input ref={audioFileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg" className="hidden" onChange={(e) => { void onPickFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <textarea
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Message D4AI…"
          className={cn(
            "max-h-28 min-h-[42px] flex-1 resize-none rounded-2xl border px-3.5 py-2.5 text-sm focus:outline-none",
            dark
              ? "border-cyan-400/25 bg-white/5 text-white placeholder:text-slate-500 focus:border-cyan-400/60"
              : "border-slate-200 bg-slate-50 text-slate-900 placeholder:text-slate-400 focus:border-blue-400",
          )}
        />
        {busy ? (
          <button type="button" onClick={() => { stopAi(); stopSpeaking(); setTtsSpeaking(false); }} className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-b from-[#3b82f6] to-[#1d4ed8] text-white shadow-lg ring-2 ring-cyan-300/50" aria-label="Stop">
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : input.trim() || imageB64 || docText ? (
          <button type="button" onClick={() => void send()} className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-b from-[#3b82f6] to-[#1d4ed8] text-white shadow-lg" aria-label="Send">
            <Send className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={startCallMode}
            className="mb-0.5 grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-b from-[#60a5fa] via-[#3b82f6] to-[#1d4ed8] text-white shadow-lg ring-2 ring-white/50 transition active:scale-95"
            aria-label="Talk with D4AI"
          >
            <img src={LOGO} alt="D4AI" className="h-7 w-7 rounded-full object-cover" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={cn("fixed inset-0 z-[60] flex flex-col", dark ? "text-slate-100" : "text-slate-900")}
      style={{
        background: dark
          ? "radial-gradient(ellipse at top, #0b1a3a 0%, #050b18 45%, #020617 100%)"
          : "radial-gradient(ellipse at top, #e8f1ff 0%, #f5f9ff 45%, #ffffff 100%)",
      }}
    >
      <style>{GLOBAL_CSS}</style>


      {/* Scroll to latest message */}
      {tab === "chat" && !voiceOn && !nearBottom ? (
        <button
          type="button"
          onClick={() => {
            try {
              bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            } catch {}
          }}
          className="fixed bottom-28 right-3 z-[70] grid h-10 w-10 place-items-center rounded-full bg-gradient-to-b from-[#0e2038] to-[#050b18] text-cyan-300 shadow-lg ring-2 ring-cyan-400/35"
          aria-label="Scroll to latest"
        >
          <ChevronRight className="h-5 w-5 rotate-90" />
        </button>
      ) : null}

      {/* ---------- Minimized live-call floating bubble ---------- */}
      {callMode && callMinimized ? (
        <div
          className="fixed z-[90] flex flex-col items-center gap-2"
          style={{
            left: bubblePos.x ? bubblePos.x : undefined,
            top: bubblePos.y ? bubblePos.y : undefined,
            right: bubblePos.x ? undefined : 16,
            bottom: bubblePos.y ? undefined : 96,
            touchAction: "none",
          }}
          onPointerDown={(e) => {
            const t = e.currentTarget;
            const startX = e.clientX;
            const startY = e.clientY;
            const rect = t.getBoundingClientRect();
            const origX = rect.left;
            const origY = rect.top;
            let moved = false;
            const onMove = (ev: PointerEvent) => {
              const dx = ev.clientX - startX;
              const dy = ev.clientY - startY;
              if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
              const nx = Math.max(8, Math.min(window.innerWidth - 72, origX + dx));
              const ny = Math.max(8, Math.min(window.innerHeight - 120, origY + dy));
              setBubblePos({ x: nx, y: ny });
            };
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              if (!moved) setCallBubbleOpen((o) => !o);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }}
        >
          {callBubbleOpen ? (
            <div className="mb-1 flex flex-row items-center gap-2 rounded-full bg-[#0b1a3a]/95 px-2 py-1.5 ring-1 ring-cyan-400/40">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (voicePaused) resumeVoice();
                  else pauseVoice();
                  setCallBubbleOpen(false);
                }}
                className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white"
                aria-label="Pause or resume"
              >
                {voicePaused ? <Mic className="h-5 w-5" /> : <Square className="h-4 w-4 fill-current" />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  expandCallFromBubble();
                }}
                className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white"
                aria-label="Expand call"
              >
                <Phone className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  endCallSession();
                }}
                className="grid h-10 w-10 place-items-center rounded-full bg-red-600/90 text-white"
                aria-label="End call"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="relative grid h-16 w-16 place-items-center overflow-hidden rounded-full bg-gradient-to-b from-[#60a5fa] to-[#1d4ed8] shadow-[0_0_24px_rgba(59,130,246,0.55)] ring-4 ring-cyan-300/30"
            aria-label="Call options"
          >
            <img src={LOGO} alt="D4AI call" className="h-12 w-12 rounded-full object-cover pointer-events-none" />
            {ttsSpeaking ? (
              <span className="absolute inset-0 animate-pulse rounded-full ring-2 ring-cyan-300/60 pointer-events-none" />
            ) : null}
          </button>
          <p className="max-w-[9rem] text-center text-[10px] text-cyan-200/90 pointer-events-none">
            {ttsSpeaking ? "Speaking…" : voicePaused ? "Paused" : "Drag · tap options"}
          </p>
        </div>
      ) : null}

      {/* ---------- Chat history full screen ---------- */}
      {historyOpen ? (
        <div className="absolute inset-0 z-[70] flex flex-col" style={{ background: dark ? "radial-gradient(ellipse at top, #0b1a3a 0%, #050b18 45%, #020617 100%)" : "radial-gradient(ellipse at top, #e8f1ff 0%, #f5f9ff 45%, #ffffff 100%)" }}>
          <header className={cn("flex shrink-0 items-center gap-2 border-b px-3 py-3", dark ? "border-cyan-400/15 bg-[#0a1a33]/90" : "border-slate-200 bg-white/90")} style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
            <button type="button" onClick={() => setHistoryOpen(false)} className={cn("rounded-xl p-2", dark ? "text-white/90 hover:bg-white/10" : "text-slate-700 hover:bg-slate-100")} aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h2 className={cn("flex-1 text-lg font-bold", dark ? "text-white" : "text-slate-900")}>Chat History</h2>
            <button type="button" onClick={startNewChat} className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-b from-[#3b82f6] to-[#1d4ed8] text-white" aria-label="New chat">
              <Plus className="h-5 w-5" />
            </button>
          </header>
          <div className="px-3 py-3">
            <div className={cn("flex items-center gap-2 rounded-xl border px-3 py-2", dark ? "border-cyan-400/25 bg-white/5" : "border-slate-200 bg-white")}>
              <History className="h-4 w-4 text-slate-400" />
              <input
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Search conversations…"
                className={cn("w-full bg-transparent text-sm outline-none", dark ? "text-white placeholder:text-slate-500" : "text-slate-900 placeholder:text-slate-400")}
              />
            </div>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-6">
            {filteredHistory.length === 0 ? (
              <p className={cn("mt-8 text-center text-sm", dark ? "text-slate-400" : "text-slate-500")}>No conversations found.</p>
            ) : null}
            {filteredHistory.map((c) => {
              const last = [...c.messages].reverse().find((m) => m.id !== "welcome");
              return (
                <div
                  key={c.id}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl px-3 py-2.5",
                    c.id === activeId
                      ? dark ? "bg-cyan-500/10 ring-1 ring-cyan-400/30" : "bg-blue-50 ring-1 ring-blue-200"
                      : dark ? "bg-[#0e2038] ring-1 ring-cyan-400/10" : "bg-white ring-1 ring-slate-200",
                  )}
                >
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => { persist(conversations, c.id); setHistoryOpen(false); setTab("chat"); }}>
                    <D4Avatar size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className={cn("truncate text-sm font-semibold", dark ? "text-white" : "text-slate-900")}>{c.title}</p>
                        <span className="shrink-0 text-[10px] text-slate-400">{fmtDay(c.updatedAt)}</span>
                      </div>
                      <p className="truncate text-[11px] text-slate-400">{last ? last.content.slice(0, 70) : "New conversation"}</p>
                    </div>
                  </button>
                  <button type="button" className={cn("rounded-lg p-2", dark ? "text-slate-500 hover:text-rose-400" : "text-slate-400 hover:text-rose-500")} onClick={() => deleteChat(c.id)} aria-label="Delete conversation">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ---------- Settings full screen ---------- */}
      {settingsOpen ? (
        <div className="absolute inset-0 z-[70] flex flex-col" style={{ background: dark ? "radial-gradient(ellipse at top, #0b1a3a 0%, #050b18 45%, #020617 100%)" : "radial-gradient(ellipse at top, #e8f1ff 0%, #f5f9ff 45%, #ffffff 100%)" }}>
          <header className={cn("flex shrink-0 items-center gap-2 border-b px-3 py-3", dark ? "border-cyan-400/15 bg-[#0a1a33]/90" : "border-slate-200 bg-white/90")} style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
            <button type="button" onClick={() => setSettingsOpen(false)} className={cn("rounded-xl p-2", dark ? "text-white/90 hover:bg-white/10" : "text-slate-700 hover:bg-slate-100")} aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h2 className={cn("flex-1 text-lg font-bold", dark ? "text-white" : "text-slate-900")}>Settings</h2>
            <MoreVertical className={cn("h-5 w-5", dark ? "text-white/70" : "text-slate-500")} />
          </header>
          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <div className={cn("flex items-center gap-3 rounded-2xl px-4 py-3", dark ? "bg-[#0e2038] ring-1 ring-cyan-400/15" : "bg-white ring-1 ring-slate-200 shadow-sm")}>
              <D4Avatar size={44} />
              <div>
                <p className={cn("text-base font-bold", dark ? "text-white" : "text-slate-900")}>D4AI</p>
                <p className="text-[11px] text-cyan-300/90">v5-Ultimate</p>
              </div>
            </div>
            <div className={cn("overflow-hidden rounded-2xl", dark ? "bg-[#0e2038] ring-1 ring-cyan-400/15" : "bg-white ring-1 ring-slate-200 shadow-sm")}>
              {[
                { icon: theme === "dark" ? Moon : Sun, label: "Appearance", value: theme === "dark" ? "Dark Mode" : "Light Mode", action: toggleTheme },
                { icon: Globe, label: "Language", value: "English", action: () => setToast("Language: English") },
                { icon: Mic, label: "Voice Settings", value: autoSpeak ? "TTS & STT · On" : "TTS & STT", action: toggleAutoSpeak },
                { icon: Cpu, label: "Model Settings", value: "Llama 3.1 8B / LLaVA 7B", action: () => setToast("Model: D4AI v5-Ultimate") },
                { icon: Bell, label: "Notifications", value: "On", action: () => { setSettingsOpen(false); try { appNavigate(navigate, "/student/notifications"); } catch { navigate({ to: "/student/notifications" }); } } },
                { icon: Shield, label: "Privacy & Security", value: "", action: () => { setSettingsOpen(false); try { appNavigate(navigate, "/privacy"); } catch { navigate({ to: "/privacy" }); } } },
              ].map((row, i) => (
                <button
                  key={row.label}
                  type="button"
                  onClick={row.action}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3.5 text-left",
                    i > 0 && (dark ? "border-t border-white/5" : "border-t border-slate-100"),
                  )}
                >
                  <row.icon className="h-4.5 w-4.5 h-[18px] w-[18px] text-cyan-300" />
                  <span className={cn("flex-1 text-sm font-medium", dark ? "text-white" : "text-slate-900")}>{row.label}</span>
                  {row.value ? <span className="text-xs text-slate-400">{row.value}</span> : null}
                  <ChevronRight className="h-4 w-4 text-slate-500" />
                </button>
              ))}
            </div>
            <p className="pb-4 text-center text-[11px] text-slate-500">D4AI · built by Amurun Destiny under D4TECH</p>
          </div>
        </div>
      ) : null}

      {/* ---------- Main (home / chat) ---------- */}
      {!historyOpen && !settingsOpen ? (
        <>
          {header}
          <D4AiConnectionsSheet open={connectionsOpen} onClose={() => setConnectionsOpen(false)} session={session ?? null} />

          {tab === "home" ? homeView : chatView}

          {error ? <p className="px-4 pb-1 text-xs text-amber-300">{error}</p> : null}
          {composer}
          
        </>
      ) : null}

      {/* ---------- Drawer menu ---------- */}
      {drawer ? (
        <div className="absolute inset-0 z-[75] flex">
          <button type="button" className="absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} aria-label="Close menu" />
          <aside className={cn("relative z-10 flex h-full w-[84%] max-w-sm flex-col shadow-2xl", dark ? "bg-[#071428]" : "bg-white")} style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
            <div className="flex items-center gap-3 px-4 py-3">
              <D4Avatar size={44} />
              <div className="min-w-0 flex-1">
                <p className={cn("text-base font-bold", dark ? "text-white" : "text-slate-900")}>D4AI</p>
                <p className="flex items-center gap-1 text-[11px] text-cyan-300/90">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online · v5-Ultimate
                </p>
              </div>
              <button type="button" onClick={() => setDrawer(false)} className={cn("p-1", dark ? "text-white/70" : "text-slate-500")} aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-1 px-3 pt-2">
              <button type="button" onClick={startNewChat} className="flex w-full items-center gap-3 rounded-xl bg-gradient-to-r from-[#1d4ed8] to-[#2563eb] px-3 py-2.5 text-sm font-semibold text-white shadow-lg">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-white/15"><Plus className="h-4 w-4" /></span>
                New Chat
              </button>
              {[
                { icon: History, label: "Chat History", action: () => { setDrawer(false); setHistoryOpen(true); } },
                { icon: Wrench, label: "Tools & Integrations", action: () => { setDrawer(false); setConnectionsOpen(true); } },
                { icon: Phone, label: "Voice & Call", action: () => { setDrawer(false); startCallMode(); } },
                { icon: Settings, label: "Settings", action: () => { setDrawer(false); setSettingsOpen(true); } },
                { icon: Info, label: "About D4AI", action: () => { setDrawer(false); setAboutOpen(true); } },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={item.action}
                  className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium", dark ? "text-slate-200 hover:bg-white/5" : "text-slate-700 hover:bg-slate-100")}
                >
                  <item.icon className="h-4.5 w-4.5 h-[18px] w-[18px] text-cyan-300" />
                  {item.label}
                </button>
              ))}
            </div>

            <p className={cn("px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider", dark ? "text-slate-500" : "text-slate-400")}>Quick Actions</p>
            <div className="space-y-1 px-3 pb-4">
              <button type="button" onClick={clearChat} className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium", dark ? "text-slate-200 hover:bg-white/5" : "text-slate-700 hover:bg-slate-100")}>
                <Trash2 className="h-[18px] w-[18px] text-cyan-300" /> Clear Chat
              </button>
              <div className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium", dark ? "text-slate-200" : "text-slate-700")}>
                {dark ? <Moon className="h-[18px] w-[18px] text-cyan-300" /> : <Sun className="h-[18px] w-[18px] text-cyan-300" />}
                <span className="flex-1">Dark/Light Mode</span>
                <button
                  type="button"
                  onClick={toggleTheme}
                  className={cn("relative h-6 w-11 rounded-full transition", theme === "dark" ? "bg-cyan-500" : "bg-slate-300")}
                  aria-label="Toggle dark mode"
                >
                  <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", theme === "dark" ? "left-[22px]" : "left-0.5")} />
                </button>
              </div>
              <button
                type="button"
                onClick={() => { setDrawer(false); try { appNavigate(navigate, "/support"); } catch { navigate({ to: "/support" }); } }}
                className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium", dark ? "text-slate-200 hover:bg-white/5" : "text-slate-700 hover:bg-slate-100")}
              >
                <HelpCircle className="h-[18px] w-[18px] text-cyan-300" /> Help & Support
              </button>
              <button type="button" onClick={goBack} className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium", dark ? "text-slate-200 hover:bg-white/5" : "text-slate-700 hover:bg-slate-100")}>
                <LogOut className="h-[18px] w-[18px] text-cyan-300" /> Exit
              </button>
            </div>
            <p className="mt-auto pb-3 text-center text-[10px] text-slate-500">D4AI · Creating Solutions. Innovating Lives.</p>
          </aside>
        </div>
      ) : null}

      {/* ---------- Voice full screen (hidden when call minimized to bubble) ---------- */}
      {voiceOn && !callMinimized ? (
        <div
          className="absolute inset-0 z-[80] flex flex-col"
          style={{
            background: dark
              ? "radial-gradient(ellipse at top, #0b1a3a 0%, #050b18 45%, #020617 100%)"
              : "radial-gradient(ellipse at top, #e0f2fe 0%, #f8fafc 55%, #ffffff 100%)",
          }}
        >
          <div className="flex items-center gap-2 px-3 py-3" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
            <D4Avatar size={38} />
            <div className="min-w-0 flex-1">
              <p className={cn("text-base font-bold", dark ? "text-white" : "text-slate-900")}>D4AI</p>
              <p className="flex items-center gap-1 text-[11px] text-cyan-500">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online · v5-Ultimate
              </p>
            </div>
            {/* Voice picker */}
            <button
              type="button"
              onClick={() => {
              try { recognitionRef.current?.stop(); } catch {}
              setVoicePickerOpen(true);
            }}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold",
                dark ? "border-cyan-500/40 bg-[#0c1a33] text-cyan-100" : "border-slate-200 bg-white text-slate-700",
              )}
            >
              <span className="text-sm">{getVoiceChar(voicePreset).emoji}</span>
              <span>{getVoiceChar(voicePreset).name}</span>
              <span className="opacity-60">▾</span>
            </button>
          </div>

          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="relative grid h-40 w-40 place-items-center">
              {!voicePaused && !ttsSpeaking ? (
                <>
                  <span className="d4ai-ring absolute inset-0 rounded-full border-2 border-cyan-400/50" />
                  <span className="d4ai-ring absolute inset-0 rounded-full border-2 border-blue-400/40" style={{ animationDelay: "0.6s" }} />
                  <span className="d4ai-ring absolute inset-0 rounded-full border-2 border-fuchsia-400/30" style={{ animationDelay: "1.2s" }} />
                </>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  // Barge-in: stop AI speech and listen to user
                  if (ttsSpeakingRef.current || isAiSpeakingRef.current) {
                    try {
                      stopSpeaking();
                    } catch {}
                    setTtsSpeaking(false);
                    ttsSpeakingRef.current = false;
                    isAiSpeakingRef.current = false;
                    finalTranscriptRef.current = "";
                    setVoiceText("");
                    voicePausedRef.current = false;
                    setVoicePaused(false);
                    startVoice();
                    return;
                  }
                  if (voicePaused) resumeVoice();
                  else pauseVoice();
                }}
                className="relative z-10 grid h-28 w-28 place-items-center overflow-hidden rounded-full bg-gradient-to-b from-[#60a5fa] to-[#1d4ed8] shadow-[0_0_40px_rgba(59,130,246,0.55)] ring-4 ring-cyan-300/30"
                aria-label="Tap to speak"
              >
                <span className="relative inline-flex h-16 w-16 items-center justify-center">
                  <img src={LOGO} alt="D4AI" className="h-16 w-16 rounded-full object-cover" />
                  {/* Robotic talking mouth when D4AI is speaking */}
                  <span
                    className={cn("d4ai-talk-mouth", ttsSpeaking && "on")}
                    aria-hidden
                  />
                </span>
              </button>
            </div>
            <p className={cn("mt-6 text-lg font-semibold", dark ? "text-white" : "text-slate-900")}>
              {ttsSpeaking ? "D4AI is speaking…" : voicePaused ? "Paused" : "Tap to speak"}
            </p>
            <p className={cn("mt-1 text-sm", dark ? "text-slate-400" : "text-slate-500")}>
              {ttsSpeaking ? "Talk to interrupt" : voicePaused ? "Tap mic to resume" : callMode ? "Live call · talk and D4AI replies" : "Voice note · tap Send when done"}
            </p>
            <p className={cn("mt-1 font-mono text-sm", dark ? "text-cyan-300/80" : "text-blue-600")}>
              {String(Math.floor(voiceSecs / 60)).padStart(2, "0")}:{String(voiceSecs % 60).padStart(2, "0")}
            </p>
            <div
              className={cn(
                "mt-5 max-h-28 w-full max-w-sm overflow-y-auto rounded-2xl px-4 py-3 text-sm",
                dark ? "bg-[#0e2038] text-slate-200" : "bg-white text-slate-800 shadow",
              )}
            >
              {voiceText || (ttsSpeaking ? "…" : "Speak clearly…")}
            </div>
          </div>

          {/* Pause only in call mode (centered); Send only in voice-note mode */}
          <div className="flex items-center justify-center gap-3 px-4 pb-3">
            {callMode ? (
              <button
                type="button"
                onClick={() => {
                  if (voicePaused) resumeVoice();
                  else pauseVoice();
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-6 py-2.5 text-xs font-semibold",
                  dark ? "bg-white/10 text-cyan-100" : "bg-slate-100 text-slate-700",
                )}
              >
                {voicePaused ? <Play className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                {voicePaused ? "Resume" : "Pause"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (voicePaused) resumeVoice();
                    else pauseVoice();
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold",
                    dark ? "bg-white/10 text-cyan-100" : "bg-slate-100 text-slate-700",
                  )}
                >
                  {voicePaused ? <Play className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                  {voicePaused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  onClick={() => void finishVoiceAndSend()}
                  className="flex items-center gap-1.5 rounded-full bg-gradient-to-r from-[#3b82f6] to-[#1d4ed8] px-5 py-2 text-xs font-semibold text-white shadow-lg"
                >
                  <Send className="h-3.5 w-3.5" /> Send
                </button>
              </>
            )}
          </div>

          <div
            className="flex items-center justify-center gap-10 px-6 pb-6"
            style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
          >
            <button
              type="button"
              onClick={voiceToDraft}
              className={cn("grid h-12 w-12 place-items-center rounded-full", dark ? "bg-white/10 text-white" : "bg-slate-100 text-slate-700")}
              aria-label="Type instead"
            >
              <Keyboard className="h-5 w-5" />
            </button>
            {/* Toggle: robot = live call (AI talks back), speaker = voice note (Send to reply) */}
            <button
              type="button"
              onClick={() => {
                if (callMode) {
                  // switch to voice-note mode
                  setCallMode(false);
                  callModeRef.current = false;
                  stopSpeaking();
                  setTtsSpeaking(false);
                  if (silenceTimerRef.current) {
                    clearTimeout(silenceTimerRef.current);
                    silenceTimerRef.current = null;
                  }
                  if (!recognitionRef.current) startVoice();
                } else {
                  // switch to live call mode
                  setCallMode(true);
                  callModeRef.current = true;
                  setAutoSpeak(true);
                  autoSpeakRef.current = true;
                  try { localStorage.setItem(SPEAK_KEY, "1"); } catch {}
                  if (!recognitionRef.current) startVoice();
                }
              }}
              className="grid h-16 w-16 place-items-center overflow-hidden rounded-full bg-gradient-to-b from-[#60a5fa] to-[#1d4ed8] text-white shadow-xl ring-4 ring-cyan-400/30"
              aria-label={callMode ? "Switch to voice note" : "Switch to live call"}
            >
              {callMode ? (
                <img src={LOGO} alt="Call" className="h-10 w-10 rounded-full object-cover" />
              ) : (
                <Volume2 className="h-7 w-7 text-white" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                stopSpeaking();
                stopVoice(true);
              }}
              className={cn("grid h-12 w-12 place-items-center rounded-full", dark ? "bg-white/10 text-white" : "bg-slate-100 text-slate-700")}
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------- Attach popup ---------- */}
      
      {voicePickerOpen ? (
        <div className="absolute inset-0 z-[90] flex flex-col bg-black/60">
          <button type="button" className="absolute inset-0" aria-label="Close" onClick={() => setVoicePickerOpen(false)} />
          <div
            className={cn(
              "relative z-10 mt-auto max-h-[85%] overflow-hidden rounded-t-3xl border-t shadow-2xl",
              dark ? "border-cyan-500/20 bg-[#071428]" : "border-slate-200 bg-white",
            )}
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className={cn("text-base font-bold", dark ? "text-white" : "text-slate-900")}>Choose a voice</p>
                <p className="text-[11px] text-slate-400">12 D4AI characters · tap to preview</p>
              </div>
              <button type="button" onClick={() => {
                  setVoicePickerOpen(false);
                  if (callModeRef.current && voiceOn && !ttsSpeakingRef.current) {
                    window.setTimeout(() => startVoice(), 300);
                  }
                }} className="rounded-full p-2 text-slate-400 hover:bg-white/10">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-8" style={{ WebkitOverflowScrolling: "touch", maxHeight: "55vh" }}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {VOICE_CHARS.map((c) => {
                const active = voicePreset === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setVoicePreset(c.id);
                      try {
                        localStorage.setItem(VOICE_KEY, c.id);
                      } catch {}
                      stopSpeaking();
                      speakText(c.sample, {
                        preset: c.id,
                        onend: () => {},
                      });
                    }}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-2xl border p-3 text-center transition active:scale-[0.98]",
                      active
                        ? dark
                          ? "border-cyan-400/60 bg-cyan-500/15 ring-1 ring-cyan-400/40"
                          : "border-blue-400 bg-blue-50 ring-1 ring-blue-200"
                        : dark
                          ? "border-white/10 bg-white/5 hover:bg-white/10"
                          : "border-slate-200 bg-slate-50 hover:bg-slate-100",
                    )}
                  >
                    <span className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-cyan-500/30 via-blue-600/40 to-fuchsia-500/30 text-2xl ring-2 ring-cyan-300/30">
                      <span className="d4ai-write-char" style={{ animationDuration: "2.4s" }}>{c.emoji}</span>
                      <img src={LOGO} alt="" className="absolute inset-0 h-full w-full rounded-full object-cover opacity-25" />
                    </span>
                    <span className={cn("text-sm font-bold", dark ? "text-white" : "text-slate-900")}>{c.name}</span>
                    <span className="text-[10px] text-slate-400">{c.tag}</span>
                    {active ? <span className="text-[10px] font-semibold text-cyan-300">Selected</span> : null}
                  </button>
                );
              })}
            </div>
            </div>
            <div className="px-4 pb-2">
              <button
                type="button"
                onClick={() => setVoicePickerOpen(false)}
                className="w-full rounded-full bg-gradient-to-r from-[#3b82f6] to-[#1d4ed8] py-2.5 text-sm font-semibold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {attachOpen ? (
        <div className="absolute inset-0 z-[85] flex items-end justify-center bg-black/50 p-4">
          <button type="button" className="absolute inset-0" onClick={() => setAttachOpen(false)} aria-label="Close" />
          <div
            className={cn(
              "relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border shadow-xl",
              dark ? "border-cyan-500/20 bg-[#0c1a33]" : "border-slate-200 bg-white",
            )}
          >
            <p className={cn("px-4 py-3 text-sm font-semibold", dark ? "text-white" : "text-slate-900")}>
              Add to message
            </p>
            {[
              { icon: ImageIcon, label: "Image / Gallery", action: () => imageFileRef.current?.click() },
              { icon: Camera, label: "Camera", action: () => cameraFileRef.current?.click() },
              { icon: FileText, label: "Document / File", action: () => fileRef.current?.click() },
              { icon: Music2, label: "Audio", action: () => audioFileRef.current?.click() },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                className={cn(
                  "flex w-full items-center gap-3 border-t px-4 py-3.5 text-left text-sm",
                  dark ? "border-white/10 text-white hover:bg-white/5" : "border-slate-100 text-slate-800 hover:bg-slate-50",
                )}
                onClick={() => {
                  setAttachOpen(false);
                  item.action();
                }}
              >
                <item.icon className="h-5 w-5 text-cyan-400" />
                {item.label}
              </button>
            ))}
            <button
              type="button"
              className={cn(
                "flex w-full items-center justify-center border-t px-4 py-3 text-sm font-medium",
                dark ? "border-white/10 text-slate-400" : "border-slate-100 text-slate-500",
              )}
              onClick={() => setAttachOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------- Long-press options ---------- */}
      {longPress ? (
        <div className="absolute inset-0 z-[80] flex items-end justify-center bg-black/50 p-4">
          <button type="button" className="absolute inset-0" onClick={() => setLongPress(null)} aria-label="Close" />
          <div className={cn("relative z-10 w-full max-w-sm overflow-hidden rounded-2xl shadow-2xl", dark ? "bg-[#0c2244] ring-1 ring-cyan-400/20" : "bg-white ring-1 ring-slate-200")}>
            <div className="flex items-center justify-between px-4 pt-3">
              <span className={cn("text-xs font-semibold uppercase tracking-wide", dark ? "text-slate-400" : "text-slate-500")}>
                {longPress.role === "user" ? "Your message" : "D4AI message"}
              </span>
              <button type="button" onClick={() => setLongPress(null)} className={cn("p-1", dark ? "text-slate-400" : "text-slate-500")} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="py-1">
              <button
                type="button"
                className={cn("flex w-full items-center gap-3 px-4 py-3 text-left text-sm", dark ? "text-white hover:bg-white/5" : "text-slate-800 hover:bg-slate-50")}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(longPress.content);
                    setToast("Copied");
                  } catch {}
                  setLongPress(null);
                }}
              >
                <Copy className="h-4 w-4 text-cyan-300" /> Copy
              </button>
              {longPress.role === "user" ? (
                <>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-3 px-4 py-3 text-left text-sm", dark ? "text-white hover:bg-white/5" : "text-slate-800 hover:bg-slate-50")}
                    onClick={() => {
                      setEditMsg(longPress);
                      setEditText(longPress.content);
                      setLongPress(null);
                    }}
                  >
                    <Pencil className="h-4 w-4 text-cyan-300" /> Edit (your message)
                  </button>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-3 px-4 py-3 text-left text-sm", dark ? "text-white hover:bg-white/5" : "text-slate-800 hover:bg-slate-50")}
                    onClick={() => {
                      const content = longPress.content;
                      setLongPress(null);
                      void sendWithText(content);
                    }}
                  >
                    <RefreshCw className="h-4 w-4 text-cyan-300" /> Resend
                  </button>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-rose-400", dark ? "hover:bg-white/5" : "hover:bg-slate-50")}
                    onClick={() => {
                      deleteMsg(longPress);
                      setLongPress(null);
                    }}
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-3 px-4 py-3 text-left text-sm", dark ? "text-white hover:bg-white/5" : "text-slate-800 hover:bg-slate-50")}
                    onClick={() => {
                      doSpeak(longPress.content, longPress.id);
                      setLongPress(null);
                    }}
                  >
                    <Volume2 className="h-4 w-4 text-cyan-300" /> Speak (Text to Speech)
                  </button>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-3 px-4 py-3 text-left text-sm", dark ? "text-white hover:bg-white/5" : "text-slate-800 hover:bg-slate-50")}
                    onClick={() => void shareMsg(longPress)}
                  >
                    <Share2 className="h-4 w-4 text-cyan-300" /> Share
                  </button>
                  <button
                    type="button"
                    className={cn("flex w-full items-center gap-3 px-4 py-3 text-left text-sm", dark ? "text-white hover:bg-white/5" : "text-slate-800 hover:bg-slate-50")}
                    onClick={() => {
                      setLongPress(null);
                      setToast("Reported. Thank you.");
                    }}
                  >
                    <Flag className="h-4 w-4 text-cyan-300" /> Report
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Edit & resend ---------- */}
      {editMsg ? (
        <div className="absolute inset-0 z-[90] flex items-center justify-center bg-black/60 p-4">
          <div className={cn("w-full max-w-sm rounded-2xl p-4 shadow-2xl", dark ? "bg-[#0c2244] ring-1 ring-cyan-400/20" : "bg-white ring-1 ring-slate-200")}>
            <h3 className={cn("text-sm font-bold", dark ? "text-white" : "text-slate-900")}>Edit (your message)</h3>
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={4}
              className={cn("mt-2 w-full rounded-xl border px-3 py-2 text-sm focus:outline-none", dark ? "border-white/15 bg-white/5 text-white" : "border-slate-200 bg-slate-50 text-slate-900")}
            />
            <div className="mt-3 flex gap-2">
              <button type="button" className={cn("flex-1 rounded-xl py-2 text-sm", dark ? "bg-white/10 text-white" : "bg-slate-100 text-slate-700")} onClick={() => setEditMsg(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-gradient-to-r from-[#1d4ed8] to-[#2563eb] py-2 text-sm font-semibold text-white"
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

      {/* ---------- Tools & integrations ---------- */}
      {toolsOpen ? (
        <div className="absolute inset-0 z-[85] flex items-center justify-center bg-black/60 p-4">
          <div className={cn("w-full max-w-sm rounded-2xl p-5 text-center shadow-2xl", dark ? "bg-[#0c2244] ring-1 ring-cyan-400/20" : "bg-white ring-1 ring-slate-200")}>
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-cyan-500/15">
              <Wrench className="h-6 w-6 text-cyan-300" />
            </div>
            <h3 className={cn("text-base font-bold", dark ? "text-white" : "text-slate-900")}>Tools & Integrations</h3>
            <p className={cn("mt-1 text-sm", dark ? "text-slate-400" : "text-slate-600")}>
              Connect GitHub, Lovable, Supabase, and MCP servers to supercharge D4AI.
            </p>
            <div className="mt-4 flex gap-2">
              <button type="button" className={cn("flex-1 rounded-xl py-2 text-sm", dark ? "bg-white/10 text-white" : "bg-slate-100 text-slate-700")} onClick={() => setToolsOpen(false)}>
                Close
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-gradient-to-r from-[#1d4ed8] to-[#2563eb] py-2 text-sm font-semibold text-white"
                onClick={() => {
                  setToolsOpen(false);
                  setConnectionsOpen(true);
                }}
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- About ---------- */}
      {aboutOpen ? (
        <div className="absolute inset-0 z-[85] flex items-center justify-center bg-black/60 p-4">
          <div className={cn("w-full max-w-sm rounded-2xl p-5 text-center shadow-2xl", dark ? "bg-[#0c2244] ring-1 ring-cyan-400/20" : "bg-white ring-1 ring-slate-200")}>
            <img src={LOGO} alt="D4AI" className="mx-auto h-20 w-20 rounded-full object-cover ring-2 ring-cyan-400/50" />
            <h3 className="mt-3 bg-gradient-to-r from-cyan-400 via-sky-400 to-fuchsia-500 bg-clip-text text-2xl font-extrabold text-transparent">D4AI</h3>
            <p className="text-[11px] font-semibold tracking-[0.35em] text-slate-400">D4TECH</p>
            <p className={cn("mt-3 text-sm leading-relaxed", dark ? "text-slate-300" : "text-slate-600")}>
              D4AI is your all-round AI assistant — learning, research, coding, cybersecurity and more.
              Built by Amurun Destiny under D4TECH.
            </p>
            <p className="mt-2 text-xs text-cyan-300/80">Creating Solutions. Innovating Lives.</p>
            <button type="button" className="mt-4 w-full rounded-xl bg-gradient-to-r from-[#1d4ed8] to-[#2563eb] py-2 text-sm font-semibold text-white" onClick={() => setAboutOpen(false)}>
              Got it
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------- Toast ---------- */}
      {toast ? (
        <div className="pointer-events-none absolute bottom-28 left-1/2 z-[95] -translate-x-1/2">
          <div className={cn("rounded-full px-4 py-2 text-xs font-semibold shadow-xl", dark ? "bg-[#0e2038] text-cyan-200 ring-1 ring-cyan-400/30" : "bg-slate-900 text-white")}>
            {toast}
          </div>
        </div>
      ) : null}
    </div>
  );
}
