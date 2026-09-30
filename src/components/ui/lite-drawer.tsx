import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Lightweight slide-over drawer for mobile menus.
 * Unlike Radix Sheet it never touches <body> (no scroll-lock, no pointer-events,
 * no inert, no focus trap) — those locks were freezing the Android WebView.
 */
export function LiteDrawer({
  open,
  onClose,
  side = "left",
  className,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(open);

  useEffect(() => setMounted(true), []);

  // Keep content in the DOM during the close animation, then hide it fully.
  useEffect(() => {
    if (open) {
      setVisible(true);
      return;
    }
    const t = window.setTimeout(() => setVisible(false), 260);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70]"
      style={{
        pointerEvents: open ? "auto" : "none",
        visibility: visible || open ? "visible" : "hidden",
      }}
      aria-hidden={!open}
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-label={label}
        aria-modal={false}
        className={cn(
          "absolute inset-y-0 flex h-[100dvh] flex-col shadow-2xl transition-transform duration-200 ease-out will-change-transform",
          side === "left" ? "left-0" : "right-0",
          open ? "translate-x-0" : side === "left" ? "-translate-x-full" : "translate-x-full",
          className,
        )}
      >
        {children}
      </aside>
    </div>,
    document.body,
  );
}

/** Ignore repeat taps within `ms` (Android double-tap burst guard). */
export function useTapThrottle(ms = 350) {
  const last = useRef(0);
  return (fn: () => void) => {
    const now = Date.now();
    if (now - last.current < ms) return;
    last.current = now;
    fn();
  };
}
