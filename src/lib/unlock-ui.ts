/**
 * Release stuck UI locks (Radix scroll-lock, pointer-events:none, stray inert)
 * that can freeze the Android WebView after overlays close mid-navigation.
 * Skips while a Radix dialog/sheet is genuinely open or the lock gate is active.
 */
function hasOpenModal(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-d4-lock-gate]',
    ),
  );
}

export function forceUnlockBody(): void {
  if (typeof document === "undefined") return;
  try {
    const lockGate = document.querySelector("[data-d4-lock-gate]");
    const root = document.getElementById("root");
    root?.removeAttribute("inert");
    if (root) root.style.pointerEvents = "";
    if (!lockGate) {
      document.querySelectorAll("[inert]").forEach((el) => el.removeAttribute("inert"));
    }
    // Closed Radix overlays left in the DOM must never capture taps.
    document
      .querySelectorAll('[data-state="closed"][data-radix-dialog-overlay], [data-state="closed"].fixed.inset-0')
      .forEach((el) => {
        (el as HTMLElement).style.pointerEvents = "none";
      });
    if (hasOpenModal()) return;
    for (const el of [document.body, document.documentElement]) {
      el.removeAttribute("data-scroll-locked");
      el.style.overflow = "";
      el.style.pointerEvents = "";
      if (el.style.paddingRight && el === document.body) el.style.paddingRight = "";
    }
    document.body.classList.remove("d4-fp-lock-active", "d4-setup-lock-active");
  } catch {
    /* ignore */
  }
}

/**
 * Tap-only self-heal. No MutationObserver (it fought Radix dialog lifecycles
 * in a loop and froze the WebView). Only acts on a real tap when the body is
 * locked and no modal is genuinely open.
 */
export function installUnlockWatchdog(): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window as Window & { __d4UnlockWatchdog?: () => void };
  if (w.__d4UnlockWatchdog) return w.__d4UnlockWatchdog;

  const isLocked = () =>
    document.body.style.pointerEvents === "none" ||
    document.body.hasAttribute("data-scroll-locked") ||
    document.documentElement.style.pointerEvents === "none" ||
    Boolean(document.getElementById("root")?.hasAttribute("inert"));

  const onTouch = () => {
    if (isLocked() && !hasOpenModal()) forceUnlockBody();
  };
  window.addEventListener("pointerdown", onTouch, { capture: true, passive: true });

  const dispose = () => {
    window.removeEventListener("pointerdown", onTouch, true);
    w.__d4UnlockWatchdog = undefined;
  };
  w.__d4UnlockWatchdog = dispose;
  return dispose;
}
