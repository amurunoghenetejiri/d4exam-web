/**
 * Proxy to D4AI Voice Cloning API (http://147.224.179.220:8000)
 * Avoids mixed-content blocks from HTTPS Vercel → HTTP voice server.
 *
 * GET  /api/d4ai/voice?action=characters
 * GET  /api/d4ai/voice?action=file&path=/api/voice/preview_ceo.wav
 * POST /api/d4ai/voice  { action: "tts-clone", text, voice }
 */
import { createFileRoute } from "@tanstack/react-router";

function voiceBase(): string {
  const env = (process.env.VOICE_API_URL || process.env.VITE_VOICE_API_URL || "").trim();
  if (env) return env.replace(/\/$/, "");
  return "http://147.224.179.220:8000";
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const Route = createFileRoute("/api/d4ai/voice")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const action = url.searchParams.get("action") || "characters";
        const base = voiceBase();

        try {
          if (action === "characters") {
            const res = await fetch(`${base}/api/characters`, {
              cache: "no-store",
              signal: AbortSignal.timeout(15000),
            });
            const text = await res.text();
            return new Response(text, {
              status: res.status,
              headers: { ...cors, "Content-Type": "application/json" },
            });
          }

          if (action === "file") {
            let path = url.searchParams.get("path") || "";
            if (!path.startsWith("/api/voice/")) {
              return Response.json({ error: "invalid path" }, { status: 400, headers: cors });
            }
            const res = await fetch(`${base}${path}`, {
              cache: "no-store",
              signal: AbortSignal.timeout(60000),
            });
            if (!res.ok) {
              return new Response("audio fetch failed", { status: res.status, headers: cors });
            }
            const buf = await res.arrayBuffer();
            const ct = res.headers.get("Content-Type") || "audio/wav";
            return new Response(buf, {
              status: 200,
              headers: {
                ...cors,
                "Content-Type": ct,
                "Cache-Control": "public, max-age=300",
              },
            });
          }

          return Response.json({ error: "unknown action" }, { status: 400, headers: cors });
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "voice proxy error" },
            { status: 502, headers: cors },
          );
        }
      },
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            action?: string;
            text?: string;
            voice?: string;
          };
          const text = String(body.text || "").trim().slice(0, 500);
          const voice = String(body.voice || "ceo_ref.wav").trim();
          if (!text) {
            return Response.json({ error: "missing text" }, { status: 400, headers: cors });
          }
          const base = voiceBase();
          const res = await fetch(`${base}/api/tts-clone`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ text, voice }),
            signal: AbortSignal.timeout(90000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !(data as { success?: boolean }).success) {
            return Response.json(
              { error: (data as { error?: string }).error || `tts ${res.status}` },
              { status: 502, headers: cors },
            );
          }
          const audioUrl = String((data as { audio_url?: string }).audio_url || "");
          // Return proxied play URL so browser stays on HTTPS
          const play =
            `/api/d4ai/voice?action=file&path=${encodeURIComponent(audioUrl)}`;
          return Response.json(
            { success: true, audio_url: audioUrl, play_url: play },
            { headers: cors },
          );
        } catch (e) {
          return Response.json(
            { error: e instanceof Error ? e.message : "tts-clone failed" },
            { status: 502, headers: cors },
          );
        }
      },
    },
  },
});
