import { useEffect, useRef, useState } from "react";
import { Check, CheckCheck, Download, FileText, Mic, Pause, Play, Pencil, Trash2, X, Send, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { globalAudio } from "@/lib/global-audio";

const SPEEDS = [1, 1.25, 1.5, 2] as const;

function fmtDur(s: number) {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

type VoiceReg = { id: string; play: () => void; pause: () => void };
const voiceOrder: string[] = [];
const voiceMap = new Map<string, VoiceReg>();
let activeVoiceId: string | null = null;

function registerVoice(id: string, reg: VoiceReg) {
  if (!voiceMap.has(id)) voiceOrder.push(id);
  voiceMap.set(id, reg);
}
function unregisterVoice(id: string) {
  voiceMap.delete(id);
  const i = voiceOrder.indexOf(id);
  if (i >= 0) voiceOrder.splice(i, 1);
  if (activeVoiceId === id) activeVoiceId = null;
}
function playVoice(id: string) {
  if (activeVoiceId && activeVoiceId !== id) {
    voiceMap.get(activeVoiceId)?.pause();
  }
  activeVoiceId = id;
  voiceMap.get(id)?.play();
}
export function stopAllVoices() {
  if (activeVoiceId) {
    voiceMap.get(activeVoiceId)?.pause();
    activeVoiceId = null;
  }
  for (const [, reg] of voiceMap) {
    try { reg.pause(); } catch { /* ignore */ }
  }
}

function onVoiceEnded(id: string) {
  if (activeVoiceId !== id) return;
  activeVoiceId = null;
  const i = voiceOrder.indexOf(id);
  if (i >= 0 && i < voiceOrder.length - 1) {
    const next = voiceOrder[i + 1];
    window.setTimeout(() => playVoice(next), 280);
  }
}

function WaveBars({
  active,
  light,
  progress = 0,
  onSeek,
}: {
  active?: boolean;
  light?: boolean;
  progress?: number;
  onSeek?: (ratio: number) => void;
}) {
  const heights = [6, 10, 14, 18, 12, 8, 16, 20, 14, 9, 13, 19, 11, 7, 15, 17, 12, 8, 14, 18, 10, 6, 12, 16, 11, 8, 13, 9];
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; active: boolean; seeking: boolean } | null>(null);
  const pct = Math.max(0, Math.min(1, progress));
  const filledCount = Math.min(heights.length, Math.floor(pct * heights.length + 0.001));

  const seekFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || !onSeek) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    onSeek(ratio);
  };

  return (
    <div
      ref={trackRef}
      className={cn("relative flex h-7 w-full items-center gap-[1.5px] overflow-visible px-1", onSeek && "cursor-pointer")}
      style={onSeek ? { touchAction: "pan-y" } : undefined}
      onPointerDown={(e) => {
        if (!onSeek) return;
        // Arm only - do NOT move board/ball on mere touch or click
        dragRef.current = { x: e.clientX, y: e.clientY, active: true, seeking: false };
      }}
      onPointerMove={(e) => {
        if (!onSeek || !dragRef.current?.active) return;
        const d = dragRef.current;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.seeking) {
          // Require clear intentional horizontal drag (22px). Vertical never seeks.
          if (Math.abs(dx) < 22) return;
          if (Math.abs(dy) >= Math.abs(dx) * 0.55) { d.active = false; return; }
          d.seeking = true;
          try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch {}
          e.preventDefault();
          e.stopPropagation();
          seekFromClientX(e.clientX);
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        seekFromClientX(e.clientX);
      }}
      onPointerUp={(e) => {
        if (dragRef.current?.seeking) e.stopPropagation();
        dragRef.current = null;
      }}
      onPointerCancel={() => { dragRef.current = null; }}
      onClick={(e) => {
        // Never seek on click/tap - only drag moves the board
        e.stopPropagation();
      }}
    >
      {heights.map((h, i) => {
        const passed = i < filledCount;
        return (
          <span
            key={i}
            className={cn(
              "min-w-[2px] flex-1 rounded-full transition-colors duration-100",
              light ? (passed ? "bg-white" : "bg-white/35") : (passed ? "bg-[#2563eb]" : "bg-[#93c5fd]/70"),
              active && !passed && "animate-pulse",
            )}
            style={{
              height: active && !passed ? h + (i % 3) : h,
              animationDelay: `${i * 28}ms`,
              animationDuration: "0.9s",
            }}
          />
        );
      })}
      {onSeek ? (
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md ring-2 ring-white",
            light ? "bg-white" : "bg-[#2563eb]",
          )}
          style={{ left: `${pct * 100}%`, transition: "none" }}
        />
      ) : null}
    </div>
  );
}

export function VoiceBubble({
  src,
  mine,
  timeLabel,
  tick,
  id,
  durationSec,
}: {
  src: string;
  mine: boolean;
  timeLabel: string;
  tick?: "none" | "sent" | "delivered" | "read" | "pending";
  id?: string;
  /** Known duration (seconds) from recording — used until audio metadata loads */
  durationSec?: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [speedOpen, setSpeedOpen] = useState(false);
  const voiceId = id || src;

  useEffect(() => {
    // Prefetch duration only (playback is owned by globalAudio so it survives navigation)
    const a = new Audio();
    a.preload = "metadata";
    a.src = src;
    audioRef.current = a;
    const applyDur = () => {
      const d = a.duration;
      if (Number.isFinite(d) && d > 0 && d < 1e6) setDur(d);
    };
    a.addEventListener("loadedmetadata", applyDur);
    void a.load();

    const unsub = globalAudio.subscribe((s) => {
      if (s.voiceId !== voiceId) {
        setPlaying((prev) => (prev ? false : prev));
        return;
      }
      setPlaying(s.playing);
      setCur(s.currentTime || 0);
      if (s.duration > 0) setDur(s.duration);
    });

    registerVoice(voiceId, {
      id: voiceId,
      play: () => {
        globalAudio.playVoice(voiceId, src, mine ? "You" : "Contact", SPEEDS[speedIdx]);
      },
      pause: () => {
        globalAudio.pause();
      },
    });

    const onEnded = (e: Event) => {
      const d = (e as CustomEvent<{ voiceId?: string }>).detail;
      if (d?.voiceId === voiceId) onVoiceEnded(voiceId);
    };
    window.addEventListener("d4-voice-ended", onEnded);

    return () => {
      unsub();
      unregisterVoice(voiceId);
      window.removeEventListener("d4-voice-ended", onEnded);
      a.removeEventListener("loadedmetadata", applyDur);
      // Do NOT stop globalAudio here — allows continuous playback across pages
      audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, voiceId]);

  useEffect(() => {
    if (globalAudio.getState().voiceId === voiceId) {
      globalAudio.setRate(SPEEDS[speedIdx]);
    }
  }, [speedIdx, voiceId]);

  const toggle = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (activeVoiceId === voiceId) activeVoiceId = null;
    } else {
      playVoice(voiceId);
    }
  };

  const own = mine;
  // Prefer real audio duration; fall back to recorded durationSec
  const effectiveDur = dur > 0 ? dur : (durationSec != null && durationSec > 0 ? durationSec : 0);
  const timeShown = playing
    ? fmtDur(cur)
    : (effectiveDur > 0 ? fmtDur(effectiveDur) : "0:00");

  return (
    <div
      id={id}
      data-duration={effectiveDur > 0 ? String(Math.round(effectiveDur)) : undefined}
      className={cn(
        "flex min-w-[200px] flex-col gap-0.5 select-none",
        "w-[min(78vw,280px)] sm:min-w-[240px] md:w-[min(52vw,360px)] lg:w-[min(40vw,420px)] lg:min-w-[280px]",
        own ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative flex w-full flex-col rounded-2xl px-2.5 py-2.5 shadow-sm",
          own ? "border border-slate-200 bg-white text-slate-800" : "bg-[#2563eb] text-white",
        )}
        onCopy={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Row: play + waves + speed — vertically centered together */}
        <div className="flex w-full items-center gap-2.5">
        <button
          type="button"
          onClick={toggle}
          className={cn(
            "grid h-9 w-9 lg:h-11 lg:w-11 shrink-0 place-items-center self-center rounded-full shadow-sm",
            own ? "bg-[#2563eb] text-white" : "bg-white text-[#2563eb]",
          )}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="ml-0.5 h-3.5 w-3.5" />}
        </button>
        <div className="flex min-w-0 flex-1 items-center self-center pl-0.5">
          <WaveBars
            active={playing}
            light={!own}
            progress={effectiveDur > 0 ? Math.min(1, cur / effectiveDur) : 0}
            onSeek={(ratio) => {
              if (globalAudio.getState().voiceId === voiceId) {
                globalAudio.seek(ratio);
              } else {
                const a = audioRef.current;
                if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
                setCur(ratio * a.duration);
              }
            }}
          />
        </div>
        <div className="relative shrink-0 self-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSpeedOpen((v) => !v);
            }}
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[10px] font-bold",
              own ? "bg-slate-100 text-slate-700" : "bg-white/20 text-white",
            )}
          >
            {SPEEDS[speedIdx]}x
          </button>
          {speedOpen ? (
            <div className="absolute bottom-full right-0 z-20 mb-1 min-w-[4.5rem] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {SPEEDS.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[11px] font-semibold text-slate-800 hover:bg-slate-50",
                    i === speedIdx && "text-[#2563eb]",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSpeedIdx(i);
                    setSpeedOpen(false);
                  }}
                >
                  {s.toFixed(1).replace(/\.0$/, "")}x
                  {i === speedIdx ? <Check className="h-3 w-3" /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        </div>
        {/* Duration sits below the centered play / waves / speed row */}
        <div
          className={cn(
            "mt-1 text-center text-[10px] font-medium tabular-nums leading-none",
            own ? "text-slate-400" : "text-white/80",
          )}
        >
          {timeShown}
        </div>
      </div>
      <div className={cn("flex items-center gap-1 px-1 text-[10px]", own ? "text-slate-400" : "text-slate-400")}>
        <span>{timeLabel}</span>
        {tick && tick !== "none" ? (
          tick === "pending" ? (
            <Clock className="h-3.5 w-3.5 text-slate-400" />
          ) : tick === "read" ? (
            <CheckCheck className="h-3.5 w-3.5 text-[#2563eb]" />
          ) : tick === "sent" ? (
            <Check className="h-3.5 w-3.5 text-slate-400" />
          ) : (
            <CheckCheck className="h-3.5 w-3.5 text-slate-400" />
          )
        ) : null}
      </div>
    </div>
  );
}

export function VoiceRecorderBar({
  recording,
  paused,
  seconds,
  previewUrl,
  onCancel,
  onPause,
  onContinue,
  onPreviewPlay,
  onSend,
}: {
  recording: boolean;
  paused: boolean;
  seconds: number;
  previewUrl: string | null;
  onCancel: () => void;
  onPause: () => void;
  onContinue: () => void;
  onPreviewPlay: () => void;
  onSend: () => void;
}) {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return (
    <div className="mb-0 select-none rounded-xl border border-blue-200/80 bg-gradient-to-b from-[#eff6ff] to-white px-3 py-2.5 shadow-sm">
      <div className="mb-2 flex flex-col items-center gap-1">
        <div className="w-full max-w-[200px] mx-auto">
          {/* Live wave motion only — no navy progress fill sweeping across bars */}
          <WaveBars active={recording && !paused} />
        </div>
        <p className="text-sm font-bold tabular-nums text-slate-800">
          {mm}:{ss}
        </p>
        {paused ? (
          <p className="text-[10px] font-medium text-slate-500">Paused</p>
        ) : null}
      </div>
      <div className="flex items-center justify-center gap-4">
        <button type="button" onClick={onCancel} className="flex flex-col items-center gap-0.5 text-slate-500">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-100">
            <X className="h-4 w-4" />
          </span>
          <span className="text-[9px] font-semibold">Cancel</span>
        </button>
        {paused ? (
          <>
            <button type="button" onClick={onPreviewPlay} className="flex flex-col items-center gap-0.5 text-slate-600">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-800 text-white">
                <Play className="ml-0.5 h-4 w-4" />
              </span>
              <span className="text-[9px] font-semibold">Play</span>
            </button>
            <button type="button" onClick={onContinue} className="flex flex-col items-center gap-0.5">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-[#2563eb] text-white shadow-md">
                <Mic className="h-5 w-5" />
              </span>
              <span className="text-[9px] font-semibold text-slate-600">Resume</span>
            </button>
          </>
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

export function parseMediaUrls(url: string | null | undefined): string[] {
  if (!url) return [];
  const s = url.trim();
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  if (s.includes("||")) return s.split("||").map((x) => x.trim()).filter(Boolean);
  return [s];
}

export function encodeOfficerMedia(text: string, type: string, url: string): string {
  const body = (text || "").trim();
  const marker = `__media__|${type}|${url}`;
  return body ? `${body}\n${marker}` : marker;
}

export function parseOfficerReply(raw: string | null | undefined): {
  text: string;
  mediaType?: string;
  mediaUrl?: string;
} {
  const s = (raw || "").trim();
  if (!s) return { text: "" };
  const m = s.match(/(?:^|\n)__media__\|([^|]+)\|(.+)$/);
  if (m) {
    const text = s.replace(/(?:^|\n)__media__\|[^|]+\|.+$/, "").trim();
    return { text: text === "(attachment)" ? "" : text, mediaType: m[1], mediaUrl: m[2] };
  }
  return { text: s === "(attachment)" ? "" : s };
}

export function attachmentLabel(type: string | null | undefined, url?: string | null): string {
  const urls = parseMediaUrls(url);
  const n = Math.max(1, urls.length);
  if (type === "audio") return n > 1 ? `${n} voice notes` : "Voice note";
  if (type === "image" || type === "images") return n > 1 ? `${n} photos` : "Photo";
  if (type === "video" || type === "videos") return n > 1 ? `${n} videos` : "Video";
  if (type === "file") return n > 1 ? `${n} files` : "File";
  return "Attachment";
}

export function ImageBubble({
  src,
  timeLabel,
  tick,
  onOpen,
  id,
  count,
}: {
  src: string;
  mine?: boolean;
  timeLabel: string;
  tick?: "none" | "sent" | "delivered" | "read" | "pending";
  onOpen: (index?: number) => void;
  id?: string;
  count?: number;
}) {
  return (
    <button
      id={id}
      type="button"
      onClick={() => onOpen(0)}
      className="relative block max-w-[min(38vw,128px)] sm:max-w-[min(42vw,148px)] md:max-w-[min(30vw,200px)] lg:max-w-[min(24vw,240px)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      onContextMenu={(e) => e.preventDefault()}
    >
      <img src={src} alt="" className="max-h-[min(70vh,28rem)] w-full object-contain bg-black/5" draggable={false} />
      {(count || 0) > 1 ? (
        <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white">
          +{(count || 1) - 1}
        </span>
      ) : null}
      <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
        <span>{timeLabel}</span>
        {tick === "pending" ? (
          <Clock className="h-3 w-3 text-white/90" />
        ) : tick === "read" ? (
          <CheckCheck className="h-3 w-3 text-sky-300" />
        ) : tick === "delivered" || tick === "sent" ? (
          <CheckCheck className="h-3 w-3 text-white/80" />
        ) : null}
      </div>
    </button>
  );
}

export function VideoBubble({
  src,
  timeLabel,
  tick,
  onOpen,
  id,
  durationSec,
  forwarded,
}: {
  src: string;
  mine?: boolean;
  timeLabel: string;
  tick?: "none" | "sent" | "delivered" | "read" | "pending";
  onOpen: () => void;
  id?: string;
  durationSec?: number | null;
  forwarded?: boolean;
}) {
  const dur =
    durationSec != null && durationSec > 0
      ? `${Math.floor(durationSec / 60)}:${String(Math.round(durationSec) % 60).padStart(2, "0")}`
      : null;
  return (
    <button
      id={id}
      type="button"
      onClick={onOpen}
      className="relative block max-w-[min(38vw,128px)] sm:max-w-[min(42vw,148px)] overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-sm"
      onContextMenu={(e) => e.preventDefault()}
    >
      {forwarded ? (
        <span className="absolute left-2 top-2 z-10 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-white">
          ↗ Forwarded
        </span>
      ) : null}
      <video
        src={src}
        className="max-h-[min(70vh,28rem)] w-full object-contain bg-black"
        muted
        playsInline
        preload="metadata"
        // seek to first frame for poster-like preview
        onLoadedMetadata={(e) => {
          try {
            const v = e.currentTarget;
            if (v.currentTime < 0.1) v.currentTime = 0.1;
          } catch { /* ignore */ }
        }}
      />
      <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/25">
        {tick === "pending" ? (
          <span className="grid h-14 w-14 place-items-center rounded-full bg-black/55 text-white shadow-lg ring-2 ring-white/50">
            <Clock className="h-7 w-7 animate-pulse" />
          </span>
        ) : (
          <span className="grid h-14 w-14 place-items-center rounded-full bg-black/55 text-white shadow-lg ring-2 ring-white/50">
            <Play className="ml-1 h-7 w-7 fill-white" />
          </span>
        )}
      </span>
      <span className="absolute bottom-1.5 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-white">
        {dur ? <span>{dur}</span> : null}
        <span>{timeLabel}</span>
        {tick === "pending" ? (
          <Clock className="h-3 w-3" />
        ) : tick && tick !== "none" ? (
          tick === "read" ? (
            <CheckCheck className="h-3 w-3 text-sky-300" />
          ) : (
            <CheckCheck className="h-3 w-3" />
          )
        ) : null}
      </span>
    </button>
  );
}


export function FileBubble({
  src,
  timeLabel,
  tick,
  id,
  name,
  mine,
}: {
  src: string;
  mine?: boolean;
  timeLabel: string;
  tick?: "none" | "sent" | "delivered" | "read" | "pending";
  id?: string;
  name?: string;
}) {
  const label = name || decodeURIComponent(src.split("/").pop()?.split("?")[0] || "Document");
  const isPdf = /\.pdf($|\?)/i.test(src) || /pdf/i.test(label);
  const isDoc = /\.(docx?|rtf)($|\?)/i.test(src) || /word/i.test(label);
  const isSheet = /\.(xlsx?|csv)($|\?)/i.test(src);
  const kind = isPdf ? "PDF" : isDoc ? "DOC" : isSheet ? "XLS" : "FILE";
  const accent = isPdf ? "bg-rose-500" : isDoc ? "bg-blue-600" : isSheet ? "bg-emerald-600" : "bg-slate-600";

  const openNative = (e: { preventDefault: () => void; stopPropagation?: () => void }) => {
    e.preventDefault();
    // Open in new tab so the OS/browser offers "Open with…" for PDFs
    const a = document.createElement("a");
    a.href = src;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    // Intentionally no download attr so mobile can use installed PDF apps
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadFile = (e: { preventDefault: () => void; stopPropagation?: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    const a = document.createElement("a");
    a.href = src;
    a.download = label;
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div
      id={id}
      className="w-[min(56vw,180px)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      <button
        type="button"
        onClick={openNative}
        className="flex w-full items-center gap-3 px-3 py-3 text-left active:bg-slate-50"
      >
        <span
          className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${accent} text-[11px] font-black tracking-wide text-white shadow-sm`}
        >
          {kind}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-slate-900">{label}</p>
          <p className="mt-0.5 text-[11px] font-medium text-slate-500">
            {kind} document · Tap to open
          </p>
        </div>
      </button>
      <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2">
        <button
          type="button"
          onClick={downloadFile}
          className="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700 active:bg-slate-200"
        >
          Download
        </button>
        <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-slate-400">
          {timeLabel}
          {tick && tick !== "none" ? (
            tick === "pending" ? (
              <Clock className="h-3 w-3" />
            ) : (
              <CheckCheck className="h-3 w-3" />
            )
          ) : null}
        </span>
      </div>
    </div>
  );
}


export function ImageLightbox({
  src,
  urls,
  index = 0,
  onClose,
}: {
  src?: string;
  urls?: string[];
  index?: number;
  onClose: () => void;
}) {
  const list = (urls && urls.length ? urls : src ? [src] : []).filter(Boolean);
  const [i, setI] = useState(() => Math.min(Math.max(0, index), Math.max(0, list.length - 1)));
  const [scale, setScale] = useState(1);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const touchRef = useRef<{ x: number; y: number; axis: "none" | "h" | "v" } | null>(null);
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);

  useEffect(() => {
    setI(Math.min(Math.max(0, index), Math.max(0, list.length - 1)));
  }, [index, list.length]);
  useEffect(() => {
    setScale(1);
    setDragX(0);
  }, [i]);

  if (!list.length) return null;
  const cur = list[Math.min(i, list.length - 1)];
  const atStart = i <= 0;
  const atEnd = i >= list.length - 1;

  const go = (dir: -1 | 1) => {
    setI((prev) => {
      const next = prev + dir;
      if (next < 0) return 0;
      if (next >= list.length) return list.length - 1;
      return next;
    });
    setScale(1);
    setDragX(0);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black"
      onTouchStart={(e) => {
        if (e.touches.length === 2) {
          const d = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
          pinchRef.current = { dist: d, scale };
          return;
        }
        if (scale > 1.05) return;
        touchRef.current = {
          x: e.touches[0]?.clientX ?? 0,
          y: e.touches[0]?.clientY ?? 0,
          axis: "none",
        };
        setDragging(true);
      }}
      onTouchMove={(e) => {
        if (e.touches.length === 2 && pinchRef.current) {
          e.preventDefault();
          const d = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
          );
          setScale(
            Math.max(1, Math.min(4, pinchRef.current.scale * (d / Math.max(1, pinchRef.current.dist)))),
          );
          return;
        }
        const t = touchRef.current;
        if (!t || scale > 1.05) return;
        const x = e.touches[0]?.clientX ?? 0;
        const y = e.touches[0]?.clientY ?? 0;
        const dx = x - t.x;
        const dy = y - t.y;
        if (t.axis === "none") {
          if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
          t.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "h" : "v";
        }
        if (t.axis !== "h") return;
        // Rubber-band at ends: resist further drag
        let next = dx;
        if ((atStart && dx > 0) || (atEnd && dx < 0)) next = dx * 0.25;
        setDragX(next);
      }}
      onTouchEnd={() => {
        pinchRef.current = null;
        const t = touchRef.current;
        touchRef.current = null;
        setDragging(false);
        if (scale > 1.05) {
          if (scale < 1.05) setScale(1);
          return;
        }
        const dx = dragX;
        setDragX(0);
        if (dx < -60 && !atEnd) go(1);
        else if (dx > 60 && !atStart) go(-1);
      }}
      onDoubleClick={() => setScale((s) => (s > 1 ? 1 : 2))}
    >
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          className="grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        {list.length > 1 ? (
          <span className="rounded-full bg-black/40 px-3 py-1 text-xs font-semibold text-white backdrop-blur-sm">
            {i + 1} / {list.length}
          </span>
        ) : (
          <span />
        )}
        <span className="w-10" />
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <img
          src={cur}
          alt=""
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{
            transform: `translateX(${dragX}px) scale(${scale})`,
            transition: dragging ? "none" : "transform 0.22s ease-out",
          }}
        />
        {/* Peek next/prev while dragging */}
        {list.length > 1 && dragX < -20 && !atEnd ? (
          <img
            src={list[i + 1]}
            alt=""
            className="pointer-events-none absolute max-h-full max-w-full object-contain opacity-40"
            style={{ transform: `translateX(${typeof window !== "undefined" ? window.innerWidth + dragX : 400}px)` }}
          />
        ) : null}
        {list.length > 1 && dragX > 20 && !atStart ? (
          <img
            src={list[i - 1]}
            alt=""
            className="pointer-events-none absolute max-h-full max-w-full object-contain opacity-40"
            style={{ transform: `translateX(${typeof window !== "undefined" ? -window.innerWidth + dragX : -400}px)` }}
          />
        ) : null}
      </div>
      {list.length > 1 ? (
        <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            disabled={atStart}
            onClick={() => go(-1)}
            className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white disabled:opacity-30"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={atEnd}
            onClick={() => go(1)}
            className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white disabled:opacity-30"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}


export function VideoLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const seeking = useRef(false);
  const [scale, setScale] = useState(1);
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    void v.play().catch(() => setPlaying(false));
    const onMeta = () => setDur(v.duration || 0);
    const onTime = () => {
      if (!seeking.current) setCur(v.currentTime || 0);
    };
    const onEnd = () => setPlaying(false);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnd);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnd);
    };
  }, [src]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.pause();
      setPlaying(false);
    } else {
      void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  };

  const seekRatio = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      v.currentTime = ratio * v.duration;
      setCur(v.currentTime);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-black">
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          className="grid h-10 w-10 place-items-center rounded-full bg-black/40 text-white backdrop-blur-sm"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        <button type="button" onClick={async () => { try { const res = await fetch(src); const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "video.mp4"; a.click(); URL.revokeObjectURL(url); } catch {} }} className="grid h-10 w-10 place-items-center rounded-full bg-black/50 text-white ring-1 ring-white/20" aria-label="Download"><Download className="h-5 w-5" /></button>
        <p className="rounded-full bg-black/40 px-3 py-1 text-sm font-semibold text-white backdrop-blur-sm">Video</p>
        <span className="w-10" />
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center" onClick={toggle}>
        <video
          ref={videoRef}
          src={src}
          className="max-h-full max-w-full object-contain"
          playsInline
          onDoubleClick={() => {
            const v = videoRef.current;
            if (!v) return;
            v.currentTime = Math.min((v.duration || 0), (v.currentTime || 0) + 10);
          }}
        />
        {!playing ? (
          <span className="pointer-events-none absolute grid h-14 w-14 place-items-center rounded-full bg-black/50 text-white">
            <Play className="ml-1 h-7 w-7" />
          </span>
        ) : null}
      </div>
      <div className="z-10 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        <div
          className="relative h-1.5 w-full cursor-pointer rounded-full bg-white/25"
          onPointerDown={(e) => {
            seeking.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            seekRatio(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (!seeking.current || e.buttons !== 1) return;
            seekRatio(e.clientX, e.currentTarget);
          }}
          onPointerUp={() => {
            seeking.current = false;
          }}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white"
            style={{ width: `${dur > 0 ? (cur / dur) * 100 : 0}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-white/80">
          <span>{fmtDur(cur)}</span>
          <span>{fmtDur(dur)}</span>
        </div>
      </div>
    </div>
  );
}

export function LongPressMenu({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: { label: string; icon?: "edit" | "delete" | "download" | "copy"; danger?: boolean; onClick: () => void }[];
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[85] flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        className="mb-[max(0.5rem,env(safe-area-inset-bottom))] w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            className={cn(
              "flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3.5 text-left text-sm font-semibold last:border-0",
              it.danger ? "text-red-600" : "text-slate-800",
            )}
            onClick={() => {
              it.onClick();
              onClose();
            }}
          >
            {it.icon === "edit" ? <Pencil className="h-4 w-4" /> : null}
            {it.icon === "delete" ? <Trash2 className="h-4 w-4" /> : null}
            {it.icon === "download" ? <Download className="h-4 w-4" /> : null}
            {it.label}
          </button>
        ))}
        <button type="button" className="w-full px-4 py-3.5 text-sm font-bold text-slate-500" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function lastSeenLabel(atMs: number | null | undefined): string {
  if (!atMs) return "Last seen just now";
  const diff = Date.now() - atMs;
  if (diff < 45_000) return "Last seen just now";
  if (diff < 3600_000) {
    const m = Math.max(1, Math.floor(diff / 60_000));
    return m === 1 ? "Last seen 1 minute ago" : `Last seen ${m} minutes ago`;
  }
  if (diff < 86400_000) {
    const h = Math.floor(diff / 3600_000);
    return h === 1 ? "Last seen 1 hour ago" : `Last seen ${h} hours ago`;
  }
  const days = Math.floor(diff / 86400_000);
  if (days === 1) return "Last seen yesterday";
  return `Last seen ${days} days ago`;
}

export function MessageTicks({ state }: { state: "none" | "pending" | "sent" | "delivered" | "read" }) {
  if (state === "none") return null;
  if (state === "pending") return <Clock className="inline h-3.5 w-3.5 text-slate-400" aria-label="Pending" />;
  if (state === "sent") return <Check className="inline h-3.5 w-3.5 text-slate-400" aria-label="Sent" />;
  if (state === "delivered") return <CheckCheck className="inline h-3.5 w-3.5 text-slate-400" aria-label="Delivered" />;
  return <CheckCheck className="inline h-3.5 w-3.5 text-[#2563eb]" aria-label="Read" />;
}
