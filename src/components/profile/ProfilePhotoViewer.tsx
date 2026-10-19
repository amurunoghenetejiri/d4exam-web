import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";

/**
 * Full-screen edge-to-edge profile photo viewer.
 * Black background only — no floating card, no share/download, pinch-to-zoom.
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
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [mounted, setMounted] = useState(false);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStart = useRef<{ dist: number; scale: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) {
      setScale(1);
      setTx(0);
      setTy(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStart.current = { dist: dist || 1, scale };
      panStart.current = null;
    } else if (pointers.current.size === 1) {
      panStart.current = { x: e.clientX, y: e.clientY, tx, ty };
      pinchStart.current = null;
    }
  }, [scale, tx, ty]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinchStart.current) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const next = Math.min(4, Math.max(1, pinchStart.current.scale * (dist / pinchStart.current.dist)));
      setScale(next);
    } else if (pointers.current.size === 1 && panStart.current && scale > 1) {
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setTx(panStart.current.tx + dx);
      setTy(panStart.current.ty + dy);
    }
  }, [scale]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 0) {
      panStart.current = null;
      if (scale <= 1.05) {
        setScale(1);
        setTx(0);
        setTy(0);
      }
    }
  }, [scale]);

  if (!open || !mounted) return null;
  if (!src && !fallbackInitials) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Profile photo"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        width: "100vw",
        height: "100dvh",
        background: "#000",
        display: "flex",
        flexDirection: "column",
        touchAction: "none",
        overscrollBehavior: "none",
      }}
    >
      {/* Top bar — Back only */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "max(10px, env(safe-area-inset-top)) 12px 10px",
          background: "rgba(0,0,0,0.85)",
          zIndex: 2,
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          style={{
            width: 40,
            height: 40,
            borderRadius: 9999,
            border: "none",
            background: "rgba(255,255,255,0.12)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
          }}
        >
          <ArrowLeft style={{ width: 20, height: 20 }} />
        </button>
      </div>

      {/* Image area — full remaining space */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          background: "#000",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {src ? (
          <img
            src={src}
            alt={name || "Profile"}
            draggable={false}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              width: "auto",
              height: "auto",
              objectFit: "contain",
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              transition: pointers.current.size ? "none" : "transform 0.12s ease",
              userSelect: "none",
              WebkitUserSelect: "none",
              pointerEvents: "none",
            }}
          />
        ) : (
          <div
            style={{
              width: 140,
              height: 140,
              borderRadius: "9999px",
              background: "#1e293b",
              display: "grid",
              placeItems: "center",
              fontSize: 42,
              fontWeight: 800,
              color: "#93c5fd",
            }}
          >
            {fallbackInitials}
          </div>
        )}
      </div>

      {/* Bottom caption — small & stylish */}
      {(name || subtitle) ? (
        <div
          style={{
            flexShrink: 0,
            padding: "12px 16px max(16px, env(safe-area-inset-bottom))",
            background: "linear-gradient(to top, rgba(0,0,0,0.92), rgba(0,0,0,0.55))",
            textAlign: "center",
            zIndex: 2,
          }}
        >
          {name ? (
            <p
              style={{
                margin: 0,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "0.02em",
                lineHeight: 1.3,
              }}
            >
              {name}
            </p>
          ) : null}
          {subtitle ? (
            <p
              style={{
                margin: "4px 0 0",
                color: "rgba(255,255,255,0.55)",
                fontSize: 11,
                fontWeight: 500,
                lineHeight: 1.35,
              }}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
