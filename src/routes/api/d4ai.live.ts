/**
 * Proxy to D4AI live search backend (governors, phone specs, URL scrape).
 * POST /api/d4ai/live  { message: string }
 * Env: D4AI_LIVE_URL=http://HOST:5000/api/chat
 */
import { createFileRoute } from "@tanstack/react-router";

function liveUrl() {
  return (
    process.env.D4AI_LIVE_URL ||
    process.env.D4AI_SEARCH_URL ||
    "http://10.0.0.22:5000/api/chat"
  ).replace(/\/$/, "");
}

export const Route = createFileRoute("/api/d4ai/live")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { message?: string; query?: string };
          const message = String(body.message || body.query || "").trim();
          if (!message) {
            return Response.json({ error: "No message" }, { status: 400 });
          }

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 45_000);
          try {
            const res = await fetch(liveUrl(), {
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
              return Response.json(
                { ok: false, error: `Live backend returned non-JSON (${res.status})` },
                { status: 502 },
              );
            }
            if (!res.ok) {
              return Response.json(
                { ok: false, error: json.error || `Live backend error ${res.status}` },
                { status: 502 },
              );
            }
            const answer = String(json.answer || json.response || "").trim();
            if (!answer) {
              return Response.json({ ok: false, error: "Empty live answer" }, { status: 502 });
            }
            return Response.json({
              ok: true,
              answer,
              sources: Array.isArray(json.sources) ? json.sources : [],
              dict: json.dict || null,
            });
          } finally {
            clearTimeout(timer);
          }
        } catch (e) {
          const msg =
            e instanceof Error
              ? e.name === "AbortError"
                ? "Live search timed out"
                : e.message
              : "Live search failed";
          return Response.json({ ok: false, error: msg }, { status: 502 });
        }
      },
    },
  },
});
