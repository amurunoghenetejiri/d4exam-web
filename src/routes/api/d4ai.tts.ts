/**
 * Free TTS proxy — Google Translate TTS (reliable) + Edge Neural fallback.
 * GET /api/d4ai/tts?voice=rex&text=Hello
 * No API key required.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/** Character / alias → Google TTS language code (accent variety) + Edge voice */
const VOICE_CFG: Record<string, { tl: string; edge: string }> = {
  // Clone character ids + legacy
  ceo: { tl: "en-NG", edge: "en-US-ChristopherNeural" },
  lovelle: { tl: "en-AU", edge: "en-US-JennyNeural" },
  chippy: { tl: "en-IN", edge: "en-US-AnaNeural" },
  whisper: { tl: "en-GB", edge: "en-GB-SoniaNeural" },
  robo: { tl: "en-US", edge: "en-US-DavisNeural" },
  bella: { tl: "en", edge: "en-US-JennyNeural" },
  bubbly: { tl: "en-ZA", edge: "en-US-AnaNeural" },
  cosmo: { tl: "en-IE", edge: "en-GB-RyanNeural" },
  titan: { tl: "en-GB", edge: "en-US-EricNeural" },
  orion: { tl: "en-US", edge: "en-US-SteffanNeural" },
  astro: { tl: "en", edge: "en-US-GuyNeural" },
  baritone: { tl: "en-GB", edge: "en-GB-ThomasNeural" },
  nova: { tl: "en-AU", edge: "en-AU-NatashaNeural" },
  rex: { tl: "en-US", edge: "en-US-ChristopherNeural" },
  atlas: { tl: "en-GB", edge: "en-GB-RyanNeural" },
  nova: { tl: "en", edge: "en-US-JennyNeural" },
  luna: { tl: "en-AU", edge: "en-AU-NatashaNeural" },
  cipher: { tl: "en-US", edge: "en-US-DavisNeural" },
  echo: { tl: "en-GB", edge: "en-GB-ThomasNeural" },
  kai: { tl: "en-IE", edge: "en-US-GuyNeural" },
  aria: { tl: "en-AU", edge: "en-US-AriaNeural" },
  bolt: { tl: "en-IN", edge: "en-US-TonyNeural" },
  sage: { tl: "en-GB", edge: "en-GB-SoniaNeural" },
  pixel: { tl: "en-ZA", edge: "en-US-AnaNeural" },
  volt: { tl: "en-NG", edge: "en-US-SteffanNeural" },
  Brian: { tl: "en-US", edge: "en-US-ChristopherNeural" },
  Amy: { tl: "en", edge: "en-US-JennyNeural" },
  Emma: { tl: "en-AU", edge: "en-US-AriaNeural" },
  Matthew: { tl: "en-GB", edge: "en-US-EricNeural" },
  Joey: { tl: "en", edge: "en-US-GuyNeural" },
  Justin: { tl: "en-US", edge: "en-US-JasonNeural" },
  Joanna: { tl: "en-GB", edge: "en-GB-SoniaNeural" },
  Salli: { tl: "en-AU", edge: "en-US-MichelleNeural" },
  Ivy: { tl: "en", edge: "en-US-AnaNeural" },
};


/** StreamElements free TTS — many distinct named voices */
const SE_VOICES: Record<string, string> = {
  rex: "Brian",
  atlas: "Matthew",
  nova: "Amy",
  luna: "Emma",
  cipher: "Justin", // robotic-ish young male
  echo: "Brian",
  kai: "Joey",
  aria: "Joanna",
  bolt: "Joey",
  sage: "Matthew",
  pixel: "Ivy",
  volt: "Matthew",
};

async function seSpeak(text: string, voice: string): Promise<ArrayBuffer | null> {
  const q = encodeURIComponent(text.slice(0, 280));
  const v = encodeURIComponent(voice);
  const url = `https://api.streamelements.com/kappa/v2/speech?voice=${v}&text=${q}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 D4AI/1.0",
        Accept: "audio/mpeg,audio/*,*/*",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return buf.byteLength > 200 ? buf : null;
  } catch {
    return null;
  }
}

function resolve(raw: string) {
  const v = (raw || "").trim();
  if (VOICE_CFG[v]) return VOICE_CFG[v];
  if (v.includes("Neural")) return { tl: "en-US", edge: v };
  return { tl: "en-US", edge: "en-US-ChristopherNeural" };
}

function secMsGec(): string {
  const ticks = BigInt(Date.now()) * 10000n + 621355968000000000n;
  const rounded = ticks - (ticks % 3000000000n);
  const str = `${rounded}${TRUSTED_CLIENT_TOKEN}`;
  return createHash("sha256").update(str, "ascii").digest("hex").toUpperCase();
}

async function googleSpeak(text: string, tl: string): Promise<ArrayBuffer | null> {
  const q = encodeURIComponent(text.slice(0, 180));
  const urls = [
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(tl)}&q=${q}`,
    `https://translate.google.com/translate_tts?ie=UTF-8&client=gtx&tl=${encodeURIComponent(tl)}&q=${q}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          Accept: "audio/mpeg,audio/*,*/*",
          Referer: "https://translate.google.com/",
        },
      });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 500) return buf;
    } catch {
      /* next */
    }
  }
  return null;
}

async function edgeSpeak(
  text: string,
  voice: string,
  rate = "medium",
  pitch = "default",
): Promise<ArrayBuffer | null> {
  const clean = text
    .slice(0, 400)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'><prosody rate='${rate}' pitch='${pitch}'>${clean}</prosody></voice></speak>`;
  const gec = secMsGec();
  const url =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-130.0.2849.68`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      },
      body: ssml,
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return buf.byteLength > 100 ? buf : null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/d4ai/tts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const text = (url.searchParams.get("text") || "").slice(0, 400).trim();
        const voiceRaw = url.searchParams.get("voice") || "rex";
        if (!text) return new Response("missing text", { status: 400 });

        const cfg = resolve(voiceRaw);
        // Edge Neural first = real different character voices; Google accent fallback
        const prosodyByEdge: Record<string, [string, string]> = {
          "en-US-ChristopherNeural": ["0.95", "-2Hz"],
          "en-US-EricNeural": ["0.82", "-5Hz"],
          "en-US-JennyNeural": ["1.0", "+1Hz"],
          "en-US-AriaNeural": ["0.9", "+3Hz"],
          "en-US-JasonNeural": ["1.12", "-8Hz"],
          "en-GB-RyanNeural": ["1.0", "default"],
          "en-US-GuyNeural": ["1.15", "+2Hz"],
          "en-US-MichelleNeural": ["0.95", "+4Hz"],
          "en-US-AnaNeural": ["1.25", "+8Hz"],
          "en-US-SteffanNeural": ["1.05", "default"],
          "en-GB-SoniaNeural": ["0.95", "+2Hz"],
        };
        const charKey = voiceRaw.toLowerCase();
        const prosodyByChar: Record<string, [string, string]> = {
          rex: ["0.95", "-2Hz"], atlas: ["0.82", "-5Hz"], nova: ["1.0", "+1Hz"],
          luna: ["0.9", "+3Hz"], cipher: ["1.12", "-8Hz"], echo: ["1.0", "default"],
          kai: ["1.15", "+2Hz"], aria: ["0.95", "+4Hz"], bolt: ["1.2", "+2Hz"],
          sage: ["0.78", "-4Hz"], pixel: ["1.25", "+8Hz"], volt: ["1.05", "default"],
        };
        const [rate, pitch] =
          prosodyByChar[charKey] ||
          prosodyByEdge[cfg.edge] ||
          ["1.0", "default"];
        // Google Translate TTS first (reliable, different accents per character).
        // Edge Neural second. StreamElements last (often 401 from serverless).
        let buf = await googleSpeak(text, cfg.tl);
        if (!buf) buf = await edgeSpeak(text, cfg.edge, rate, pitch);
        const seName = SE_VOICES[voiceRaw.toLowerCase()] || null;
        if (!buf && seName) buf = await seSpeak(text, seName);
        if (!buf) return new Response("tts unavailable", { status: 502 });

        return new Response(buf, {
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
