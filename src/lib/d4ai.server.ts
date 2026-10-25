import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  assertD4AiOwner,
  resolveGithubToken,
  runGithubTool,
  GITHUB_TOOLS_OLLAMA,
} from "@/lib/d4ai-github.server";

const messageSchemaFixed = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().max(48000),
});

const chatInputSchema = z.object({
  messages: z.array(messageSchemaFixed).min(1).max(24),
  images: z.array(z.string().max(8_000_000)).max(3).optional(),
  documentText: z.string().max(60_000).optional(),
  documentName: z.string().max(200).optional(),
  githubToken: z.string().max(4000).optional(),
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

type OllamaMsg = {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: {
    function: { name: string; arguments: Record<string, unknown> | string };
  }[];
};

async function ollamaChat(body: Record<string, unknown>) {
  const url = `${baseUrl()}/api/chat`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
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
      message?: OllamaMsg;
      response?: string;
      error?: string;
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseToolArgs(args: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return args || {};
}

/** Proxy chat to Oracle Ollama; owner may use GitHub tools. */
export const d4aiChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => chatInputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const userEmail = (context as { userEmail?: string | null }).userEmail;
    const hasImages = Boolean(data.images?.length);
    const hasDoc = Boolean(data.documentText?.trim());
    const model = hasImages && !hasDoc ? visionModel() : textModel();

    let isOwner = false;
    try {
      assertD4AiOwner(userEmail);
      isOwner = true;
    } catch {
      isOwner = false;
    }

    const ghToken =
      isOwner && data.enableGithubTools ? resolveGithubToken(data.githubToken) : null;
    const useGithub = Boolean(ghToken);

    const messages: OllamaMsg[] = data.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    if (data.documentText?.trim()) {
      const name = data.documentName || "document";
      const last = messages[messages.length - 1];
      if (last?.role === "user") {
        last.content = `${last.content}\n\n---\nContent from "${name}":\n${data.documentText.slice(0, 50000)}`;
      }
    }

    if (useGithub) {
      messages.unshift({
        role: "system",
        content:
          "You are D4AI by Amurun Destiny (D4TECH). The user is the platform owner with GitHub tools enabled. " +
          "When they ask to inspect or change GitHub repos (especially d4exam-web / d4exam-apk), USE the provided tools. " +
          "For d4exam-web use owner=amurunoghenetejiri repo=d4exam-web unless they specify otherwise. " +
          "Prefer creating a branch before risky edits. After tools run, summarize clearly what you did. " +
          "Speak pidgin when the user does.",
      });
    }

    const trimmed = messages.slice(-10);

    if (hasImages && !hasDoc) {
      const lastUserIdx = [...trimmed].reverse().findIndex((m) => m.role === "user");
      if (lastUserIdx >= 0) {
        const idx = trimmed.length - 1 - lastUserIdx;
        trimmed[idx] = {
          ...trimmed[idx],
          images: data.images!.map((img) => img.replace(/^data:image\/[^;]+;base64,/, "")),
        };
      }
    }

    try {
      let ollamaMessages = [...trimmed];
      let finalContent = "";
      const toolsUsed: string[] = [];

      for (let round = 0; round < 4; round++) {
        const body: Record<string, unknown> = {
          model,
          messages: ollamaMessages,
          stream: false,
          options: {
            num_predict: useGithub ? 800 : 512,
            temperature: 0.5,
            num_ctx: useGithub ? 8192 : 4096,
          },
        };
        if (useGithub && !hasImages) {
          body.tools = GITHUB_TOOLS_OLLAMA;
        }

        const json = await ollamaChat(body);
        const msg = json.message;
        const content = msg?.content?.trim() || json.response?.trim() || "";
        const toolCalls = msg?.tool_calls;

        if (toolCalls?.length && ghToken) {
          ollamaMessages.push({
            role: "assistant",
            content: content || "",
            tool_calls: toolCalls,
          });
          for (const tc of toolCalls) {
            const fname = tc.function?.name || "";
            const args = parseToolArgs(tc.function?.arguments);
            toolsUsed.push(fname);
            const result = await runGithubTool(ghToken, fname, args);
            ollamaMessages.push({
              role: "tool",
              content: result,
            } as OllamaMsg);
          }
          continue;
        }

        finalContent = content;
        break;
      }

      if (!finalContent) {
        const lastUser = [...data.messages].reverse().find((m) => m.role === "user");
        const q = (lastUser?.content || "").toLowerCase();
        if (ghToken && /github|repo|d4exam/.test(q)) {
          const listed = await runGithubTool(ghToken, "github_list_repos", {
            query: "d4exam",
          });
          finalContent =
            `I checked your GitHub (tools: ${toolsUsed.join(", ") || "list"}).\n\n` +
            `Repos matching d4exam:\n${listed}\n\n` +
            `Tell me exactly what file to change and what you want done — I can create a branch and commit.`;
        } else {
          throw new Error("Empty reply from D4AI.");
        }
      }

      return {
        ok: true as const,
        content: finalContent,
        model,
        toolsUsed,
        githubEnabled: useGithub,
      };
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === "AbortError"
            ? "D4AI took too long. Try a shorter question."
            : e.message
          : "Could not reach D4AI.";
      return { ok: false as const, error: msg };
    }
  });
