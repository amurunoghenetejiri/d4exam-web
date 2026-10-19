import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Share2, X } from "lucide-react";

/**
 * True full-device-width profile photo viewer.
 * Portal to document.body — edge-to-edge black overlay, no floating card.
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
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) setScale(1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevBody = document.body.style.cssText;
    const prevHtml = document.documentElement.style.cssText;
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.documentElement.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.cssText = prevBody;
      document.documentElement.style.cssText = prevHtml;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;
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
      role="dialog"
      aria-modal="true"
      aria-label="Profile photo"
      onClick={onClose}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        height: "100dvh",
        minHeight: "-webkit-fill-available",
        zIndex: 2147483646,
        margin: 0,
        padding: 0,
        border: "none",
        background: "#000",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        overscrollBehavior: "none",
      }}
    >
      {/* Image area — full remaining space */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
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
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              setScale((s) => (s > 1 ? 1 : 2.4));
            }}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              transform: `scale(${scale})`,
              transition: "transform 0.15s ease",
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
          />
        ) : (
          <div
            style={{
              width: 160,
              height: 160,
              borderRadius: "9999px",
              background: "#1e3a5f",
              display: "grid",
              placeItems: "center",
              fontSize: 48,
              fontWeight: 800,
              color: "#93c5fd",
            }}
          >
            {fallbackInitials}
          </div>
        )}
      </div>

      {/* Top close — overlay */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "max(12px, env(safe-area-inset-top)) 12px 12px",
          background: "linear-gradient(to bottom, rgba(0,0,0,0.75), transparent)",
          pointerEvents: "none",
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close"
          style={{
            pointerEvents: "auto",
            width: 44,
            height: 44,
            borderRadius: 9999,
            background: "rgba(0,0,0,0.5)",
            border: "none",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
          }}
        >
          <X style={{ width: 20, height: 20 }} />
        </button>
        <span style={{ color: "rgba(255,255,255,0.9)", fontSize: 14, fontWeight: 600 }}>
          Close
        </span>
        <span style={{ width: 44 }} />
      </div>

      {/* Bottom meta */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "48px 16px max(20px, env(safe-area-inset-bottom))",
          background: "linear-gradient(to top, rgba(0,0,0,0.9), transparent)",
          textAlign: "center",
          pointerEvents: "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {name ? (
          <p style={{ margin: 0, color: "#fff", fontSize: 18, fontWeight: 700 }}>{name}</p>
        ) : null}
        {subtitle ? (
          <p style={{ margin: "4px 0 0", color: "rgba(255,255,255,0.7)", fontSize: 13 }}>{subtitle}</p>
        ) : null}
        <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.4)", fontSize: 11 }}>
          Tap photo to zoom
        </p>
        <div
          style={{
            marginTop: 16,
            display: "flex",
            justifyContent: "center",
            gap: 40,
            pointerEvents: "auto",
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void share();
            }}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.9)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 48,
                height: 48,
                borderRadius: 9999,
                background: "rgba(255,255,255,0.15)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Share2 style={{ width: 20, height: 20 }} />
            </span>
            <span style={{ fontSize: 11, fontWeight: 500 }}>Share</span>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              download();
            }}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.9)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: 48,
                height: 48,
                borderRadius: 9999,
                background: "rgba(255,255,255,0.15)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Download style={{ width: 20, height: 20 }} />
            </span>
            <span style={{ fontSize: 11, fontWeight: 500 }}>Download</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
