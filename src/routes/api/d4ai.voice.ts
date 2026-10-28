/**
 * D4AI Voice proxy
 * - Characters list from :8000 (or embedded fallback)
 * - TTS from Flask :5000 POST /api/tts (Piper, 13 voices) — returns audio bytes
 */
import { createFileRoute } from "@tanstack/react-router";

function voiceBase(): string {
  const env = (process.env.VOICE_API_URL || process.env.VITE_VOICE_API_URL || "").trim();
  if (env) return env.replace(/\/$/, "");
  return "http://147.224.179.220:8000";
}

function ttsBase(): string {
  const env = (process.env.D4AI_LIVE_URL || process.env.D4AI_CHAT_URL || "").trim();
  if (env) return env.replace(/\/api\/chat\/?$/, "").replace(/\/$/, "");
  return "http://147.224.179.220:5000";
}

const FALLBACK_CHARS = [
  { id: "ceo", name: "Amurun Destiny", title: "👑 CEO - Real Voice", vibe: "Nigerian Visionary", emoji: "👑", file: "ceo_ref.wav", audio_url: "/api/voice/preview_ceo.wav" },
  { id: "lovelle", name: "Lovelle", title: "💖 Romantic Female", vibe: "Warm romantic", emoji: "💖", file: "lovelle_romantic_ref.wav", audio_url: "/api/voice/preview_lovelle.wav" },
  { id: "chippy", name: "Chippy", title: "🐿️ Chipmunk", vibe: "High pitch", emoji: "🐿️", file: "chippy_chipmunk_ref.wav", audio_url: "/api/voice/preview_chippy.wav" },
  { id: "whisper", name: "Whisper", title: "🤫 Soft Whisper", vibe: "ASMR soft", emoji: "🤫", file: "whisper_soft_ref.wav", audio_url: "/api/voice/preview_whisper.wav" },
  { id: "nova", name: "Nova", title: "👽 Alien Sweet", vibe: "Sweet alien", emoji: "👽", file: "nova_alien_ref.wav", audio_url: "/api/voice/preview_nova.wav" },
  { id: "robo", name: "Robo", title: "🤖 Robot AI", vibe: "Metallic", emoji: "🤖", file: "robo_metal_ref.wav", audio_url: "/api/voice/preview_robo.wav" },
  { id: "bella", name: "Bella", title: "💋 Romance Warm", vibe: "Warm romance", emoji: "💋", file: "bella_romance_ref.wav", audio_url: "/api/voice/preview_bella.wav" },
  { id: "bubbly", name: "Bubbly", title: "🌈 Cartoon", vibe: "Vibrant", emoji: "🌈", file: "bubbly_cartoon_ref.wav", audio_url: "/api/voice/preview_bubbly.wav" },
  { id: "cosmo", name: "Cosmo", title: "🛸 Alien Cool", vibe: "Cool male alien", emoji: "🛸", file: "cosmo_alien_ref.wav", audio_url: "/api/voice/preview_cosmo.wav" },
  { id: "titan", name: "Titan", title: "🔊 Bass Beast", vibe: "Super deep", emoji: "🔊", file: "titan_bass_ref.wav", audio_url: "/api/voice/preview_titan.wav" },
  { id: "orion", name: "Orion", title: "🧠 Wise Robot", vibe: "Deep wise", emoji: "🧠", file: "orion_wise_ref.wav", audio_url: "/api/voice/preview_orion.wav" },
  { id: "astro", name: "Astro", title: "👾 Chill Alien", vibe: "Chill buddy", emoji: "👾", file: "astro_chill_ref.wav", audio_url: "/api/voice/preview_astro.wav" },
  { id: "baritone", name: "Baritone", title: "🎙️ Deep Bass", vibe: "Steady deep", emoji: "🎙️", file: "baritone_deep_ref.wav", audio_url: "/api/voice/preview_baritone.wav" },
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function voiceIdFromFile(voice: string): string {
  const v = voice.replace(/_ref\.wav$/i, "").replace(/\.wav$/i, "");
  // titan_bass -> titan, lovelle_romantic -> lovelle
  const base = v.split("_")[0] || v;
  return base.toLowerCase();
}

export const Route = createFileRoute("/api/d4ai/voice")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const action = url.searchParams.get("action") || "characters";
        try {
          if (action === "characters") {
            try {
              const res = await fetch(`${voiceBase()}/api/characters`, {
                cache: "no-store",
                signal: AbortSignal.timeout(8000),
              });
              if (res.ok) {
                const text = await res.text();
                return new Response(text, {
                  status: 200,
                  headers: { ...cors, "Content-Type": "application/json" },
                });
              }
            } catch {
              /* fallback */
            }
            return Response.json({ characters: FALLBACK_CHARS }, { headers: cors });
          }

          if (action === "file") {
            let path = url.searchParams.get("path") || "";
            if (!path.startsWith("/api/voice/")) {
              return Response.json({ error: "invalid path" }, { status: 400, headers: cors });
            }
            const res = await fetch(`${voiceBase()}${path}`, {
              cache: "no-store",
              signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) {
              return new Response("audio fetch failed", { status: res.status, headers: cors });
            }
            const buf = await res.arrayBuffer();
            return new Response(buf, {
              status: 200,
              headers: {
                ...cors,
                "Content-Type": res.headers.get("Content-Type") || "audio/wav",
              },
            });
          }

          // Direct TTS: GET ?action=tts&text=...&voice=ceo
          if (action === "tts") {
            const text = (url.searchParams.get("text") || "").slice(0, 400);
            const voice = url.searchParams.get("voice") || "ceo";
            if (!text) {
              return Response.json({ error: "missing text" }, { status: 400, headers: cors });
            }
            const res = await fetch(`${ttsBase()}/api/tts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text, voice: voiceIdFromFile(voice) }),
              signal: AbortSignal.timeout(60000),
            });
            if (!res.ok) {
              return Response.json({ error: `tts ${res.status}` }, { status: 502, headers: cors });
            }
            const buf = await res.arrayBuffer();
            return new Response(buf, {
              status: 200,
              headers: {
                ...cors,
                "Content-Type": res.headers.get("Content-Type") || "audio/wav",
                "Cache-Control": "no-store",
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
            text?: string;
            voice?: string;
            action?: string;
          };
          const text = String(body.text || "").trim().slice(0, 500);
          const voiceRaw = String(body.voice || "ceo").trim();
          const voice = voiceIdFromFile(voiceRaw);
          if (!text) {
            return Response.json({ error: "missing text" }, { status: 400, headers: cors });
          }

          // Primary: Flask Piper TTS on :5000 (returns audio bytes)
          try {
            const res = await fetch(`${ttsBase()}/api/tts`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "*/*" },
              body: JSON.stringify({ text, voice }),
              signal: AbortSignal.timeout(60000),
            });
            if (res.ok) {
              const buf = await res.arrayBuffer();
              if (buf.byteLength > 200) {
                // Return JSON with data URL for simpler client, OR binary
                // Client expects play_url OR we return audio directly with Accept
                const accept = request.headers.get("Accept") || "";
                if (accept.includes("audio") || body.action === "binary") {
                  return new Response(buf, {
                    status: 200,
                    headers: {
                      ...cors,
                      "Content-Type": res.headers.get("Content-Type") || "audio/wav",
                    },
                  });
                }
                // Default: stream binary as wav (client uses blob)
                return new Response(buf, {
                  status: 200,
                  headers: {
                    ...cors,
                    "Content-Type": "audio/wav",
                    "X-D4AI-Voice": voice,
                  },
                });
              }
            }
          } catch {
            /* fall through to clone API */
          }

          // Fallback: :8000 tts-clone JSON
          try {
            const res = await fetch(`${voiceBase()}/api/tts-clone`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text, voice: voiceRaw.includes(".wav") ? voiceRaw : `${voice}_ref.wav` }),
              signal: AbortSignal.timeout(60000),
            });
            const data = (await res.json()) as { success?: boolean; audio_url?: string };
            if (res.ok && data.success && data.audio_url) {
              const play = `/api/d4ai/voice?action=file&path=${encodeURIComponent(data.audio_url)}`;
              return Response.json({ success: true, play_url: play, audio_url: data.audio_url }, { headers: cors });
            }
          } catch {
            /* */
          }

          return Response.json({ error: "tts failed" }, { status: 502, headers: cors });
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
