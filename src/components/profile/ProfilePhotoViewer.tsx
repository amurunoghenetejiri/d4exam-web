import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Share2, X } from "lucide-react";

/**
 * Full-screen edge-to-edge profile photo viewer (portal to body).
 * Covers the entire device viewport — not a cutout card.
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
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  if (!src && !fallbackInitials) return null;
  if (typeof document === "undefined") return null;

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

  return createPortal(
    <div
      className="fixed overflow-hidden bg-black text-white"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: "100vw",
        height: "100dvh",
        maxWidth: "100vw",
        maxHeight: "100dvh",
        zIndex: 2147483000,
        margin: 0,
        padding: 0,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Profile photo"
    >
      {/* Edge-to-edge image */}
      <div
        className="absolute inset-0 z-0 flex items-center justify-center bg-black"
        onTouchStart={(e) => {
          startY.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchEnd={(e) => {
          if (startY.current == null) return;
          const dy = (e.changedTouches[0]?.clientY ?? 0) - startY.current;
          if (dy > 100 && scale <= 1) onClose();
          startY.current = null;
        }}
      >
        {src ? (
          <img
            src={src}
            alt={name || "Profile"}
            className="h-full w-full select-none object-contain"
            style={{
              transform: `scale(${scale})`,
              transition: "transform 0.15s ease",
              touchAction: "none",
            }}
            onClick={(e) => {
              e.stopPropagation();
              setScale((s) => (s > 1 ? 1 : 2.4));
            }}
            draggable={false}
          />
        ) : (
          <div className="grid h-48 w-48 place-items-center rounded-full bg-[#1e3a5f] text-5xl font-extrabold text-[#93c5fd]">
            {fallbackInitials}
          </div>
        )}
      </div>

      {/* Top bar: close */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-3 pb-8 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          className="pointer-events-auto grid h-11 w-11 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        <p className="pointer-events-none text-sm font-semibold text-white/90">Close</p>
        <span className="w-11" />
      </div>

      {/* Bottom meta + actions */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-16 text-center">
        {name ? <p className="text-lg font-bold tracking-tight text-white drop-shadow">{name}</p> : null}
        {subtitle ? <p className="mt-1 text-sm text-white/70">{subtitle}</p> : null}
        <p className="mt-1 text-[11px] text-white/45">Tap photo to zoom</p>
        <div className="pointer-events-auto mt-4 flex items-center justify-center gap-10">
          <button
            type="button"
            onClick={() => void share()}
            className="flex flex-col items-center gap-1 text-white/90 active:opacity-70"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-white/15 backdrop-blur-sm">
              <Share2 className="h-5 w-5" />
            </span>
            <span className="text-[11px] font-medium">Share</span>
          </button>
          <button
            type="button"
            onClick={download}
            className="flex flex-col items-center gap-1 text-white/90 active:opacity-70"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-white/15 backdrop-blur-sm">
              <Download className="h-5 w-5" />
            </span>
            <span className="text-[11px] font-medium">Download</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
