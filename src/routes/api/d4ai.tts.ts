/**
 * Free TTS proxy using Microsoft Edge Neural voices (no API key).
 * GET /api/d4ai/tts?voice=en-US-ChristopherNeural&text=Hello
 * Also accepts short aliases: Brian, Amy, etc. (mapped below).
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/** Map short names + character ids → Edge Neural voice */
const VOICE_MAP: Record<string, string> = {
  // character aliases
  rex: "en-US-ChristopherNeural",
  atlas: "en-US-EricNeural",
  nova: "en-US-JennyNeural",
  luna: "en-US-AriaNeural",
  cipher: "en-US-JasonNeural",
  echo: "en-GB-RyanNeural",
  kai: "en-US-GuyNeural",
  aria: "en-US-MichelleNeural",
  bolt: "en-US-GuyNeural",
  sage: "en-US-EricNeural",
  pixel: "en-US-AnaNeural",
  volt: "en-US-SteffanNeural",
  // StreamElements-style aliases
  Brian: "en-US-ChristopherNeural",
  Matthew: "en-US-EricNeural",
  Amy: "en-US-JennyNeural",
  Emma: "en-US-AriaNeural",
  Justin: "en-US-JasonNeural",
  Joanna: "en-GB-SoniaNeural",
  Joey: "en-US-GuyNeural",
  Salli: "en-US-MichelleNeural",
  Ivy: "en-US-AnaNeural",
  // direct neural names pass through
};

const PITCH_RATE: Record<string, { pitch: string; rate: string }> = {
  "en-US-ChristopherNeural": { pitch: "+0Hz", rate: "+0%" },
  "en-US-EricNeural": { pitch: "-15Hz", rate: "-10%" },
  "en-US-JennyNeural": { pitch: "+0Hz", rate: "+0%" },
  "en-US-AriaNeural": { pitch: "+5Hz", rate: "+5%" },
  "en-US-JasonNeural": { pitch: "-25Hz", rate: "+5%" },
  "en-GB-RyanNeural": { pitch: "+0Hz", rate: "+0%" },
  "en-US-GuyNeural": { pitch: "+10Hz", rate: "+15%" },
  "en-US-MichelleNeural": { pitch: "+20Hz", rate: "+5%" },
  "en-US-AnaNeural": { pitch: "+30Hz", rate: "+20%" },
  "en-US-SteffanNeural": { pitch: "-5Hz", rate: "+0%" },
  "en-GB-SoniaNeural": { pitch: "+0Hz", rate: "+0%" },
};

function resolveVoice(raw: string): string {
  const v = (raw || "").trim();
  if (!v) return "en-US-ChristopherNeural";
  if (VOICE_MAP[v]) return VOICE_MAP[v];
  if (v.includes("Neural")) return v;
  return VOICE_MAP[v] || "en-US-ChristopherNeural";
}

/** Sec-MS-GEC token required by Edge read-aloud */
function secMsGec(): string {
  const ticks = BigInt(Date.now()) * 10000n + 621355968000000000n;
  const rounded = ticks - (ticks % 3000000000n);
  const str = `${rounded}${TRUSTED_CLIENT_TOKEN}`;
  return createHash("sha256").update(str, "ascii").digest("hex").toUpperCase();
}

async function edgeSpeak(text: string, voice: string): Promise<ArrayBuffer | null> {
  const clean = text.slice(0, 400).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c);
  const pr = PITCH_RATE[voice] || { pitch: "+0Hz", rate: "+0%" };
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pr.pitch}' rate='${pr.rate}'>${clean}</prosody>` +
    `</voice></speak>`;

  const gec = secMsGec();
  const url =
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=1-130.0.2849.68`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        Accept: "audio/mpeg, audio/webm, audio/*;q=0.9, */*;q=0.8",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      },
      body: ssml,
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 100) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Fallback: StreamElements */
async function seSpeak(text: string, voiceHint: string): Promise<ArrayBuffer | null> {
  const seVoices = ["Brian", "Amy", "Emma", "Matthew", "Joey", "Justin", "Joanna", "Salli", "Ivy"];
  const v = seVoices.includes(voiceHint) ? voiceHint : "Brian";
  try {
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(v)}&text=${encodeURIComponent(text.slice(0, 180))}`;
    const res = await fetch(url, { headers: { Accept: "audio/mpeg,audio/*,*/*" } });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return buf.byteLength > 80 ? buf : null;
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

        const edgeVoice = resolveVoice(voiceRaw);
        let buf = await edgeSpeak(text, edgeVoice);
        if (!buf) {
          // map edge → SE fallback roughly
          const seHint =
            /Jenny|Aria|Michelle|Ana|Sonia|Emma|Amy/i.test(edgeVoice)
              ? "Amy"
              : /Jason|Ana/i.test(edgeVoice)
                ? "Justin"
                : /Guy|Steffan/i.test(edgeVoice)
                  ? "Joey"
                  : "Brian";
          buf = await seSpeak(text, seHint);
        }
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
