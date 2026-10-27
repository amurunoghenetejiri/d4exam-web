/**
 * Streaming D4AI chat — pipes Ollama tokens to the client immediately.
 * POST /api/d4ai/stream
 */
import { createFileRoute } from "@tanstack/react-router";

function baseUrl() {
  return (process.env.D4AI_BASE_URL || "http://147.224.179.220:11434").replace(/\/$/, "");
}
function textModel() {
  return process.env.D4AI_MODEL || "d4ai";
}
function visionModel() {
  return process.env.D4AI_VISION_MODEL || "d4ai-vision";
}

type Msg = { role: string; content: string };

export const Route = createFileRoute("/api/d4ai/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            messages?: Msg[];
            images?: string[];
            documentText?: string;
            documentName?: string;
          };

          const messages = Array.isArray(body.messages) ? body.messages.slice(-16) : [];
          if (!messages.length) {
            return Response.json({ error: "No messages" }, { status: 400 });
          }

          const hasImages = Boolean(body.images?.length);
          const hasDoc = Boolean(body.documentText?.trim());
          // Fast text model for chat; vision only for raw images
          const model = hasImages && !hasDoc ? visionModel() : textModel();
          const numPredict = model === visionModel() ? 2048 : 1024;

          const msgs: Msg[] = messages.map((m) => ({
            role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
            content: String(m.content || "").slice(0, 48000),
          }));

          if (hasDoc) {
            const last = msgs[msgs.length - 1];
            if (last?.role === "user") {
              last.content += `\n\n---\nContent from "${body.documentName || "document"}":\n${String(body.documentText).slice(0, 16000)}`;
            }
          }

          msgs.unshift({
            role: "system",
            content:
              "You are D4AI by D4TECH — a friendly, helpful study and life companion. " +
              "Reply clearly with short paragraphs or bullets. Match the user's language (including Nigerian Pidgin when they use it). " +
              "Never start with 'Error', 'fetch failed', or raw system messages. " +
              "Vary your openings naturally (not always the same phrase). For greetings, be warm and brief. " +
              "If live research notes are attached, use those facts and answer in your own words — do not dump the notes. " +
              "For math: first state the final answer boldly, then give clear step-by-step solution. " +
              "Be detailed when helpful, but not bloated.",
          });

          const ollamaMessages = msgs.map((m, i) => {
            if (hasImages && !hasDoc && m.role === "user" && i === msgs.length - 1) {
              return {
                role: m.role,
                content: m.content,
                images: (body.images || []).map((img) =>
                  img.replace(/^data:image\/[^;]+;base64,/, ""),
                ),
              };
            }
            return { role: m.role, content: m.content };
          });

          const ollamaRes = await fetch(`${baseUrl()}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              messages: ollamaMessages,
              stream: true,
              options: {
                num_predict: numPredict,
                temperature: 0.5,
                top_p: 0.9,
                num_ctx: 4096,
              },
            }),
          });

          if (!ollamaRes.ok || !ollamaRes.body) {
            const t = await ollamaRes.text().catch(() => "");
            return Response.json(
              { error: `D4AI server error (${ollamaRes.status}). ${t.slice(0, 200)}` },
              { status: 502 },
            );
          }

          const reader = ollamaRes.body.getReader();
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();

          const stream = new ReadableStream({
            async start(controller) {
              let buffer = "";
              try {
                controller.enqueue(
                  encoder.encode(JSON.stringify({ type: "meta", model }) + "\n"),
                );
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";
                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                      const json = JSON.parse(trimmed) as {
                        message?: { content?: string };
                        response?: string;
                        done?: boolean;
                      };
                      const token = json.message?.content ?? json.response ?? "";
                      if (token) {
                        controller.enqueue(
                          encoder.encode(JSON.stringify({ type: "token", content: token }) + "\n"),
                        );
                      }
                      if (json.done) {
                        controller.enqueue(
                          encoder.encode(JSON.stringify({ type: "done" }) + "\n"),
                        );
                      }
                    } catch {
                      /* skip */
                    }
                  }
                }
                if (buffer.trim()) {
                  try {
                    const json = JSON.parse(buffer.trim()) as {
                      message?: { content?: string };
                      response?: string;
                    };
                    const token = json.message?.content ?? json.response ?? "";
                    if (token) {
                      controller.enqueue(
                        encoder.encode(JSON.stringify({ type: "token", content: token }) + "\n"),
                      );
                    }
                  } catch {
                    /* ignore */
                  }
                }
                controller.enqueue(encoder.encode(JSON.stringify({ type: "done" }) + "\n"));
                controller.close();
              } catch (e) {
                const msg = e instanceof Error ? e.message : "stream failed";
                try {
                  controller.enqueue(
                    encoder.encode(JSON.stringify({ type: "error", error: msg }) + "\n"),
                  );
                  controller.close();
                } catch {
                  controller.error(e);
                }
              }
            },
            cancel() {
              try {
                void reader.cancel();
              } catch {
                /* ignore */
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Failed to reach D4AI";
          return Response.json({ error: msg }, { status: 500 });
        }
      },
    },
  },
});
