import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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

async function assertOwner(
  email: string | null | undefined,
  supabase?: { rpc: (name: string) => Promise<{ data: unknown }> },
) {
  if (isOwnerEmail(email)) return;
  try {
    if (supabase) {
      const { data } = await supabase.rpc("is_super_admin");
      if (data === true) return;
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    "Forbidden: GitHub tools are owner-only. Sign in with amurundestiny@gmail.com or amurunoghenetejiri@gmail.com.",
  );
}

async function gh(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<{ ok: true; json: unknown; status: number } | { ok: false; error: string; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const msg =
      typeof json === "object" && json && "message" in json
        ? String((json as { message: string }).message)
        : text.slice(0, 300);
    return { ok: false, error: msg, status: res.status };
  }
  return { ok: true, json, status: res.status };
}

export const d4aiGithubVerify = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ token: z.string().min(8).max(400) }).parse(data),
  )
  .handler(async ({ data }) => {
    // Any signed-in user can connect THEIR own GitHub PAT
    const r = await gh("/user", data.token);
    if (!r.ok) return { ok: false as const, error: r.error };
    const u = r.json as { login?: string; name?: string };
    return { ok: true as const, login: u.login || "", name: u.name || "" };
  });

function b64encode(text: string) {
  return Buffer.from(text, "utf8").toString("base64");
}
function b64decode(b64: string) {
  return Buffer.from(b64.replace(/\n/g, ""), "base64").toString("utf8");
}

export async function runGithubTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "github_list_repos": {
      const r = await gh("/user/repos?per_page=30&sort=updated", token);
      if (!r.ok) return `Error: ${r.error}`;
      const repos = r.json as { full_name: string; private: boolean; description: string | null }[];
      return repos
        .map(
          (x) =>
            `- ${x.full_name}${x.private ? " (private)" : ""}${x.description ? `: ${x.description}` : ""}`,
        )
        .join("\n");
    }
    case "github_get_file": {
      const owner = String(args.owner || "");
      const repo = String(args.repo || "");
      const path = String(args.path || "");
      const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
      const r = await gh(`/repos/${owner}/${repo}/contents/${path}${ref}`, token);
      if (!r.ok) return `Error: ${r.error}`;
      const f = r.json as { content?: string; encoding?: string; sha?: string };
      if (f.encoding === "base64" && f.content) {
        const text = b64decode(f.content);
        return text.length > 60000 ? text.slice(0, 60000) + "\n…[truncated]" : text;
      }
      return JSON.stringify(f).slice(0, 8000);
    }
    case "github_put_file": {
      const owner = String(args.owner || "");
      const repo = String(args.repo || "");
      const path = String(args.path || "");
      const content = String(args.content || "");
      const message = String(args.message || "Update via D4AI");
      const branch = args.branch ? String(args.branch) : undefined;
      const existing = await gh(
        `/repos/${owner}/${repo}/contents/${path}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`,
        token,
      );
      let sha: string | undefined;
      if (existing.ok) sha = (existing.json as { sha?: string }).sha;
      const body: Record<string, unknown> = {
        message,
        content: b64encode(content),
      };
      if (sha) body.sha = sha;
      if (branch) body.branch = branch;
      const r = await gh(`/repos/${owner}/${repo}/contents/${path}`, token, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (!r.ok) return `Error: ${r.error}`;
      const out = r.json as {
        content?: { html_url?: string; path?: string };
        commit?: { html_url?: string };
      };
      return `OK: updated ${out.content?.path || path}. ${out.commit?.html_url || out.content?.html_url || ""}`;
    }
    case "github_list_issues": {
      const owner = String(args.owner || "");
      const repo = String(args.repo || "");
      const r = await gh(`/repos/${owner}/${repo}/issues?state=open&per_page=15`, token);
      if (!r.ok) return `Error: ${r.error}`;
      const issues = r.json as { number: number; title: string; user?: { login: string } }[];
      return (
        issues.map((i) => `#${i.number} ${i.title} (@${i.user?.login || "?"})`).join("\n") ||
        "No open issues."
      );
    }
    case "github_create_issue": {
      const owner = String(args.owner || "");
      const repo = String(args.repo || "");
      const title = String(args.title || "");
      const body = String(args.body || "");
      const r = await gh(`/repos/${owner}/${repo}/issues`, token, {
        method: "POST",
        body: JSON.stringify({ title, body }),
      });
      if (!r.ok) return `Error: ${r.error}`;
      const issue = r.json as { html_url?: string; number?: number };
      return `Created issue #${issue.number}: ${issue.html_url}`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

export const GITHUB_TOOLS_FOR_OLLAMA = [
  {
    type: "function",
    function: {
      name: "github_list_repos",
      description: "List the authenticated user's GitHub repositories",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "github_get_file",
      description: "Read a file from a GitHub repository",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" },
        },
        required: ["owner", "repo", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_put_file",
      description: "Create or update a file in a GitHub repository (commit)",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          content: { type: "string" },
          message: { type: "string" },
          branch: { type: "string" },
        },
        required: ["owner", "repo", "path", "content", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_list_issues",
      description: "List open issues on a repo",
      parameters: {
        type: "object",
        properties: { owner: { type: "string" }, repo: { type: "string" } },
        required: ["owner", "repo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_create_issue",
      description: "Create a GitHub issue",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["owner", "repo", "title"],
      },
    },
  },
];
