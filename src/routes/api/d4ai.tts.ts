/**
 * TTS proxy — fetches speech audio server-side so the app WebView can play it.
 * GET /api/d4ai/tts?voice=Brian&text=Hello
 */
import { createFileRoute } from "@tanstack/react-router";

const VOICES = new Set([
  "Brian",
  "Amy",
  "Emma",
  "Joanna",
  "Matthew",
  "Joey",
  "Salli",
  "Justin",
  "Ivy",
  "Kendra",
  "Kimberly",
  "Nicole",
]);

export const Route = createFileRoute("/api/d4ai/tts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const text = (url.searchParams.get("text") || "").slice(0, 200).trim();
        let voice = url.searchParams.get("voice") || "Brian";
        if (!VOICES.has(voice)) voice = "Brian";
        if (!text) {
          return new Response("missing text", { status: 400 });
        }

        // Primary: StreamElements
        const se = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;
        try {
          const res = await fetch(se, {
            headers: { "User-Agent": "D4AI/1.0", Accept: "audio/mpeg,audio/*,*/*" },
          });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength > 100) {
              return new Response(buf, {
                headers: {
                  "Content-Type": res.headers.get("content-type") || "audio/mpeg",
                  "Cache-Control": "public, max-age=3600",
                  "Access-Control-Allow-Origin": "*",
                },
              });
            }
          }
        } catch {
          /* fall through */
        }

        // Fallback: Google Translate TTS
        const g =
          `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=` +
          encodeURIComponent(text);
        try {
          const res = await fetch(g, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
              Accept: "audio/mpeg,audio/*,*/*",
              Referer: "https://translate.google.com/",
            },
          });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength > 50) {
              return new Response(buf, {
                headers: {
                  "Content-Type": "audio/mpeg",
                  "Cache-Control": "public, max-age=3600",
                  "Access-Control-Allow-Origin": "*",
                },
              });
            }
          }
        } catch {
          /* fall through */
        }

        return new Response("tts unavailable", { status: 502 });
      },
    },
  },
});
