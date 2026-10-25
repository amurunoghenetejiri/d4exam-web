import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(32000),
});

const chatInputSchema = z.object({
  messages: z.array(messageSchema).min(1).max(40),
  images: z.array(z.string().max(6_000_000)).max(4).optional(),
  documentText: z.string().max(50_000).optional(),
  documentName: z.string().max(200).optional(),
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

/** Proxy chat to Oracle Ollama (D4AI / D4AI-vision). */
export const d4aiChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => chatInputSchema.parse(data))
  .handler(async ({ data }) => {
    const hasImages = Boolean(data.images?.length);
    const model = hasImages ? visionModel() : textModel();

    const messages = data.messages.map((m) => ({ ...m }));
    if (data.documentText?.trim()) {
      const name = data.documentName || "document";
      const last = messages[messages.length - 1];
      if (last?.role === "user") {
        last.content =
          `${last.content}\n\n---\nAttached document (${name}):\n${data.documentText.slice(0, 40000)}`;
      }
    }

    // Ollama vision: attach images on the last user message
    const ollamaMessages = messages.map((m, i) => {
      if (
        hasImages &&
        m.role === "user" &&
        i === messages.length - 1
      ) {
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

    const url = `${baseUrl()}/api/chat`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: ollamaMessages,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(
          `D4AI server error (${res.status}). ${t.slice(0, 200) || "Try again."}`,
        );
      }

      const json = (await res.json()) as {
        message?: { content?: string };
        response?: string;
        error?: string;
      };

      const content =
        json.message?.content?.trim() ||
        json.response?.trim() ||
        "";

      if (!content) {
        throw new Error(json.error || "Empty reply from D4AI.");
      }

      return {
        ok: true as const,
        content,
        model,
      };
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === "AbortError"
            ? "D4AI took too long. Try a shorter question."
            : e.message
          : "Could not reach D4AI.";
      return { ok: false as const, error: msg };
    } finally {
      clearTimeout(timer);
    }
  });
