/**
 * Proxy to D4AI live search backend.
 * POST /api/d4ai/live  { message: string }
 *
 * Env (set on Vercel):
 *   D4AI_LIVE_URL = http://YOUR_PUBLIC_HOST:5000/api/chat
 * Optional fallback list:
 *   D4AI_LIVE_URLS = http://a:5000/api/chat,http://b:5000/api/chat
 */
import { createFileRoute } from "@tanstack/react-router";

function liveTargets(): string[] {
  const multi = (process.env.D4AI_LIVE_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const single = (process.env.D4AI_LIVE_URL || process.env.D4AI_SEARCH_URL || "").trim();
  const defaults = ["http://10.0.0.22:5000/api/chat", "http://127.0.0.1:5000/api/chat"];
  const all = [...multi, ...(single ? [single] : []), ...defaults];
  // unique
  return [...new Set(all.map((u) => u.replace(/\/$/, "")))];
}

export const Route = createFileRoute("/api/d4ai/live")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { message?: string; query?: string };
          const message = String(body.message || body.query || "").trim();
          if (!message) {
            return Response.json({ ok: false, error: "No message" }, { status: 400 });
          }

          const targets = liveTargets();
          let lastErr = "No live backend reachable";
          for (const url of targets) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 40_000);
            try {
              const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ message }),
                signal: controller.signal,
              });
              const text = await res.text();
              let json: {
                answer?: string;
                response?: string;
                sources?: string[];
                dict?: Record<string, unknown>;
                error?: string;
              } = {};
              try {
                json = text ? (JSON.parse(text) as typeof json) : {};
              } catch {
                lastErr = `Non-JSON from ${url} (${res.status})`;
                continue;
              }
              if (!res.ok) {
                lastErr = json.error || `HTTP ${res.status} from ${url}`;
                continue;
              }
              const answer = String(json.answer || json.response || "").trim();
              if (!answer) {
                lastErr = `Empty answer from ${url}`;
                continue;
              }
              return Response.json({
                ok: true,
                answer,
                sources: Array.isArray(json.sources) ? json.sources : [],
                dict: json.dict || null,
                via: url,
              });
            } catch (e) {
              lastErr =
                e instanceof Error
                  ? e.name === "AbortError"
                    ? `Timeout contacting ${url}`
                    : `${e.message} (${url})`
                  : `Failed ${url}`;
            } finally {
              clearTimeout(timer);
            }
          }
          return Response.json({ ok: false, error: lastErr }, { status: 502 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Live search failed";
          return Response.json({ ok: false, error: msg }, { status: 502 });
        }
      },
    },
  },
});
