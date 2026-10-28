/**
 * D4AI chat proxy — frontend only calls this route.
 * 1) Optional multi-source web research (up to 4 sources)
 * 2) Proxy to Flask with research notes injected
 * 3) Strip source URLs from the final answer
 *
 * POST /api/d4ai/chat  { message: string }
 */
import { createFileRoute } from "@tanstack/react-router";

function flaskChatUrl(): string {
  const env = (process.env.D4AI_LIVE_URL || process.env.D4AI_CHAT_URL || "").trim();
  if (env) return env.replace(/\/$/, "");
  return "http://147.224.179.220:5000/api/chat";
}

function needsWeb(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t || t.length < 4) return false;
  if (/^(hi|hello|hey|how far|thanks|ok|okay|xup|yo|sup)[\s!?.]*$/i.test(t)) return false;
  if (/https?:\/\//i.test(text)) return true;
  if (/\b(current|today|latest|live|right now|this year|2024|2025|2026|who is the|president|governor|minister|price|how much|news|released|iphone|ceo of)\b/i.test(t)) {
    return true;
  }
  return false;
}

type SourceNote = { title: string; text: string };

async function wikiSummary(query: string): Promise<SourceNote | null> {
  try {
    const searchUrl =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&origin=*&srsearch=" +
      encodeURIComponent(query);
    const sRes = await fetch(searchUrl, {
      headers: { "User-Agent": "D4AI/1.0 (student assistant)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!sRes.ok) return null;
    const sJson = (await sRes.json()) as {
      query?: { search?: { title: string }[] };
    };
    const title = sJson.query?.search?.[0]?.title;
    if (!title) return null;
    const sumRes = await fetch(
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title),
      {
        headers: { "User-Agent": "D4AI/1.0 (student assistant)" },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!sumRes.ok) return null;
    const sum = (await sumRes.json()) as { title?: string; extract?: string };
    const extract = String(sum.extract || "").trim();
    if (!extract) return null;
    return { title: sum.title || title, text: extract.slice(0, 900) };
  } catch {
    return null;
  }
}

/** DuckDuckGo Instant Answer API */
async function ddgInstant(query: string): Promise<SourceNote | null> {
  try {
    const url =
      "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
      encodeURIComponent(query);
    const res = await fetch(url, {
      headers: { "User-Agent": "D4AI/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      AbstractText?: string;
      Heading?: string;
      Answer?: string;
      RelatedTopics?: { Text?: string; FirstURL?: string }[];
    };
    if (j.AbstractText?.trim()) {
      return {
        title: j.Heading || "Web summary",
        text: j.AbstractText.trim().slice(0, 900),
      };
    }
    if (j.Answer?.trim()) {
      return { title: "Quick answer", text: j.Answer.trim().slice(0, 400) };
    }
    const rel = (j.RelatedTopics || []).filter((t) => t.Text).slice(0, 2);
    if (rel.length) {
      return {
        title: "Related facts",
        text: rel.map((t) => t.Text).join(" ").slice(0, 900),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Wikipedia search for a second page when useful */
async function wikiSecond(query: string): Promise<SourceNote | null> {
  try {
    const searchUrl =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=2&format=json&origin=*&srsearch=" +
      encodeURIComponent(query);
    const sRes = await fetch(searchUrl, {
      headers: { "User-Agent": "D4AI/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!sRes.ok) return null;
    const sJson = (await sRes.json()) as {
      query?: { search?: { title: string }[] };
    };
    const title = sJson.query?.search?.[1]?.title;
    if (!title) return null;
    const sumRes = await fetch(
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title),
      { headers: { "User-Agent": "D4AI/1.0" }, signal: AbortSignal.timeout(8000) },
    );
    if (!sumRes.ok) return null;
    const sum = (await sumRes.json()) as { title?: string; extract?: string };
    const extract = String(sum.extract || "").trim();
    if (!extract) return null;
    return { title: sum.title || title, text: extract.slice(0, 700) };
  } catch {
    return null;
  }
}

/** Hard-coded high-confidence 2025–2026 facts for common NG / tech queries */
function builtinFacts(query: string): SourceNote | null {
  const t = query.toLowerCase();
  if (/president.*nigeria|nigeria.*president/i.test(t)) {
    return {
      title: "Nigeria leadership",
      text: "As of 2025–2026, the President of the Federal Republic of Nigeria is Bola Ahmed Tinubu (APC). He assumed office on 29 May 2023, succeeding Muhammadu Buhari.",
    };
  }
  if (/governor.*delta|delta.*governor/i.test(t)) {
    return {
      title: "Delta State",
      text: "The Governor of Delta State is Sheriff Oborevwori. He has been in office since 2023 and later aligned with APC (defected from PDP in April 2025).",
    };
  }
  if (/governor.*bayelsa|bayelsa.*governor/i.test(t)) {
    return {
      title: "Bayelsa State",
      text: "The Governor of Bayelsa State is Douye Diri (PDP), in office since February 2020.",
    };
  }
  if (/iphone\s*1[67]|iphone\s*16/i.test(t)) {
    return {
      title: "iPhone lineup",
      text: "By 2025–2026 Apple’s recent flagship line includes iPhone 16 series; iPhone 17 is discussed as the next generation in the 2025 cycle depending on market. Pricing varies widely by country, storage, and retailer — check local Apple Store or major carriers for current Naira/USD prices.",
    };
  }
  return null;
}

async function gatherResearch(query: string): Promise<SourceNote[]> {
  const notes: SourceNote[] = [];
  const seen = new Set<string>();
  const add = (n: SourceNote | null) => {
    if (!n?.text) return;
    const key = n.text.slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    notes.push(n);
  };

  // Parallel fetch up to 4 sources
  const [b, w1, ddg, w2] = await Promise.all([
    Promise.resolve(builtinFacts(query)),
    wikiSummary(query),
    ddgInstant(query),
    wikiSecond(query),
  ]);
  add(b);
  add(w1);
  add(ddg);
  add(w2);
  return notes.slice(0, 4);
}

function stripLinks(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
      GET: async () => {
        try {
          const base = flaskChatUrl().replace(/\/api\/chat$/, "");
          const res = await fetch(`${base}/api/status`, {
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          });
          const json = await res.json().catch(() => ({}));
          return Response.json({ ok: res.ok, backend: json });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : "status failed" },
            { status: 502 },
          );
        }
      },
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            message?: string;
            query?: string;
            messages?: { role: string; content: string }[];
          };

          let message = String(body.message || body.query || "").trim();
          const prior = Array.isArray(body.messages) ? body.messages : [];
          if (!message && prior.length) {
            const lastUser = [...prior].reverse().find((m) => m.role === "user");
            message = String(lastUser?.content || "").trim();
          }
          if (!message) {
            return Response.json({ ok: false, error: "No message" }, { status: 400 });
          }

          // IMPORTANT: Flask has a canned identity reply when it sees "D4AI" / "who are you" in the prompt.
          // Send ONLY the plain user question (plus optional research facts). No wrapper, no "D4AI" keyword.
          let outbound = message;

          // Ask backend for richer answers (no identity keywords)
          if (message.length > 2 && !/^(hi|hello|hey|thanks|ok|xup)\b/i.test(message)) {
            outbound =
              message +
              "\n\n(Reply with clear detail: short intro, then explanation, and examples when useful. Stay on this question only.)";
          }

          // Short follow-up context only — no role labels that say D4AI
          // Only true follow-ups — NOT "why are you talking like this" etc.
          const followUp =
            /^(explain (them|it|this|that|more)|more details|continue|go on|tell me more|how so|and then|what about (him|her|them|it)|expand( on)?|give me \d+ examples)\b/i.test(
              message.trim(),
            );
          if (followUp && prior.length > 1) {
            const recent = prior.slice(-3);
            const lines: string[] = [];
            for (const m of recent) {
              const role = m.role === "assistant" ? "Assistant" : "User";
              const content = String(m.content || "")
                .replace(/https?:\/\/\S+/g, "")
                .replace(/\n*Thought for [\d.]+s\s*$/i, "")
                .trim()
                .slice(0, 220);
              if (content) lines.push(`${role}: ${content}`);
            }
            if (lines.length) {
              outbound =
                "Earlier in this chat:\n" +
                lines.join("\n") +
                "\n\nNow answer this follow-up directly:\n" +
                message;
            }
          }

          // Multi-source research only for fact queries — plain facts, no identity text
          if (needsWeb(message)) {
            const notes = await gatherResearch(message);
            if (notes.length) {
              outbound =
                message +
                "\n\nUse these current facts to answer (do not mention sources):\n" +
                notes.map((n, i) => `(${i + 1}) ${n.title}: ${n.text}`).join("\n");
            }
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
              body: JSON.stringify({ message: outbound }),
              signal: controller.signal,
              cache: "no-store",
            });
            const text = await res.text();
            let json: {
              answer?: string;
              response?: string;
              sources?: string[];
              error?: string;
            } = {};
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              return Response.json(
                { ok: false, error: `Backend non-JSON (${res.status})` },
                { status: 502 },
              );
            }
            if (!res.ok) {
              return Response.json(
                { ok: false, error: json.error || `Backend HTTP ${res.status}` },
                { status: 502 },
              );
            }
            let answer = String(json.answer || json.response || "").trim();
            if (!answer) {
              return Response.json({ ok: false, error: "Empty answer" }, { status: 502 });
            }
            answer = stripLinks(answer);
            // Never forward raw source URLs to the client
            return Response.json({ ok: true, answer, sources: [] });
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
    },
  },
});
