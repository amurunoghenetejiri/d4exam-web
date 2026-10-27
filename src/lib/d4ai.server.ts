import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  GITHUB_TOOLS_FOR_OLLAMA,
  runGithubTool,
} from "@/lib/d4ai-github.server";

const OWNER_EMAILS = () =>
  (process.env.D4AI_OWNER_EMAILS || "amurundestiny@gmail.com,amurunoghenetejiri@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function isOwnerEmail(email: string | null | undefined) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  if (OWNER_EMAILS().includes(e)) return true;
  if (e.startsWith("amurun") && e.endsWith("@gmail.com")) return true;
  return false;
}

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().max(48000),
  tool_calls: z.array(z.unknown()).optional(),
  tool_name: z.string().optional(),
});

const chatInputSchema = z.object({
  messages: z.array(messageSchema).min(1).max(32),
  images: z.array(z.string().max(8_000_000)).max(3).optional(),
  documentText: z.string().max(60_000).optional(),
  documentName: z.string().max(200).optional(),
  githubToken: z.string().min(8).max(400).optional(),
  enableGithubTools: z.boolean().optional(),
});

function baseUrl() {
  return (process.env.D4AI_BASE_URL || "http://147.224.179.220:11434").replace(/\/$/, "");
}

function textModel() {
  return process.env.D4AI_MODEL || "d4ai";
}

function visionModel() {
  return process.env.D4AI_VISION_MODEL || "d4ai-vision";
}

async function ollamaChat(body: Record<string, unknown>) {
  const url = `${baseUrl()}/api/chat`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`D4AI server error (${res.status}). ${t.slice(0, 200) || "Try again."}`);
    }
    return (await res.json()) as {
      message?: {
        role?: string;
        content?: string;
        tool_calls?: {
          function?: { name?: string; arguments?: string | Record<string, unknown> };
        }[];
      };
      response?: string;
      error?: string;
    };
  } finally {
    clearTimeout(timer);
  }
}

export const d4aiChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => chatInputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const userEmail = (context as { userEmail?: string | null }).userEmail;
    const owner = isOwnerEmail(userEmail);
    // Any signed-in user who connected their own GitHub PAT can use tools
    const useGh =
      Boolean(data.enableGithubTools) && Boolean(data.githubToken?.trim());

    const hasImages = Boolean(data.images?.length);
    const hasDoc = Boolean(data.documentText?.trim());
    const model = hasImages && !hasDoc ? visionModel() : textModel();

    const messages = data.messages.map((m) => ({ ...m }));
    if (data.documentText?.trim()) {
      const name = data.documentName || "document";
      const last = messages[messages.length - 1];
      if (last?.role === "user") {
        last.content = `${last.content}\n\n---\nContent from "${name}":\n${data.documentText.slice(0, 20000)}`;
      }
    }

    messages.unshift({
      role: "system",
      content:
        "You are D4AI by D4TECH. Answer clearly with structure: short paragraphs, bullets when helpful, markdown bold for key terms. Explain in useful detail. Be friendly. Match the user's language. Prefer real symbols (² √ ≤ →)." +
        (useGh
          ? " The user is the platform owner with GitHub connected. USE GitHub tools when they ask about repos, files, commits, or issues. Default repo: amurunoghenetejiri/d4exam-web. Prefer tool calls over saying you cannot access GitHub."
          : ""),
    });

    const trimmed = data.documentText?.trim()
      ? messages.slice(-4)
      : messages.slice(-8);

    const buildOllamaMessages = (msgs: typeof trimmed) =>
      msgs.map((m, i) => {
        if (hasImages && !hasDoc && m.role === "user" && i === msgs.length - 1) {
          return {
            role: m.role,
            content: m.content,
            images: data.images!.map((img) =>
              img.replace(/^data:image\/[^;]+;base64,/, ""),
            ),
          };
        }
        return { role: m.role, content: m.content };
      });

    try {
      let ollamaMessages: Record<string, unknown>[] = buildOllamaMessages(trimmed);
      let finalContent = "";
      let rounds = 0;
      const maxRounds = useGh ? 4 : 1;

      while (rounds < maxRounds) {
        rounds++;
        const body: Record<string, unknown> = {
          model,
          messages: ollamaMessages,
          stream: false,
          options: {
            num_predict: useGh ? 900 : data.documentText?.trim() ? 800 : 900,
            temperature: 0.5,
            top_p: 0.9,
            num_ctx: 4096,
          },
        };
        if (useGh && !hasImages) {
          body.tools = GITHUB_TOOLS_FOR_OLLAMA;
        }

        const json = await ollamaChat(body);
        const msg = json.message;
        const toolCalls = msg?.tool_calls || [];

        if (useGh && toolCalls.length > 0) {
          ollamaMessages = [
            ...ollamaMessages,
            {
              role: "assistant",
              content: msg?.content || "",
              tool_calls: toolCalls,
            },
          ];
          for (const tc of toolCalls) {
            const fn = tc.function?.name || "";
            let args: Record<string, unknown> = {};
            const rawArgs = tc.function?.arguments;
            if (typeof rawArgs === "string") {
              try {
                args = JSON.parse(rawArgs) as Record<string, unknown>;
              } catch {
                args = {};
              }
            } else if (rawArgs && typeof rawArgs === "object") {
              args = rawArgs as Record<string, unknown>;
            }
            const result = await runGithubTool(data.githubToken!, fn, args);
            ollamaMessages.push({
              role: "tool",
              content: result,
            });
          }
          continue;
        }

        finalContent = msg?.content?.trim() || json.response?.trim() || "";
        break;
      }

      if (!finalContent) {
        throw new Error("Empty reply from D4AI.");
      }

      return {
        ok: true as const,
        content: finalContent,
        model,
        usedGithub: useGh,
      };
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === "AbortError"
            ? "D4AI took too long. Try a shorter question or a smaller PDF (first pages only)."
            : e.message
          : "Could not reach D4AI.";
      return { ok: false as const, error: msg };
    }
  });
