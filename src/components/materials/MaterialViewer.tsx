import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Minus,
  Plus,
  Bookmark,
  MoreVertical,
  X,
  File,
  Share2,
  Save,
  Maximize2,
  Type,
  Youtube,
  GraduationCap,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  loadMaterialAnn,
  saveMaterialAnn,
  type MaterialAnnState,
} from "@/lib/material-annotations";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useSessionUser } from "@/lib/session";
import { runImageOcr, downloadTextFile, openPrintableOcr } from "@/lib/material-ocr";
import { isMaterialOffline, saveMaterialOffline, getOfflineMaterial } from "@/lib/material-offline";
import { isOnlineNow } from "@/lib/offline-sync";
import { supabase } from "@/integrations/supabase/client";
import { StudyHelpPanel } from "@/components/materials/StudyHelp";
import { getAppOrigin } from "@/lib/app-url";

export type ViewerMaterial = {
  id: string;
  title: string;
  description: string | null;
  material_type: string;
  file_url: string | null;
  file_name: string | null;
  file_mime: string | null;
  uploader_name?: string | null;
  uploader_role?: string | null;
  created_at?: string;
  file_size?: number | null;
  course_id?: string;
  ocr_text?: string | null;
  ocr_status?: string | null;
};

type Props = {
  item: ViewerMaterial;
  siblings: ViewerMaterial[];
  courseLabel?: string | null;
  /** Students see Study Help; teachers never do */
  role?: "teacher" | "student";
  topic?: string | null;
  onClose: () => void;
  onNavigate: (m: ViewerMaterial) => void;
  onItemPatch?: (id: string, patch: Partial<ViewerMaterial>) => void;
};

function isPdf(m: ViewerMaterial) {
  const mime = (m.file_mime || "").toLowerCase();
  const name = (m.file_name || m.file_url || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf");
}

function isImage(m: ViewerMaterial) {
  const mime = (m.file_mime || "").toLowerCase();
  const name = (m.file_name || m.file_url || m.title || "").toLowerCase();
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
}

function isText(m: ViewerMaterial) {
  const mime = (m.file_mime || "").toLowerCase();
  const name = (m.file_name || m.file_url || m.title || "").toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (mime.includes("json") || mime.includes("xml") || mime.includes("javascript")) return true;
  return /\.(txt|md|csv|tsv|json|xml|log|html?|css|js|ts|tsx|jsx|rtf)$/i.test(name);
}

function isOffice(m: ViewerMaterial) {
  const mime = (m.file_mime || "").toLowerCase();
  const name = (m.file_name || m.file_url || m.title || "").toLowerCase();
  return (
    mime.includes("word") ||
    mime.includes("officedocument") ||
    mime.includes("msword") ||
    mime.includes("spreadsheet") ||
    mime.includes("presentation") ||
    /\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(name)
  );
}

function typeLabel(t: string) {
  const map: Record<string, string> = {
    notes: "Notes",
    assignment: "Assignment",
    study_guide: "Study guide",
    past_question: "Past question",
    reading_tips: "Reading tips",
    other: "Other",
  };
  return map[t] || t;
}

export function MaterialViewer({ item, siblings, courseLabel, role = "student", topic, onClose, onNavigate, onItemPatch }: Props) {
  const { data: session } = useSessionUser();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pdfDocRef = useRef<{ numPages: number; getPage: (n: number) => Promise<any> } | null>(null);

  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [annState, setAnnState] = useState<MaterialAnnState>(() => loadMaterialAnn(item.id));
  const [moreOpen, setMoreOpen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [hintVisible, setHintVisible] = useState(true);
  const [goPageOpen, setGoPageOpen] = useState(false);
  const [goPage, setGoPage] = useState("");
  const [ocrOpen, setOcrOpen] = useState(false);
  const [studyHelpOpen, setStudyHelpOpen] = useState(false);
  const [studySplit, setStudySplit] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [pdfMode, setPdfMode] = useState<"vertical" | "horizontal">("vertical");
  const [dlBusy, setDlBusy] = useState(false);


  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrDraft, setOcrDraft] = useState(item.ocr_text || "");
  const [ocrStatusMsg, setOcrStatusMsg] = useState("");
  const [offlineSaved, setOfflineSaved] = useState(false);
  const [offlineSrc, setOfflineSrc] = useState<string | null>(null);
  const [imgScale, setImgScale] = useState(1);
  const [imgOffset, setImgOffset] = useState({ x: 0, y: 0 });
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);
  const lastTapRef = useRef(0);
  const suppressToggleRef = useRef(false);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.classList.add("d4-material-reader-open");
    document.documentElement.classList.add("d4-material-reader-open");

    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    const prevTheme = meta?.getAttribute("content") || null;
    if (meta) meta.setAttribute("content", "#000000");

    void (async () => {
      try {
        const { isNativeShell } = await import("@/native/platform");
        if (!isNativeShell()) return;
        const { StatusBar, Style } = await import("@capacitor/status-bar");
        try {
          await StatusBar.setOverlaysWebView({ overlay: true });
        } catch {
          /* older plugin */
        }
        await StatusBar.setBackgroundColor({ color: "#000000" });
        await StatusBar.setStyle({ style: Style.Dark });
      } catch {
        /* web / missing plugin */
      }
    })();

    return () => {
      document.body.style.overflow = prevOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.classList.remove("d4-material-reader-open");
      document.documentElement.classList.remove("d4-material-reader-open");
      if (meta && prevTheme) meta.setAttribute("content", prevTheme);
      void (async () => {
        try {
          const { isNativeShell } = await import("@/native/platform");
          if (!isNativeShell()) return;
          const { StatusBar, Style } = await import("@capacitor/status-bar");
          const { applyNativeStatusBar } = await import("@/native/statusBar");
          try {
            await StatusBar.setOverlaysWebView({ overlay: false });
          } catch {
            /* ignore */
          }
          await applyNativeStatusBar();
          await StatusBar.setStyle({ style: Style.Dark });
        } catch {
          /* ignore */
        }
      })();
    };
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setHintVisible(false), 2800);
    return () => window.clearTimeout(t);
  }, [item.id]);

  useEffect(() => {
    const s = loadMaterialAnn(item.id);
    setAnnState(s);
    setPage(s.lastPage || 1);
    setZoom(1);
    setImgScale(1);
    setImgOffset({ x: 0, y: 0 });
    setError(null);
    pdfDocRef.current = null;
    setOcrDraft(item.ocr_text || "");
    setChromeVisible(false);
    setMoreOpen(false);
    setHintVisible(true);
  }, [item.id, item.ocr_text]);

  useEffect(() => {
    saveMaterialAnn({ ...annState, materialId: item.id, lastPage: page });
  }, [annState, item.id, page]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!session?.userId) {
        setOfflineSrc(null);
        setOfflineSaved(false);
        return;
      }
      try {
        const blob = await getOfflineMaterial(session.userId, item.id);
        if (cancelled) return;
        if (blob?.dataUrl) {
          setOfflineSrc(blob.dataUrl);
          setOfflineSaved(true);
        } else {
          setOfflineSrc(null);
          setOfflineSaved(false);
        }
        // When online, quietly cache for next offline open (does not block UI)
        if (isOnlineNow() && item.file_url && !blob?.dataUrl) {
          try {
            await saveMaterialOffline(
              session.userId,
              {
                id: item.id,
                title: item.title,
                file_url: item.file_url,
                file_name: item.file_name,
                file_mime: item.file_mime,
              },
              session.schoolId,
            );
            if (!cancelled) {
              setOfflineSaved(true);
              const again = await getOfflineMaterial(session.userId, item.id);
              if (again?.dataUrl && !cancelled) setOfflineSrc(again.dataUrl);
            }
          } catch {
            /* quota / CORS — ignore */
          }
        }
      } catch {
        if (!cancelled) {
          setOfflineSrc(null);
          setOfflineSaved(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id, item.file_url, item.file_name, item.file_mime, item.title, session?.userId, session?.schoolId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (ocrOpen) {
          setOcrOpen(false);
          return;
        }
        if (moreOpen) {
          setMoreOpen(false);
          return;
        }
        if (chromeVisible) {
          setChromeVisible(false);
          return;
        }
        onClose();
      } else if (e.key === " " || e.key === "f" || e.key === "F") {
        if (ocrOpen || goPageOpen) return;
        e.preventDefault();
        setChromeVisible((v) => !v);
      } else if (e.key === "ArrowLeft" && pages > 0) {
        setPage((p) => Math.max(1, p - 1));
      } else if (e.key === "ArrowRight" && pages > 0) {
        setPage((p) => Math.min(pages, p + 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chromeVisible, moreOpen, ocrOpen, goPageOpen, onClose, pages]);

  // Prefer offline blob when network is down or remote URL unavailable
  const activeUrl = offlineSrc || item.file_url;
  useEffect(() => {
    let cancelled = false;
    setTextContent(null);
    if (!activeUrl || !isText(item)) return;
    void (async () => {
      try {
        const res = await fetch(activeUrl);
        const txt = await res.text();
        if (!cancelled) setTextContent(txt);
      } catch {
        if (!cancelled) setTextContent(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeUrl, item.id, item.file_mime, item.file_name]);


  useEffect(() => {
    if (!activeUrl || !isPdf(item)) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const pdfjs = await import("pdfjs-dist");
        const version = (pdfjs as { version?: string }).version ?? "5.1.91";
        if (pdfjs.GlobalWorkerOptions) {
          pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
        }
        const doc = await pdfjs.getDocument({ url: activeUrl!, withCredentials: false }).promise;
        if (cancelled) return;
        pdfDocRef.current = doc;
        setPages(doc.numPages);
        setPage((p) => Math.min(Math.max(1, p), doc.numPages));
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "Could not open PDF");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id, activeUrl, item.file_mime, item.file_name]);

  const renderPage = useCallback(async () => {
    if (!pdfDocRef.current || !canvasRef.current || !isPdf(item)) return;
    try {
      const doc = pdfDocRef.current;
      const pg = await doc.getPage(page);
      const base = pg.getViewport({ scale: 1 });
      const maxW = Math.max((wrapRef.current?.clientWidth || 900) - 8, 280);
      // Fit width so PDF fills the viewport edge-to-edge (not a small card in a void)
      const fit = maxW / base.width;
      const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2.5);
      const scale = fit * zoom * dpr;
      const viewport = pg.getViewport({ scale });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // CSS size keeps layout sharp on retina without huge layout box
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      await pg.render({ canvasContext: ctx, viewport, intent: "display" } as Parameters<typeof pg.render>[0]).promise;
    } catch (e) {
      setError((e as Error).message || "Render failed");
    }
  }, [page, zoom, item]);

  useEffect(() => {
    void renderPage();
  }, [renderPage]);

  function toggleBookmark() {
    setAnnState((prev) => {
      const has = prev.bookmarks.includes(page);
      return {
        ...prev,
        bookmarks: has ? prev.bookmarks.filter((p) => p !== page) : [...prev.bookmarks, page].sort((a, b) => a - b),
      };
    });
    toast.success(annState.bookmarks.includes(page) ? "Bookmark removed" : "Page bookmarked");
  }

  function materialDeepLink() {
    try {
      const origin = getAppOrigin();
      const path = role === "teacher" ? "/teacher/materials" : "/student/materials";
      return `${origin}${path}?m=${encodeURIComponent(item.id)}`;
    } catch {
      return item.file_url || "";
    }
  }

  async function download() {
    const href = offlineSrc || item.file_url;
    if (!href) {
      toast.error("No file available to download");
      return;
    }
    setDlBusy(true);
    try {
      const res = await fetch(href, { mode: "cors" });
      if (!res.ok) throw new Error("Fetch failed");
      const blob = await res.blob();
      const name = item.file_name || `${item.title || "material"}.bin`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast.success("Downloading to your device…");
    } catch {
      // fallback: open URL (works for public storage)
      try {
        const a = document.createElement("a");
        a.href = href;
        a.download = item.file_name || item.title || "material";
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast.success("Download started");
      } catch {
        toast.error("Could not download this file");
      }
    } finally {
      setDlBusy(false);
    }
  }

  async function shareFileOrLink() {
    const href = offlineSrc || item.file_url;
    if (!href) return;
    try {
      // Prefer native share sheet with actual file when possible
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        try {
          const res = await fetch(href);
          const blob = await res.blob();
          const name = item.file_name || `${item.title || "material"}.bin`;
          const file = new File([blob], name, { type: blob.type || item.file_mime || "application/octet-stream" });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ title: item.title, files: [file] });
            return;
          }
        } catch {
          /* fall through to link share */
        }
        await navigator.share({
          title: item.title,
          text: item.description || item.title,
          url: materialDeepLink() || href,
        });
        return;
      }
      await navigator.clipboard.writeText(materialDeepLink() || href);
      toast.success("Material link copied");
    } catch {
      /* cancelled */
    }
  }

  async function shareMaterialLink() {
    const link = materialDeepLink();
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({ title: item.title, text: "Open this material on D4EXAM", url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      toast.success("D4EXAM material link copied");
    } catch {
      /* cancelled */
    }
  }

  async function share() {
    await shareFileOrLink();
  }

  async function startOcr() {
    if (!item.file_url || !isImage(item)) {
      toast.error("OCR is available for image materials");
      return;
    }
    setOcrOpen(true);
    setOcrBusy(true);
    setOcrProgress(0);
    setChromeVisible(true);
    try {
      const text = await runImageOcr(item.file_url, (p) => {
        setOcrProgress(Math.round((p.progress || 0) * 100));
        setOcrStatusMsg(String(p.status || "").replace(/_/g, " "));
      });
      setOcrDraft(text || "");
      if (!text) toast.message("No text detected — try a clearer photo");
    } catch (e) {
      toast.error((e as Error).message || "OCR failed");
    } finally {
      setOcrBusy(false);
    }
  }

  async function saveOcr() {
    try {
      const { error: err } = await supabase
        .from("course_materials")
        .update({ ocr_text: ocrDraft, ocr_status: "done" } as never)
        .eq("id", item.id);
      if (err) throw err;
      onItemPatch?.(item.id, { ocr_text: ocrDraft, ocr_status: "done" });
      toast.success("Converted text saved");
      setOcrOpen(false);
    } catch {
      downloadTextFile(`${(item.title || "notes").replace(/[^\w\- ]+/g, "").trim() || "notes"}-ocr`, ocrDraft);
      toast.message("Downloaded as text (server save needs OCR migration)");
    }
  }

  async function handleSaveOffline() {
    if (!session?.userId || !item.file_url) {
      toast.error("Cannot save offline");
      return;
    }
    try {
      await saveMaterialOffline(
        session.userId,
        {
          id: item.id,
          title: item.title,
          file_url: item.file_url,
          file_name: item.file_name,
          file_mime: item.file_mime,
        },
        session.schoolId,
      );
      setOfflineSaved(true);
      toast.success("Saved for offline reading");
    } catch (e) {
      toast.error((e as Error).message || "Offline save failed");
    }
  }

  function resetZoom() {
    setZoom(1);
    setImgScale(1);
    setImgOffset({ x: 0, y: 0 });
  }

  function onImgPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    panRef.current = { x: e.clientX, y: e.clientY, ox: imgOffset.x, oy: imgOffset.y };
  }
  function onImgPointerMove(e: React.PointerEvent) {
    if (!panRef.current || imgScale <= 1) return;
    suppressToggleRef.current = true;
    setImgOffset({
      x: panRef.current.ox + (e.clientX - panRef.current.x),
      y: panRef.current.oy + (e.clientY - panRef.current.y),
    });
  }
  function onImgPointerUp() {
    panRef.current = null;
    window.setTimeout(() => {
      suppressToggleRef.current = false;
    }, 80);
  }
  function onImgTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      pinchRef.current = { dist: d, scale: imgScale };
      suppressToggleRef.current = true;
    }
  }
  function onImgTouchMove(e: React.TouchEvent) {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      setImgScale(Math.min(5, Math.max(0.5, pinchRef.current.scale * (d / pinchRef.current.dist))));
    }
  }
  function onImgDoubleClick() {
    if (imgScale > 1.1) {
      setImgScale(1);
      setImgOffset({ x: 0, y: 0 });
    } else setImgScale(2.2);
  }

  function onStagePointerUp(e: React.PointerEvent) {
    if (suppressToggleRef.current) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-reader-chrome]")) return;
    if (moreOpen) {
      setMoreOpen(false);
      return;
    }
    const now = Date.now();
    if (now - lastTapRef.current < 280) {
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;
    setChromeVisible((v) => !v);
    setHintVisible(false);
  }

  const bookmarked = annState.bookmarks.includes(page);
  const idx = siblings.findIndex((s) => s.id === item.id);
  const prevItem = idx > 0 ? siblings[idx - 1] : null;
  const nextItem = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;

  const reader = (
    <div
      className="fixed inset-0 z-[2147483000] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal
      aria-label="Material reader"
      style={{
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: "100%",
        height: "100%",
        minHeight: "100vh",
        minWidth: "100vw",
        width: "100vw",
        height: "100dvh",
        maxHeight: "100dvh",
        background: "#000000",
      }}
      onPointerUp={onStagePointerUp}
    >
      <header
        data-reader-chrome
        className={cn(
          "absolute left-0 right-0 top-0 z-20 flex items-center gap-2 border-b border-white/10 bg-[#000000]/95 px-2 py-2 backdrop-blur-md transition-all duration-200 sm:px-3",
          chromeVisible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-full opacity-0",
        )}
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top,0px))", background: "rgba(11,27,58,0.98)" }}
      >
        <Button type="button" size="icon" variant="ghost" className="h-10 w-10 shrink-0 text-white hover:bg-white/10" onClick={onClose} aria-label="Back">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold leading-tight">{item.title || item.file_name}</p>
          <p className="truncate text-[11px] text-white/55">
            {[
              courseLabel,
              (() => {
                const r = String(item.uploader_role || "").toLowerCase();
                if (r.includes("teacher")) return "Teacher";
                if (r.includes("student")) return "Student";
                return item.uploader_name || null;
              })(),
              isPdf(item) ? `PDF${pages ? ` · ${pages} pages` : ""}` : isImage(item) ? "IMAGE" : "FILE",
              offlineSaved ? "Offline" : null,
            ]
              .filter(Boolean)
              .join(" · ") || typeLabel(item.material_type)}
          </p>
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-10 w-10 shrink-0 text-white hover:bg-white/10" onClick={onClose} aria-label="Close">
          <X className="h-5 w-5" />
        </Button>
      </header>

      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
        {busy && (
          <p className="flex items-center gap-2 text-sm text-white/70">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading…
          </p>
        )}
        {error && <p className="px-6 text-center text-sm text-red-300">{error}</p>}

                {!activeUrl && !busy && !isOnlineNow() && (
          <div className="mx-auto max-w-lg rounded-xl bg-white p-6 text-center text-slate-800 shadow">
            <p className="text-sm font-semibold">Not available offline yet</p>
            <p className="mt-2 text-sm text-slate-500">
              Open this material once while online (or tap Save offline) so you can read it without internet.
            </p>
          </div>
        )}

{!activeUrl && !busy && isOnlineNow() && (
          <div className="mx-auto max-w-lg rounded-xl bg-white p-6 text-slate-800 shadow">
            <p className="whitespace-pre-wrap text-sm">{item.ocr_text || item.description || "No file attached."}</p>
          </div>
        )}

        {activeUrl && isImage(item) && (
          <div
            className="flex h-full w-full touch-none items-center justify-center"
            onPointerDown={onImgPointerDown}
            onPointerMove={onImgPointerMove}
            onPointerUp={onImgPointerUp}
            onPointerCancel={onImgPointerUp}
            onTouchStart={onImgTouchStart}
            onTouchMove={onImgTouchMove}
            onDoubleClick={onImgDoubleClick}
          >
            <img
              src={activeUrl || item.file_url || ""}
              alt={item.title}
              draggable={false}
              className="h-auto max-h-full w-auto max-w-full select-none object-contain"
              style={{
                transform: `translate(${imgOffset.x}px, ${imgOffset.y}px) scale(${imgScale * zoom})`,
                transformOrigin: "center center",
              }}
            />
          </div>
        )}

        {activeUrl && isPdf(item) && !error && (
          <div
            className={cn(
              "h-full w-full bg-slate-900",
              pdfMode === "vertical" ? "overflow-y-auto overscroll-contain" : "overflow-x-auto overflow-y-hidden",
            )}
            onScroll={(e) => {
              if (pdfMode !== "vertical" || pages <= 1) return;
              const el = e.currentTarget;
              const ratio = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight);
              const next = Math.min(pages, Math.max(1, Math.round(ratio * pages) + 1));
              if (next !== page) setPage(next);
            }}
          >
            <div className={cn("flex min-h-full w-full", pdfMode === "vertical" ? "flex-col items-stretch" : "flex-row items-center")}>
              <div className="mx-auto w-full max-w-4xl bg-white shadow-none sm:shadow-2xl">
                <canvas ref={canvasRef} className="block w-full bg-white" />
              </div>
            </div>
          </div>
        )}

        {activeUrl && isText(item) && (
          <div className="h-full w-full overflow-y-auto bg-[#0f172a] px-3 py-4 sm:px-6">
            <div className="mx-auto max-w-3xl rounded-xl bg-white p-4 text-left shadow-lg sm:p-6">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-400">
                {item.file_name || "Text file"}
              </p>
              {textContent == null ? (
                <p className="text-sm text-slate-500">Loading text…</p>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-slate-800">
                  {textContent}
                </pre>
              )}
            </div>
          </div>
        )}

        {activeUrl && isOffice(item) && (
          <div className="mx-auto max-w-md rounded-xl bg-white p-8 text-center text-slate-800 shadow">
            <File className="mx-auto h-12 w-12 text-slate-400" />
            <p className="mt-3 font-semibold">Office document</p>
            <p className="mt-1 text-sm text-slate-500">
              Preview this file type on your device, or open with an online viewer.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button data-reader-chrome onClick={() => void download()} disabled={dlBusy}>
                <Download className="mr-1 h-4 w-4" /> {dlBusy ? "Downloading…" : "Download"}
              </Button>
              {item.file_url && (
                <Button
                  variant="outline"
                  data-reader-chrome
                  onClick={() =>
                    window.open(
                      `https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(item.file_url!)}`,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  Open preview
                </Button>
              )}
            </div>
          </div>
        )}

        {activeUrl && !isPdf(item) && !isImage(item) && !isText(item) && !isOffice(item) && (
          <div className="mx-auto max-w-md rounded-xl bg-white p-8 text-center text-slate-800 shadow">
            <File className="mx-auto h-12 w-12 text-slate-400" />
            <p className="mt-3 font-semibold">Preview not available for this file type</p>
            <p className="mt-1 text-sm text-slate-500">Download to open on your device.</p>
            <Button className="mt-4" data-reader-chrome onClick={() => void download()} disabled={dlBusy}>
              <Download className="mr-1 h-4 w-4" /> {dlBusy ? "Downloading…" : "Download"}
            </Button>
          </div>
        )}

        {pages > 0 && !chromeVisible && (
          <div className="pointer-events-none absolute bottom-6 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-xs font-semibold text-white/90 backdrop-blur-sm">
            {page} / {pages}
          </div>
        )}

        {hintVisible && !chromeVisible && (
          <div className="pointer-events-none absolute bottom-10 left-1/2 z-10 -translate-x-1/2 text-xs font-medium tracking-wide text-white/40">
            Tap for options
          </div>
        )}

        {role === "student" && !studyHelpOpen && (
          <button
            type="button"
            data-reader-chrome
            className="absolute bottom-20 right-3 z-30 inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-2.5 text-xs font-bold text-white shadow-lg shadow-red-900/40 ring-2 ring-white/20 sm:bottom-24 sm:right-4"
            onClick={(e) => {
              e.stopPropagation();
              setStudyHelpOpen(true);
              setChromeVisible(true);
            }}
            aria-label="Open Study Help"
          >
            <Youtube className="h-4 w-4" />
            Study Help
          </button>
        )}
      </div>

      <footer
        data-reader-chrome
        className={cn(
          "absolute bottom-0 left-0 right-0 z-20 border-t border-white/10 bg-[#000000]/95 backdrop-blur-md transition-all duration-200",
          chromeVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0",
        )}
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom,0px))" }}
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-1 px-2 py-2 sm:px-4">
          {pages > 0 ? (
            <div className="flex items-center gap-0.5">
              <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <span className="min-w-[3.5rem] text-center text-xs font-semibold tabular-nums">{page}/{pages}</span>
              <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-0.5">
              <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" disabled={!prevItem} onClick={() => prevItem && onNavigate(prevItem)} aria-label="Previous material">
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" disabled={!nextItem} onClick={() => nextItem && onNavigate(nextItem)} aria-label="Next material">
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          )}

          <div className="flex items-center gap-0.5 sm:gap-1">
            <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" onClick={() => { if (isImage(item)) setImgScale((s) => Math.max(0.5, +(s - 0.25).toFixed(2))); else setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2))); }} aria-label="Zoom out">
              <Minus className="h-4 w-4" />
            </Button>
            <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" onClick={resetZoom} aria-label="Fit">
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" onClick={() => { if (isImage(item)) setImgScale((s) => Math.min(5, +(s + 0.25).toFixed(2))); else setZoom((z) => Math.min(2.5, +(z + 0.15).toFixed(2))); }} aria-label="Zoom in">
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex items-center gap-0.5 sm:gap-1">
            {isImage(item) && (
              <Button type="button" size="sm" className="h-9 rounded-full bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-500" onClick={() => void startOcr()}>
                <Type className="mr-1 h-3.5 w-3.5" /> OCR
              </Button>
            )}
            {role === "student" ? (
              <Button
                type="button"
                size="sm"
                className="h-9 gap-1 rounded-full bg-red-600 px-2.5 text-[11px] font-bold text-white hover:bg-red-500 sm:px-3"
                onClick={() => { setStudyHelpOpen(true); setChromeVisible(true); }}
                aria-label="Study Help"
              >
                <Youtube className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Study Help</span>
              </Button>
            ) : null}
            <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" onClick={() => void share()} aria-label="Share">
              <Share2 className="h-4 w-4" />
            </Button>
            <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" onClick={() => void download()} aria-label="Download">
              <Download className="h-4 w-4" />
            </Button>
            <div className="relative">
              <Button type="button" size="icon" variant="ghost" className="h-10 w-10 text-white hover:bg-white/10" onClick={() => setMoreOpen((v) => !v)} aria-label="More options">
                <MoreVertical className="h-4 w-4" />
              </Button>
              {moreOpen && (
                <div className="absolute bottom-12 right-0 z-30 w-56 overflow-hidden rounded-xl border border-white/10 bg-[#000000] py-1 text-sm shadow-2xl">
                  {isImage(item) && (
                    <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { setMoreOpen(false); void startOcr(); }}>
                      <Type className="h-4 w-4 opacity-70" /> Convert handwriting (OCR)
                    </button>
                  )}
                  {isPdf(item) ? (
                    <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { setPdfMode((m) => (m === "vertical" ? "horizontal" : "vertical")); setMoreOpen(false); }}>
                      <Type className="h-4 w-4" /> {pdfMode === "vertical" ? "Page mode: Horizontal" : "Page mode: Vertical"}
                    </button>
                  ) : null}
                  {role === "student" ? (
                    <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { setMoreOpen(false); setStudyHelpOpen(true); setChromeVisible(true); }}>
                      <Bookmark className="h-4 w-4 opacity-70" /> Study Help
                    </button>
                  ) : null}
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { setMoreOpen(false); void shareMaterialLink(); }}>
                    <Share2 className="h-4 w-4 opacity-70" /> Share material link
                  </button>
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { setMoreOpen(false); void handleSaveOffline(); }}>
                    <Save className="h-4 w-4 opacity-70" /> {offlineSaved ? "Re-save offline" : "Save offline"}
                  </button>
                  {pages > 0 && (
                    <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { setGoPage(String(page)); setGoPageOpen(true); setMoreOpen(false); }}>
                      Go to page…
                    </button>
                  )}
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { resetZoom(); setMoreOpen(false); }}>
                    Fit / reset zoom
                  </button>
                  {pages > 0 && (
                    <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { toggleBookmark(); setMoreOpen(false); }}>
                      <Bookmark className={cn("h-4 w-4 opacity-70", bookmarked && "fill-amber-400 text-amber-400")} />
                      {bookmarked ? "Remove bookmark" : "Bookmark page"}
                    </button>
                  )}
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { setMoreOpen(false); void share(); }}>
                    <Share2 className="h-4 w-4 opacity-70" /> Share
                  </button>
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/10" onClick={() => { setMoreOpen(false); download(); }}>
                    <Download className="h-4 w-4 opacity-70" /> Download
                  </button>
                  {item.description && (
                    <div className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-white/50">{item.description}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </footer>

      {goPageOpen && (
        <div data-reader-chrome className="absolute inset-0 z-40 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setGoPageOpen(false)}>
          <div className="w-full max-w-sm rounded-t-2xl bg-[#000000] p-4 shadow-2xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="mb-2 text-sm font-semibold">Go to page</p>
            <div className="flex gap-2">
              <input className="flex-1 rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-sm" value={goPage} inputMode="numeric" onChange={(e) => setGoPage(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { const n = parseInt(goPage, 10); if (n >= 1 && n <= pages) setPage(n); setGoPageOpen(false); } }} autoFocus />
              <Button type="button" onClick={() => { const n = parseInt(goPage, 10); if (n >= 1 && n <= pages) setPage(n); setGoPageOpen(false); }}>Go</Button>
            </div>
            <p className="mt-2 text-[11px] text-white/45">1 – {pages}</p>
          </div>
        </div>
      )}

      {ocrOpen && (
        <div data-reader-chrome className="absolute inset-0 z-50 flex flex-col bg-[#0b1220]">
          <header className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#000000] px-2 py-2">
            <Button type="button" size="icon" variant="ghost" className="text-white" onClick={() => setOcrOpen(false)}>
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">Handwriting → Text</p>
              <p className="text-[11px] text-white/55">{ocrBusy ? `${ocrStatusMsg} ${ocrProgress}%` : "Review and edit before saving"}</p>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {ocrBusy ? (
              <div className="flex flex-col items-center justify-center gap-3 py-20 text-white/80">
                <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
                <p className="text-sm">{ocrStatusMsg}</p>
                <div className="h-1.5 w-48 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full bg-blue-500 transition-all" style={{ width: `${ocrProgress}%` }} />
                </div>
              </div>
            ) : (
              <div className="mx-auto grid max-w-4xl gap-3 lg:grid-cols-2">
                {activeUrl && isImage(item) && (
                  <div className="overflow-hidden rounded-xl bg-slate-900">
                    <img src={activeUrl || item.file_url || ""} alt="Original" className="max-h-[40vh] w-full object-contain lg:max-h-[70vh]" />
                    <p className="px-3 py-2 text-center text-[11px] text-white/50">Original image (kept intact)</p>
                  </div>
                )}
                <div className="flex flex-col rounded-xl bg-white p-3 text-slate-900">
                  <p className="mb-2 text-xs font-semibold text-slate-500">Converted text (editable)</p>
                  <textarea className="min-h-[40vh] flex-1 resize-y rounded-lg border border-slate-200 p-3 text-sm leading-relaxed lg:min-h-[60vh]" value={ocrDraft} onChange={(e) => setOcrDraft(e.target.value)} placeholder="Recognized text appears here…" />
                </div>
              </div>
            )}
          </div>
          {!ocrBusy && (
            <div className="flex shrink-0 flex-wrap gap-2 border-t border-white/10 bg-[#000000] p-3">
              <Button type="button" variant="outline" className="border-white/20 bg-transparent text-white" onClick={() => setOcrOpen(false)}>Discard</Button>
              <Button type="button" variant="secondary" onClick={() => downloadTextFile(`${(item.title || "notes").replace(/[^\w\- ]+/g, "").trim() || "notes"}-ocr`, ocrDraft)}>Download .txt</Button>
              <Button type="button" variant="secondary" onClick={() => openPrintableOcr(item.title, ocrDraft)}>Print / PDF</Button>
              <Button type="button" className="ml-auto" onClick={() => void saveOcr()} disabled={!ocrDraft.trim()}>Save conversion</Button>
            </div>
          )}
        </div>
      )}

      {role === "student" && studyHelpOpen && !studySplit && (
        <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 max-h-[48vh] overflow-y-auto border-t border-white/10 bg-[#0b1220]/97 p-3 backdrop-blur-md sm:left-auto sm:right-3 sm:bottom-16 sm:max-h-[70vh] sm:w-[min(100%,24rem)] sm:rounded-2xl sm:border sm:border-white/15">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-white/90">Study Help</p>
            <button type="button" className="rounded-lg px-2 py-1 text-xs font-semibold text-white/80 hover:bg-white/10" onClick={() => { setStudyHelpOpen(false); setStudySplit(false); }}>
              Close
            </button>
          </div>
          <StudyHelpPanel
            materialId={item.id}
            title={item.title}
            courseLabel={courseLabel || undefined}
            topic={topic}
            description={item.description}
            ocrText={item.ocr_text}
            compact
            className="border-0 shadow-none"
            onActiveChange={(v) => {
              if (v) setStudySplit(true);
            }}
          />
        </div>
      )}

      {role === "student" && studySplit && (
        <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex h-[42vh] flex-col border-t border-white/10 bg-[#0b1220] sm:inset-y-16 sm:left-auto sm:right-0 sm:h-auto sm:w-[min(100%,28rem)] sm:border-l sm:border-t-0">
          <StudyHelpPanel
            materialId={item.id}
            title={item.title}
            courseLabel={courseLabel || undefined}
            topic={topic}
            description={item.description}
            ocrText={item.ocr_text}
            embedMode
            onCloseEmbed={() => setStudySplit(false)}
            onActiveChange={(v) => {
              if (!v) setStudySplit(false);
            }}
          />
        </div>
      )}

    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(reader, document.body);
}
