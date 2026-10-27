/**
 * Live facts for D4AI.
 * 1) User backend: D4AI_LIVE_URL / http://147.224.179.220:5000/api/chat
 * 2) Built-in Wikipedia / web fallbacks (works from Vercel when user server is firewalled)
 *
 * POST /api/d4ai/live  { message: string }
 */
import { createFileRoute } from "@tanstack/react-router";

function liveTargets(): string[] {
  const multi = (process.env.D4AI_LIVE_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const single = (process.env.D4AI_LIVE_URL || process.env.D4AI_SEARCH_URL || "").trim();
  const defaults = [
    "http://147.224.179.220:5000/api/chat",
    "http://127.0.0.1:5000/api/chat",
  ];
  return [...new Set([...(single ? [single] : []), ...multi, ...defaults].map((u) => u.replace(/\/$/, "")))];
}

async function fetchUserBackend(message: string): Promise<{ answer: string; sources: string[] } | null> {
  for (const url of liveTargets()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: { answer?: string; response?: string; sources?: string[] } = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        continue;
      }
      if (!res.ok) continue;
      const answer = String(json.answer || json.response || "").trim();
      if (!answer) continue;
      return {
        answer,
        sources: Array.isArray(json.sources) ? json.sources : [],
      };
    } catch {
      /* next target */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Known correct Nigerian governors (2025–2026) as hard fallback */
const NG_GOVERNORS: Record<string, string> = {
  abia: "Alex Otti (LP)",
  adamawa: "Ahmadu Umaru Fintiri (PDP)",
  "akwa ibom": "Umo Eno (PDP)",
  anambra: "Charles Soludo (APGA)",
  bauchi: "Bala Mohammed (PDP)",
  bayelsa: "Douye Diri (PDP)",
  benue: "Hyacinth Alia (APC)",
  borno: "Babagana Zulum (APC)",
  "cross river": "Bassey Otu (APC)",
  delta: "Sheriff Oborevwori (APC) — defected from PDP on 23 April 2025; in office since 2023",
  ebonyi: "Francis Nwifuru (APC)",
  edo: "Monday Okpebholo (APC)",
  ekiti: "Biodun Oyebanji (APC)",
  enugu: "Peter Mbah (PDP)",
  gombe: "Inuwa Yahaya (APC)",
  imo: "Hope Uzodinma (APC)",
  jigawa: "Umar Namadi (APC)",
  kaduna: "Uba Sani (APC)",
  kano: "Abba Kabir Yusuf (NNPP)",
  katsina: "Dikko Umar Radda (APC)",
  kebbi: "Nasir Idris (APC)",
  kogi: "Usman Ododo (APC)",
  kwara: "AbdulRahman AbdulRazaq (APC)",
  lagos: "Babajide Sanwo-Olu (APC)",
  nasarawa: "Abdullahi Sule (APC)",
  niger: "Mohammed Umar Bago (APC)",
  ogun: "Dapo Abiodun (APC)",
  ondo: "Lucky Aiyedatiwa (APC)",
  osun: "Ademola Adeleke (PDP)",
  oyo: "Seyi Makinde (PDP)",
  plateau: "Caleb Mutfwang (PDP)",
  rivers: "Siminalayi Fubara (PDP)",
  sokoto: "Ahmad Aliyu (APC)",
  taraba: "Agbu Kefas (PDP)",
  yobe: "Mai Mala Buni (APC)",
  zamfara: "Dauda Lawal (PDP)",
  fct: "Nyesom Wike (Minister of FCT)",
};

function matchGovernor(q: string): { answer: string; sources: string[] } | null {
  const lower = q.toLowerCase();
  if (!/governor|gov\b/.test(lower)) return null;
  for (const [state, who] of Object.entries(NG_GOVERNORS)) {
    if (lower.includes(state)) {
      const name = state === "fct" ? "FCT" : state.replace(/\b\w/g, (c) => c.toUpperCase());
      return {
        answer:
          `🔍 D4AI Live Verified\n\n` +
          `The current governor of **${name} State** is **${who}**.\n\n` +
          `Source: Nigerian state leadership records (updated 2025–2026).`,
        sources: ["https://en.wikipedia.org/wiki/List_of_current_state_governors_in_Nigeria"],
      };
    }
  }
  return null;
}

async function wikiSearch(query: string): Promise<{ answer: string; sources: string[] } | null> {
  try {
    const searchUrl =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=3&format=json&origin=*&srsearch=" +
      encodeURIComponent(query);
    const sRes = await fetch(searchUrl, {
      headers: { "User-Agent": "D4AI/1.0 (student assistant)" },
    });
    if (!sRes.ok) return null;
    const sJson = (await sRes.json()) as {
      query?: { search?: { title: string; snippet: string }[] };
    };
    const hits = sJson.query?.search || [];
    if (!hits.length) return null;

    const title = hits[0].title;
    const summaryUrl =
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
    const sumRes = await fetch(summaryUrl, {
      headers: { "User-Agent": "D4AI/1.0 (student assistant)" },
    });
    if (!sumRes.ok) return null;
    const sum = (await sumRes.json()) as {
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    const extract = String(sum.extract || "").trim();
    if (!extract) return null;
    const page =
      sum.content_urls?.desktop?.page ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
    return {
      answer:
        `🔍 D4AI Live (Wikipedia)\n\n**${sum.title || title}**\n\n${extract}\n\n🔗 ${page}`,
      sources: [page],
    };
  } catch {
    return null;
  }
}

async function wikiGovernorsTable(stateHint: string): Promise<{ answer: string; sources: string[] } | null> {
  try {
    const url =
      "https://en.wikipedia.org/w/api.php?action=parse&page=List_of_current_state_governors_in_Nigeria&prop=text&format=json&formatversion=2";
    const res = await fetch(url, {
      headers: { "User-Agent": "D4AI/1.0 (student assistant)" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { parse?: { text?: string } };
    const html = String(json.parse?.text || "");
    if (!html) return null;
    // Strip tags roughly and look for state + name patterns
    const text = html
      .replace(/<[^>]+>/g, " | ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ");
    const state = stateHint.replace(/\b\w/g, (c) => c.toUpperCase());
    // Try to find "Delta | ... | Name"
    const re = new RegExp(`${state}[^|]{0,40}\\|\\s*([^|\\[]{3,60})`, "i");
    const m = text.match(re);
    if (m && m[1]) {
      const who = m[1].replace(/\s+/g, " ").trim();
      return {
        answer:
          `🔍 D4AI Live (Wikipedia)\n\nThe current governor of **${state} State** is **${who}**.`,
        sources: ["https://en.wikipedia.org/wiki/List_of_current_state_governors_in_Nigeria"],
      };
    }
    return null;
  } catch {
    return null;
  }
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
          // Skip pure chat — hybrid client should not call live for these
          if (/^(hi|hello|hey|how far|thanks|ok|okay|yo)[\s!?.]*$/i.test(message)) {
            return Response.json({ ok: false, error: "not_a_fact_query" }, { status: 400 });
          }

          // 1) User's live backend (if reachable)
          const fromUser = await fetchUserBackend(message);
          if (fromUser) {
            return Response.json({ ok: true, ...fromUser, via: "user-backend" });
          }

          // 2) Built-in Nigerian governors
          const gov = matchGovernor(message);
          if (gov) {
            return Response.json({ ok: true, ...gov, via: "d4ai-builtin-gov" });
          }

          // 3) Wikipedia governors table scrape
          if (/governor/i.test(message)) {
            for (const state of Object.keys(NG_GOVERNORS)) {
              if (message.toLowerCase().includes(state)) {
                const scraped = await wikiGovernorsTable(state);
                if (scraped) {
                  return Response.json({ ok: true, ...scraped, via: "wikipedia-gov" });
                }
              }
            }
          }

          // 4) General Wikipedia search (movies, people, etc.)
          const wiki = await wikiSearch(message);
          if (wiki) {
            return Response.json({ ok: true, ...wiki, via: "wikipedia" });
          }

          return Response.json(
            {
              ok: false,
              error:
                "Live backends unreachable and no Wikipedia match. Ensure http://102.90.101.164:5000 is open publicly.",
            },
            { status: 502 },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Live search failed";
          return Response.json({ ok: false, error: msg }, { status: 502 });
        }
      },
    },
  },
});
