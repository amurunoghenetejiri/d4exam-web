/**
 * Capacitor SPA entry — mounts the app without SSR / Vercel.
 * Used only by the Android bundled shell (scripts/prepare-capacitor-dist.mjs).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import "./styles.css";

function hideBoot() {
  const boot = document.getElementById("d4-boot");
  if (boot) boot.style.display = "none";
}

function showBootError(message: string) {
  const boot = document.getElementById("d4-boot");
  if (!boot) return;
  boot.classList.add("show-retry");
  const p = boot.querySelector("p");
  if (p) p.textContent = message;
}

function main() {
  try {
    // Pure client mode: tells the root route to skip the SSR <html>/<body>
    // shell and the router to skip preloading/hydration behaviour.
    (window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA = true;

    let rootEl = document.getElementById("root");
    if (!rootEl) {
      rootEl = document.createElement("div");
      rootEl.id = "root";
      document.body.appendChild(rootEl);
    }

    const router = getRouter();
    createRoot(rootEl).render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );

    const obs = new MutationObserver(() => {
      if (rootEl && rootEl.childNodes.length > 0) {
        hideBoot();
        obs.disconnect();
      }
    });
    obs.observe(rootEl, { childList: true, subtree: true });
    setTimeout(hideBoot, 4000);
  } catch (err) {
    console.error("[D4EXAM] Capacitor SPA boot failed", err);
    showBootError(
      "Could not start D4EXAM. Tap Try again. If this continues, reinstall the app.",
    );
  }
}

main();
