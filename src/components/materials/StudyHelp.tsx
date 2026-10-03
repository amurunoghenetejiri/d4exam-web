/**
 * Student-only Study Help — D4EXAM-branded YouTube experience.
 * Server-side search only; API key never in the client.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  Search,
  WifiOff,
  X,
  Youtube,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { searchStudyVideos, type StudyVideo } from "@/lib/youtube-study.server";
import { isOnlineNow } from "@/lib/offline-sync";
import { cn } from "@/lib/utils";

type Props = {
  materialId: string;
  title: string;
  courseLabel?: string;
  topic?: string | null;
  description?: string | null;
  ocrText?: string | null;
  className?: string;
  compact?: boolean;
  /** When a video is active — parent can enter split layout */
  onActiveChange?: (active: StudyVideo | null) => void;
  /** Embedded in material split (not fullscreen overlay) */
  embedMode?: boolean;
  onCloseEmbed?: () => void;
};

const localCacheKey = (id: string) => `d4_study_help_v1:${id}`;

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId: string;
          playerVars?: Record<string, number | string>;
          events?: {
            onReady?: (e: { target: YtPlayer }) => void;
            onStateChange?: (e: { data: number; target: YtPlayer }) => void;
          };
        },
      ) => YtPlayer;
      PlayerState?: { PLAYING: number; PAUSED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

type YtPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  setPlaybackRate: (rate: number) => void;
  getPlaybackRate: () => number;
  setVolume: (v: number) => void;
  getVolume: () => number;
  destroy: () => void;
};

function loadYtApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    if (!document.getElementById("d4-youtube-iframe-api")) {
      const s = document.createElement("script");
      s.id = "d4-youtube-iframe-api";
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    }
    // fallback if already loaded
    const t = window.setInterval(() => {
      if (window.YT?.Player) {
        window.clearInterval(t);
        resolve();
      }
    }, 200);
    window.setTimeout(() => {
      window.clearInterval(t);
      resolve();
    }, 8000);
  });
}

function Feedback({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <span className="rounded-xl bg-black/70 px-4 py-2 text-lg font-black text-white shadow-lg backdrop-blur-sm">
        {text}
      </span>
    </div>
  );
}

function BrandedPlayer({
  video,
  relatedLabel,
  onClose,
  fullscreen,
  onToggleFullscreen,
  onSearch,
}: {
  video: StudyVideo;
  relatedLabel: string;
  onClose: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onSearch?: () => void;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimer = useRef<number>(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastTap = useRef<{ t: number; side: "L" | "R" | null }>({ t: 0, side: null });

  const showFb = useCallback((text: string) => {
    setFeedback(text);
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 700);
  }, []);

  // PostMessage seek approx via youtube embed is limited; show feedback for UX
  function onPointerDown(e: React.PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const side: "L" | "R" = x < rect.width / 2 ? "L" : "R";
    const now = Date.now();
    if (now - lastTap.current.t < 280 && lastTap.current.side === side) {
      showFb(side === "L" ? "−10" : "+10");
      // Best-effort: focus iframe so user can use native controls
      try {
        iframeRef.current?.contentWindow?.postMessage(
          JSON.stringify({
            event: "command",
            func: "seekTo",
            args: [side === "L" ? -10 : 10, true],
          }),
          "*",
        );
      } catch {
        /* */
      }
      lastTap.current = { t: 0, side: null };
    } else {
      lastTap.current = { t: now, side };
    }
  }

  const embedSrc = `https://www.youtube.com/embed/${video.videoId}?rel=0&modestbranding=1&playsinline=1&enablejsapi=1&autoplay=1`;

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-[230] flex flex-col bg-[#0b1220] text-white"
          : "relative flex h-full min-h-0 w-full flex-col bg-[#0b1220] text-white"
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2 py-2 sm:px-3">
        <button type="button" className="rounded-lg p-2 text-white/80 hover:bg-white/10" onClick={onClose} aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-red-600">
          <Youtube className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-black tracking-wide">D4EXAM Study Help</p>
          <p className="truncate text-[10px] text-white/55">{relatedLabel}</p>
        </div>
        {onSearch ? (
          <button type="button" className="rounded-lg p-2 text-white/80 hover:bg-white/10" onClick={onSearch} aria-label="Search videos">
            <Search className="h-5 w-5" />
          </button>
        ) : null}
        <a href={video.url} target="_blank" rel="noreferrer" className="rounded-lg p-2 text-white/70 hover:bg-white/10" aria-label="Open on YouTube">
          <ExternalLink className="h-4 w-4" />
        </a>
        <button type="button" className="rounded-lg p-2 text-white/70 hover:bg-white/10" onClick={onToggleFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
      <div className="min-w-0 shrink-0 px-3 pb-1">
        <p className="truncate text-sm font-bold">{video.title}</p>
        <p className="truncate text-[11px] text-white/50">{video.channel}</p>
      </div>
      <div
        className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl bg-black ring-1 ring-white/10"
        style={{ minHeight: fullscreen ? "60vh" : "200px" }}
        onPointerDown={onPointerDown}
      >
        <iframe
          ref={iframeRef}
          title={video.title}
          src={embedSrc}
          className="absolute inset-0 h-full w-full border-0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
        />
        {feedback ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <span className="rounded-xl bg-black/70 px-4 py-2 text-lg font-black text-white">{feedback}</span>
          </div>
        ) : null}
      </div>
      <p className="shrink-0 px-3 pb-3 text-center text-[10px] text-white/35">
        Use player controls to pause, seek, and change quality · Fullscreen supports landscape & portrait
      </p>
    </div>
  );
}

export function StudyHelpPanel({
  materialId,
  title,
  courseLabel,
  topic,
  description,
  ocrText,
  className,
  compact,
  onActiveChange,
  embedMode,
  onCloseEmbed,
}: Props) {
  const [videos, setVideos] = useState<StudyVideo[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(() => !isOnlineNow());
  const [active, setActive] = useState<StudyVideo | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [customQuery, setCustomQuery] = useState<string | null>(null);


  const relatedLabel = useMemo(() => {
    return [courseLabel, topic, title].filter(Boolean).slice(0, 2).join(" · ") || title;
  }, [courseLabel, topic, title]);

  const setActiveVideo = useCallback(
    (v: StudyVideo | null) => {
      setActive(v);
      onActiveChange?.(v);
      if (!v) setFullscreen(false);
    },
    [onActiveChange],
  );

  async function load(force = false) {
    if (!isOnlineNow()) {
      setOffline(true);
      setError("Study Help unavailable offline — connect to the internet to find related study videos.");
      try {
        const raw = localStorage.getItem(localCacheKey(materialId));
        if (raw) {
          const parsed = JSON.parse(raw) as { videos?: StudyVideo[]; query?: string };
          if (parsed.videos?.length) {
            setVideos(parsed.videos);
            setQuery(parsed.query || "");
          }
        }
      } catch {
        /* */
      }
      return;
    }
    setOffline(false);
    setBusy(true);
    setError(null);
    try {
      if (!force) {
        try {
          const raw = localStorage.getItem(localCacheKey(materialId));
          if (raw) {
            const parsed = JSON.parse(raw) as { at?: number; videos?: StudyVideo[]; query?: string };
            if (parsed.videos?.length && parsed.at && Date.now() - parsed.at < 6 * 60 * 60 * 1000) {
              setVideos(parsed.videos);
              setQuery(parsed.query || "");
              setBusy(false);
              return;
            }
          }
        } catch {
          /* */
        }
      }
      const res = await searchStudyVideos({
        data: {
          materialId: customQuery ? `search:${customQuery}` : materialId,
          title: customQuery || title,
          course: customQuery ? "" : courseLabel || "",
          topic: customQuery || topic || "",
          description: customQuery ? "" : description || "",
          ocrText: customQuery ? "" : ocrText || "",
          maxResults: 12,
        },
      });
      const list = res?.videos ?? [];
      setVideos(list);
      setQuery(res?.query || "");
      if (res?.error) setError(res.error);
      try {
        localStorage.setItem(
          localCacheKey(materialId),
          JSON.stringify({ at: Date.now(), videos: list, query: res?.query || "" }),
        );
      } catch {
        /* */
      }
    } catch (e) {
      setError((e as Error)?.message || "Could not load study videos.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(Boolean(customQuery));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialId, customQuery]);

  const shown = showAll ? videos : videos.slice(0, compact ? 3 : 4);

  if (embedMode && active) {
    return (
      <BrandedPlayer
        video={active}
        relatedLabel={customQuery || relatedLabel}
        onClose={() => {
          setActiveVideo(null);
          onCloseEmbed?.();
        }}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen((f) => !f)}
        onSearch={() => {
          setFullscreen(false);
          setSearchOpen(true);
        }}
      />
    );
  }

  return (
    <section className={cn("overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm", className)}>
      <div className="flex items-center gap-2 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white px-3 py-2.5 sm:px-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-red-600 text-white">
          <Youtube className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-extrabold text-slate-900">Study Help</p>
          <p className="truncate text-[11px] text-slate-500">{customQuery ? `Search: ${customQuery}` : relatedLabel}</p>
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => setSearchOpen((s) => !s)} aria-label="Search">
          <Search className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          disabled={busy || offline}
          onClick={() => void load(true)}
          aria-label="Refresh"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>
      {searchOpen && (
        <form
          className="flex gap-2 border-b border-slate-100 bg-white px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            const q = searchQ.trim();
            if (!q) return;
            setCustomQuery(q);
            setSearchOpen(false);
            setShowAll(true);
          }}
        >
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search any educational topic…"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none ring-primary focus:ring-2"
            autoFocus
          />
          <Button type="submit" size="sm" className="shrink-0 font-bold">
            Search
          </Button>
        </form>
      )}

      {offline && (
        <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Study Help unavailable offline — connect to the internet to find related study videos.</p>
        </div>
      )}

      {error && !offline && (
        <p className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      {busy && videos.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Finding related videos…
        </div>
      )}

      {!busy && videos.length === 0 && !error && (
        <p className="px-3 py-8 text-center text-sm text-slate-500">No related videos found yet.</p>
      )}

      {videos.length > 0 && (
        <ul className="max-h-[50vh] divide-y divide-slate-100 overflow-y-auto overscroll-contain sm:max-h-[60vh]">
          {shown.map((v) => (
            <li key={v.videoId}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-slate-50 sm:px-4"
                onClick={() => setActiveVideo(v)}
              >
                <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-slate-200 sm:h-16 sm:w-28">
                  <img src={v.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
                  <span className="absolute inset-0 grid place-items-center bg-black/25">
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-red-600 text-white shadow">
                      <Play className="h-3.5 w-3.5 fill-current" />
                    </span>
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-xs font-bold text-slate-900 sm:text-sm">{v.title}</p>
                  <p className="mt-0.5 truncate text-[10px] font-medium text-slate-500">{v.channel}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {videos.length > (compact ? 3 : 4) && (
        <div className="border-t border-slate-100 px-3 py-2">
          <Button type="button" variant="ghost" size="sm" className="w-full text-xs font-semibold" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show less" : "View more study videos"}
          </Button>
        </div>
      )}

      {active && !embedMode && (
        <div className="fixed inset-0 z-[200] flex items-end justify-center bg-slate-950/75 p-0 backdrop-blur-sm sm:items-center sm:p-6">
          <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl shadow-2xl sm:rounded-2xl">
            <BrandedPlayer
              video={active}
              relatedLabel={customQuery || relatedLabel}
              onClose={() => setActiveVideo(null)}
              fullscreen={fullscreen}
              onToggleFullscreen={() => setFullscreen((f) => !f)}
              onSearch={() => {
                setFullscreen(false);
                setActiveVideo(null);
                setSearchOpen(true);
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
