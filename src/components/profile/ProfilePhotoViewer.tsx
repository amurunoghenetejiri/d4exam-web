import { useEffect, useRef, useState } from "react";
import { Download, Share2, X } from "lucide-react";

/**
 * Full-screen edge-to-edge profile photo viewer.
 * Share + Download only. Tap image to zoom.
 */
export function ProfilePhotoViewer({
  open,
  src,
  name,
  subtitle,
  fallbackInitials,
  onClose,
}: {
  open: boolean;
  src: string | null | undefined;
  name?: string;
  subtitle?: string;
  fallbackInitials?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) setScale(1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (!src && !fallbackInitials) return null;

  const share = async () => {
    try {
      if (navigator.share && src) {
        await navigator.share({ title: name || "Profile photo", url: src });
      }
    } catch {
      /* cancelled */
    }
  };

  const download = () => {
    if (!src) return;
    try {
      const a = document.createElement("a");
      a.href = src;
      a.download = `${(name || "profile").replace(/\s+/g, "_")}.jpg`;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      window.open(src, "_blank");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Profile photo"
    >
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          className="grid h-10 w-10 place-items-center rounded-full bg-black/50 text-white"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        <p className="text-sm font-semibold text-white/90">Close</p>
        <span className="w-10" />
      </div>

      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onTouchStart={(e) => {
          startY.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchEnd={(e) => {
          if (startY.current == null) return;
          const dy = (e.changedTouches[0]?.clientY ?? 0) - startY.current;
          if (dy > 80) onClose();
          startY.current = null;
        }}
      >
        {src ? (
          <img
            src={src}
            alt={name || "Profile"}
            className="h-full w-full object-contain"
            style={{ transform: `scale(${scale})`, transition: "transform 0.15s ease" }}
            onClick={(e) => {
              e.stopPropagation();
              setScale((s) => (s > 1 ? 1 : 2.2));
            }}
            draggable={false}
          />
        ) : (
          <div className="grid h-40 w-40 place-items-center rounded-full bg-[#1e3a5f] text-4xl font-extrabold text-[#93c5fd]">
            {fallbackInitials}
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 text-center">
        {name ? <p className="text-base font-bold text-white">{name}</p> : null}
        {subtitle ? <p className="mt-0.5 text-xs text-white/55">{subtitle}</p> : null}
        <div className="mt-4 flex items-center justify-center gap-8">
          <button
            type="button"
            onClick={() => void share()}
            className="flex flex-col items-center gap-1 text-white/90 active:opacity-70"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-white/10">
              <Share2 className="h-5 w-5" />
            </span>
            <span className="text-[11px] font-medium">Share</span>
          </button>
          <button
            type="button"
            onClick={download}
            className="flex flex-col items-center gap-1 text-white/90 active:opacity-70"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-white/10">
              <Download className="h-5 w-5" />
            </span>
            <span className="text-[11px] font-medium">Download</span>
          </button>
        </div>
      </div>
    </div>
  );
}
