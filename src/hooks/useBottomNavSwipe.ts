/**
 * Horizontal swipe between bottom-nav tabs with a continuous Grok-style slide.
 * The page tracks the finger, then completes a full slide into the next tab.
 */
import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { NavItem } from "@/components/navigation/navConfig";

const MIN_DX = 48;
const MAX_DY = 60;
const MAX_MS = 700;
const SLIDE_MS = 320;

function getMainEl(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    (document.querySelector(".d4-shell-main-offset main") as HTMLElement | null) ||
    (document.querySelector("main") as HTMLElement | null)
  );
}

function clearInline(el: HTMLElement | null) {
  if (!el) return;
  el.style.transition = "";
  el.style.transform = "";
  el.style.opacity = "";
  el.style.willChange = "";
}

export function useBottomNavSwipe(
  bottomNav: NavItem[] | undefined,
  home: string,
  enabled = true,
) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const startRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const trackingRef = useRef(false);
  const animatingRef = useRef(false);
  const lastDxRef = useRef(0);

  useEffect(() => {
    if (!enabled || !bottomNav?.length) return;
    if (typeof window === "undefined") return;

    const mq = window.matchMedia("(max-width: 1023px)");
    if (!mq.matches) return;

    // Route changed: clear any leftover inline transform/opacity a swipe
    // left on <main> — otherwise the page stays shifted/invisible and the
    // app looks frozen.
    if (!animatingRef.current) {
      clearInline(getMainEl());
    }

    const indexOfPath = () => {
      for (let i = 0; i < bottomNav.length; i++) {
        const item = bottomNav[i];
        if (item.to === home) {
          if (pathname === item.to || pathname === `${item.to}/`) return i;
        } else if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
          return i;
        }
      }
      return -1;
    };

    const onStart = (e: TouchEvent) => {
      if (animatingRef.current) return;
      if (e.touches.length !== 1) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        if (target.closest("input, textarea, select, [data-no-swipe], [role='slider']")) return;
        if (target.closest("[data-swipe-ignore]")) return;
      }
      const t = e.touches[0];
      startRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
      trackingRef.current = false;
      lastDxRef.current = 0;
    };

    const onMove = (e: TouchEvent) => {
      const start = startRef.current;
      if (!start || animatingRef.current) return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (!trackingRef.current) {
        if (Math.abs(dx) < 12) return;
        if (Math.abs(dy) > Math.abs(dx) * 0.85) {
          startRef.current = null;
          return;
        }
        trackingRef.current = true;
        const main = getMainEl();
        if (main) {
          main.style.willChange = "transform";
          main.style.transition = "none";
        }
      }
      lastDxRef.current = dx;
      const main = getMainEl();
      if (main) {
        const idx = indexOfPath();
        let clamped = dx;
        if (idx <= 0 && dx > 0) clamped = dx * 0.35;
        if (idx >= bottomNav.length - 1 && dx < 0) clamped = dx * 0.35;
        const progress = Math.min(1, Math.abs(clamped) / (window.innerWidth * 0.55));
        main.style.transform = `translate3d(${clamped}px,0,0)`;
        main.style.opacity = String(1 - progress * 0.25);
      }
    };

    const finishSlide = (direction: "left" | "right", nextTo: string) => {
      const main = getMainEl();
      animatingRef.current = true;
      if (main) {
        const outX = direction === "left" ? "-100%" : "100%";
        main.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${SLIDE_MS}ms ease`;
        main.style.transform = `translate3d(${outX},0,0)`;
        main.style.opacity = "0.4";
      }
      window.setTimeout(() => {
        void navigate({ to: nextTo as never }).finally(() => {
          requestAnimationFrame(() => {
            const nextMain = getMainEl();
            if (nextMain) {
              const enterFrom = direction === "left" ? "28%" : "-28%";
              nextMain.style.transition = "none";
              nextMain.style.transform = `translate3d(${enterFrom},0,0)`;
              nextMain.style.opacity = "0.75";
              void nextMain.offsetWidth;
              nextMain.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${SLIDE_MS}ms ease`;
              nextMain.style.transform = "translate3d(0,0,0)";
              nextMain.style.opacity = "1";
              window.setTimeout(() => {
                clearInline(nextMain);
                animatingRef.current = false;
              }, SLIDE_MS + 30);
            } else {
              animatingRef.current = false;
            }
          });
        });
      }, Math.min(SLIDE_MS, 180));
    };

    const snapBack = () => {
      const main = getMainEl();
      if (!main) return;
      main.style.transition = `transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease`;
      main.style.transform = "translate3d(0,0,0)";
      main.style.opacity = "1";
      window.setTimeout(() => clearInline(main), 240);
    };

    const onEnd = (e: TouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (animatingRef.current) return;
      if (!start || e.changedTouches.length !== 1) {
        if (trackingRef.current) snapBack();
        trackingRef.current = false;
        return;
      }

      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const dt = Date.now() - start.t;
      const wasTracking = trackingRef.current;
      trackingRef.current = false;

      if (!wasTracking) return;

      if (dt > MAX_MS || Math.abs(dx) < MIN_DX || Math.abs(dy) > MAX_DY) {
        snapBack();
        return;
      }
      if (Math.abs(dx) < Math.abs(dy) * 1.05) {
        snapBack();
        return;
      }

      const idx = indexOfPath();
      if (idx < 0) {
        snapBack();
        return;
      }

      if (dx < 0 && idx < bottomNav.length - 1) {
        finishSlide("left", bottomNav[idx + 1].to);
      } else if (dx > 0 && idx > 0) {
        finishSlide("right", bottomNav[idx - 1].to);
      } else {
        snapBack();
      }
    };

    const onCancel = () => {
      startRef.current = null;
      if (trackingRef.current) snapBack();
      trackingRef.current = false;
    };

    const opts: AddEventListenerOptions = { passive: true };
    document.addEventListener("touchstart", onStart, opts);
    document.addEventListener("touchmove", onMove, opts);
    document.addEventListener("touchend", onEnd, opts);
    document.addEventListener("touchcancel", onCancel, opts);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, [bottomNav, enabled, home, navigate, pathname]);
}
