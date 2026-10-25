import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const OWNER_EMAILS = () =>
  (process.env.D4AI_OWNER_EMAILS || "amurundestiny@gmail.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function assertD4AiOwner(email: string | null | undefined) {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !OWNER_EMAILS().includes(e)) {
    throw new Error("Forbidden: only the D4AI owner can use GitHub tools.");
  }
}

export function resolveGithubToken(clientToken?: string | null): string | null {
  const t = (clientToken || process.env.D4AI_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  return t || null;
}

function b64Encode(text: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(text, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(text)));
}

function b64Decode(b64: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  return decodeURIComponent(escape(atob(b64)));
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

export const d4aiGithubTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ token: z.string().min(8).max(4000).optional() }).parse(data ?? {}),
  )
  .handler(async ({ data, context }) => {
    assertD4AiOwner((context as { userEmail?: string | null }).userEmail);
    const token = resolveGithubToken(data.token);
    if (!token) {
      return { ok: false as const, error: "No GitHub token. Paste a PAT or set D4AI_GITHUB_TOKEN on Vercel." };
    }
    const me = await gh("/user", token);
    if (!me.ok) return { ok: false as const, error: me.error };
    const u = me.json as { login?: string; name?: string };
    const repos = await gh("/user/repos?per_page=5&sort=updated", token);
    const repoNames =
      repos.ok && Array.isArray(repos.json)
        ? (repos.json as { full_name: string }[]).map((r) => r.full_name)
        : [];
    return {
      ok: true as const,
      login: u.login || "",
      name: u.name || "",
      sampleRepos: repoNames,
    };
  });

export async function runGithubTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case "github_list_repos": {
        const q = args.query ? String(args.query) : "";
        const res = await gh("/user/repos?per_page=30&sort=updated&affiliation=owner,collaborator", token);
        if (!res.ok) return `Error: ${res.error}`;
        let list = res.json as { full_name: string; description: string | null; private: boolean }[];
        if (q) {
          const ql = q.toLowerCase();
          list = list.filter((r) => r.full_name.toLowerCase().includes(ql));
        }
        return JSON.stringify(
          list.slice(0, 20).map((r) => ({
            repo: r.full_name,
            private: r.private,
            description: r.description,
          })),
        );
      }
      case "github_get_file": {
        const owner = String(args.owner || "");
        const repo = String(args.repo || "");
        const path = String(args.path || "");
        const ref = args.ref ? String(args.ref) : undefined;
        if (!owner || !repo || !path) return "Error: owner, repo, path required";
        const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
        const res = await gh(
          `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${qs}`,
          token,
        );
        if (!res.ok) return `Error: ${res.error}`;
        const f = res.json as { content?: string; encoding?: string; sha?: string; size?: number };
        if (f.encoding === "base64" && f.content) {
          const text = b64Decode(f.content.replace(/\n/g, ""));
          return JSON.stringify({
            path,
            sha: f.sha,
            size: f.size,
            content: text.slice(0, 80_000),
          });
        }
        return JSON.stringify(f);
      }
      case "github_list_files": {
        const owner = String(args.owner || "");
        const repo = String(args.repo || "");
        const path = String(args.path || "");
        const ref = args.ref ? String(args.ref) : undefined;
        if (!owner || !repo) return "Error: owner, repo required";
        const p = path ? path.split("/").map(encodeURIComponent).join("/") : "";
        const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
        const res = await gh(`/repos/${owner}/${repo}/contents/${p}${qs}`, token);
        if (!res.ok) return `Error: ${res.error}`;
        const data = res.json;
        if (Array.isArray(data)) {
          return JSON.stringify(
            (data as { name: string; path: string; type: string }[]).map((x) => ({
              name: x.name,
              path: x.path,
              type: x.type,
            })),
          );
        }
        return JSON.stringify(data);
      }
      case "github_update_file": {
        const owner = String(args.owner || "");
        const repo = String(args.repo || "");
        const path = String(args.path || "");
        const content = String(args.content ?? "");
        const message = String(args.message || `D4AI: update ${path}`);
        const branch = args.branch ? String(args.branch) : undefined;
        if (!owner || !repo || !path) return "Error: owner, repo, path required";

        let sha: string | undefined;
        const existing = await gh(
          `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${
            branch ? `?ref=${encodeURIComponent(branch)}` : ""
          }`,
          token,
        );
        if (existing.ok) {
          sha = (existing.json as { sha?: string }).sha;
        }

        const body: Record<string, unknown> = {
          message,
          content: b64Encode(content),
        };
        if (sha) body.sha = sha;
        if (branch) body.branch = branch;

        const res = await gh(
          `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
          token,
          { method: "PUT", body: JSON.stringify(body) },
        );
        if (!res.ok) return `Error: ${res.error}`;
        const out = res.json as { content?: { path?: string }; commit?: { html_url?: string } };
        return JSON.stringify({
          ok: true,
          path: out.content?.path,
          commit_url: out.commit?.html_url,
        });
      }
      case "github_create_branch": {
        const owner = String(args.owner || "");
        const repo = String(args.repo || "");
        const branch = String(args.branch || "");
        const from = String(args.from || "main");
        if (!owner || !repo || !branch) return "Error: owner, repo, branch required";
        let base = await gh(`/repos/${owner}/${repo}/git/ref/heads/${from}`, token);
        let fromName = from;
        if (!base.ok) {
          base = await gh(`/repos/${owner}/${repo}/git/ref/heads/master`, token);
          fromName = "master";
          if (!base.ok) return `Error: cannot find base branch: ${base.error}`;
        }
        const sha = (base.json as { object: { sha: string } }).object.sha;
        const created = await gh(`/repos/${owner}/${repo}/git/refs`, token, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
        });
        if (!created.ok) return `Error: ${created.error}`;
        return JSON.stringify({ ok: true, branch, from: fromName });
      }
      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "tool failed"}`;
  }
}

export const GITHUB_TOOLS_OLLAMA = [
  {
    type: "function",
    function: {
      name: "github_list_repos",
      description: "List the owner's GitHub repositories (optionally filter by name).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional name filter e.g. d4exam" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_list_files",
      description: "List files/folders in a repo path.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string", description: "Directory path, empty for root" },
          ref: { type: "string", description: "Branch name optional" },
        },
        required: ["owner", "repo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_get_file",
      description: "Read a text file from a GitHub repository.",
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
      name: "github_create_branch",
      description: "Create a new branch from main/master.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          branch: { type: "string" },
          from: { type: "string", description: "Base branch, default main" },
        },
        required: ["owner", "repo", "branch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_update_file",
      description:
        "Create or update a file in the repo. Prefer a feature branch when changing production code.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          content: { type: "string", description: "Full new file contents" },
          message: { type: "string", description: "Commit message" },
          branch: { type: "string", description: "Branch to commit to" },
        },
        required: ["owner", "repo", "path", "content"],
      },
    },
  },
];
