/**
 * D4AI chat proxy — frontend MUST only call this (same-origin).
 * Never call Ollama or :11434 from the browser.
 *
 * POST /api/d4ai/chat  { message: string }
 * Proxies to Flask: D4AI_LIVE_URL or http://147.224.179.220:5000/api/chat
 */
import { createFileRoute } from "@tanstack/react-router";

function flaskChatUrl(): string {
  const env = (process.env.D4AI_LIVE_URL || process.env.D4AI_CHAT_URL || "").trim();
  if (env) return env.replace(/\/$/, "");
  return "http://147.224.179.220:5000/api/chat";
}

export const Route = createFileRoute("/api/d4ai/chat")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        }),
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            message?: string;
            query?: string;
            messages?: { role: string; content: string }[];
          };

          // Accept either plain message or last user message from history
          let message = String(body.message || body.query || "").trim();
          if (!message && Array.isArray(body.messages) && body.messages.length) {
            const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
            message = String(lastUser?.content || "").trim();
          }
          if (!message) {
            return Response.json({ ok: false, error: "No message" }, { status: 400 });
          }

          const url = flaskChatUrl();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60_000);

          try {
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({ message }),
              signal: controller.signal,
              cache: "no-store",
            });

            const text = await res.text();
            let json: {
              answer?: string;
              response?: string;
              sources?: string[];
              error?: string;
              status?: string;
            } = {};
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              return Response.json(
                {
                  ok: false,
                  error: `Backend returned non-JSON (${res.status})`,
                },
                { status: 502 },
              );
            }

            if (!res.ok) {
              return Response.json(
                { ok: false, error: json.error || `Backend HTTP ${res.status}` },
                { status: 502 },
              );
            }

            const answer = String(json.answer || json.response || "").trim();
            if (!answer) {
              return Response.json({ ok: false, error: "Empty answer from backend" }, { status: 502 });
            }

            return Response.json({
              ok: true,
              answer,
              sources: Array.isArray(json.sources) ? json.sources : [],
            });
          } finally {
            clearTimeout(timer);
          }
        } catch (e) {
          const msg =
            e instanceof Error
              ? e.name === "AbortError"
                ? "D4AI backend timed out"
                : e.message
              : "D4AI backend unreachable";
          return Response.json({ ok: false, error: msg }, { status: 502 });
        }
      },
      GET: async () => {
        // Health proxy
        try {
          const base = flaskChatUrl().replace(/\/api\/chat$/, "");
          const res = await fetch(`${base}/api/status`, {
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          });
          const text = await res.text();
          let json: unknown = {};
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = { raw: text.slice(0, 200) };
          }
          return Response.json({ ok: res.ok, backend: json, via: base });
        } catch (e) {
          return Response.json(
            {
              ok: false,
              error: e instanceof Error ? e.message : "status failed",
            },
            { status: 502 },
          );
        }
      },
    },
  },
});
