import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const OWNER_EMAILS = () =>
  (process.env.D4AI_OWNER_EMAILS || "amurundestiny@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function assertOwner(email: string | null | undefined) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !OWNER_EMAILS().includes(e)) {
    throw new Error("Forbidden: only the D4AI owner can manage MCP servers.");
  }
}

const serverConfigSchema = z.object({
  url: z.string().url().max(2000),
  name: z.string().min(1).max(120).optional(),
  authToken: z.string().max(4000).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

async function mcpPost(
  url: string,
  body: JsonRpc,
  authToken?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: true; data: JsonRpc; raw: string } | { ok: false; error: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(extraHeaders || {}),
  };
  if (authToken?.trim()) {
    headers.Authorization = authToken.startsWith("Bearer ")
      ? authToken.trim()
      : `Bearer ${authToken.trim()}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `MCP HTTP ${res.status}: ${raw.slice(0, 300) || res.statusText}`,
      };
    }
    let jsonText = raw.trim();
    if (jsonText.includes("data:")) {
      const lines = jsonText.split("\n").filter((l) => l.startsWith("data:"));
      const last = lines[lines.length - 1]?.replace(/^data:\s*/, "") || "";
      jsonText = last || jsonText;
    }
    try {
      const data = JSON.parse(jsonText) as JsonRpc;
      if (data.error) {
        return {
          ok: false,
          error: data.error.message || JSON.stringify(data.error),
        };
      }
      return { ok: true, data, raw };
    } catch {
      return {
        ok: false,
        error: `Invalid MCP response: ${raw.slice(0, 200)}`,
      };
    }
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.name === "AbortError"
          ? "MCP server timed out"
          : e.message
        : "MCP request failed";
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Test MCP HTTP endpoint: initialize + tools/list */
export const d4aiMcpTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => serverConfigSchema.parse(data))
  .handler(async ({ data, context }) => {
    assertOwner((context as { userEmail?: string | null }).userEmail);

    const init = await mcpPost(
      data.url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "d4exam-d4ai", version: "1.0.0" },
        },
      },
      data.authToken,
      data.headers,
    );
    if (!init.ok) {
      return { ok: false as const, error: init.error, tools: [] as { name: string; description?: string }[] };
    }

    await mcpPost(
      data.url,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      data.authToken,
      data.headers,
    ).catch(() => undefined);

    const listed = await mcpPost(
      data.url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      data.authToken,
      data.headers,
    );

    if (!listed.ok) {
      return {
        ok: true as const,
        warning: listed.error,
        serverInfo: (init.data.result as { serverInfo?: unknown })?.serverInfo ?? null,
        tools: [] as { name: string; description?: string }[],
      };
    }

    const result = listed.data.result as {
      tools?: { name: string; description?: string }[];
    };
    const tools = (result?.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
    }));

    return {
      ok: true as const,
      serverInfo: (init.data.result as { serverInfo?: unknown })?.serverInfo ?? null,
      tools,
    };
  });

/** Call one MCP tool (owner only) */
export const d4aiMcpCallTool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        url: z.string().url().max(2000),
        authToken: z.string().max(4000).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        toolName: z.string().min(1).max(200),
        arguments: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    assertOwner((context as { userEmail?: string | null }).userEmail);

    await mcpPost(
      data.url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "d4exam-d4ai", version: "1.0.0" },
        },
      },
      data.authToken,
      data.headers,
    );

    const called = await mcpPost(
      data.url,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: data.toolName,
          arguments: data.arguments || {},
        },
      },
      data.authToken,
      data.headers,
    );

    if (!called.ok) {
      return { ok: false as const, error: called.error };
    }
    return { ok: true as const, result: called.data.result };
  });
