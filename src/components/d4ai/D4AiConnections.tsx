import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Github,
  Database,
  Heart,
  Mail,
  Link2,
  Loader2,
  Lock,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionUser } from "@/lib/session";
import { d4aiMcpTest } from "@/lib/d4ai-mcp.server";
import { d4aiGithubVerify } from "@/lib/d4ai-github.server";

export function isD4AiOwner(session: SessionUser | null | undefined): boolean {
  if (!session) return false;
  const email = String(session.email || "").trim().toLowerCase();
  const name = String(session.fullName || "").trim().toLowerCase();
  const ownerEmails = (
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: Record<string, string> }).env?.VITE_D4AI_OWNER_EMAILS) ||
    "amurundestiny@gmail.com,amurunoghenetejiri@gmail.com"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (ownerEmails.includes(email)) return true;
  if (email.startsWith("amurun") && email.endsWith("@gmail.com")) return true;
  if (session.roles?.includes("super_admin") && email.includes("amurun")) return true;
  if (
    name.includes("amurun") &&
    (name.includes("destiny") || name.includes("oghenetejiri"))
  ) {
    return true;
  }
  return false;
}

export type McpServerConfig = {
  id: string;
  name: string;
  url: string;
  authToken?: string;
  enabled: boolean;
  lastTestOk?: boolean;
  lastTestAt?: number;
  lastError?: string;
  tools?: { name: string; description?: string }[];
};

const MCP_KEY = "d4ai_mcp_servers_v1";
const APPS_KEY = "d4ai_owner_connectors_v1";
export const GH_TOKEN_KEY = "d4ai_github_pat_v1";
export const GH_LOGIN_KEY = "d4ai_github_login_v1";

export function readGithubToken(): string | null {
  try {
    return localStorage.getItem(GH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function readGithubLogin(): string | null {
  try {
    return localStorage.getItem(GH_LOGIN_KEY);
  } catch {
    return null;
  }
}

function loadMcp(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem(MCP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as McpServerConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMcp(list: McpServerConfig[]) {
  try {
    localStorage.setItem(MCP_KEY, JSON.stringify(list.slice(0, 40)));
  } catch {}
}

type AppId = "github" | "lovable" | "supabase";

const APP_CATALOG: {
  id: AppId;
  title: string;
  description: string;
  icon: typeof Github | typeof Heart | typeof Database | typeof Mail;
}[] = [
  {
    id: "github",
    title: "GitHub",
    description: "Live access: list repos, read/write files, issues (PAT required).",
    icon: Github,
  },
  {
    id: "lovable",
    title: "Lovable",
    description: "Add Lovable HTTP MCP under MCP servers when you have a URL.",
    icon: Heart,
  },
  {
    id: "supabase",
    title: "Supabase",
    description: "Connect a project URL + key via MCP, or use D4EXAM built-in data.",
    icon: Database,
  },
];

function loadApps(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(APPS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as Record<string, { connected?: boolean }>;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(p)) out[k] = Boolean(v?.connected);
    return out;
  } catch {
    return {};
  }
}

function saveApps(map: Record<string, boolean>) {
  try {
    const packed: Record<string, { id: string; connected: boolean }> = {};
    for (const [k, v] of Object.entries(map)) packed[k] = { id: k, connected: v };
    localStorage.setItem(APPS_KEY, JSON.stringify(packed));
  } catch {}
}

export function D4AiConnectionsSheet({
  open,
  onClose,
  session,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionUser | null;
}) {
  const owner = true; // MCP + connectors available to every signed-in user
  const [tab, setTab] = useState<"apps" | "mcp">("apps");
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [apps, setApps] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [ghOpen, setGhOpen] = useState(false);
  const [ghToken, setGhToken] = useState("");
  const [ghLogin, setGhLogin] = useState<string | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setServers(loadMcp());
    setApps(loadApps());
    setGhLogin(readGithubLogin());
    if (readGithubToken()) {
      setApps((a) => {
        const next = { ...a, github: true };
        saveApps(next);
        return next;
      });
    }
  }, [open]);

  const persistServers = useCallback((list: McpServerConfig[]) => {
    setServers(list);
    saveMcp(list);
  }, []);

  const connectGithub = async () => {
    setGhError(null);
    const t = ghToken.trim();
    if (t.length < 8) {
      setGhError("Paste a GitHub personal access token.");
      return;
    }
    setGhBusy(true);
    try {
      const res = await d4aiGithubVerify({ data: { token: t } });
      if (!res.ok) {
        setGhError(res.error);
        return;
      }
      localStorage.setItem(GH_TOKEN_KEY, t);
      localStorage.setItem(GH_LOGIN_KEY, res.login || "");
      setGhLogin(res.login || null);
      const next = { ...apps, github: true };
      setApps(next);
      saveApps(next);
      setGhToken("");
      setGhOpen(false);
    } catch (e) {
      setGhError(e instanceof Error ? e.message : "Verify failed");
    } finally {
      setGhBusy(false);
    }
  };

  const disconnectGithub = () => {
    localStorage.removeItem(GH_TOKEN_KEY);
    localStorage.removeItem(GH_LOGIN_KEY);
    setGhLogin(null);
    const next = { ...apps, github: false };
    setApps(next);
    saveApps(next);
  };

  const testServer = async (cfg: McpServerConfig) => {
    setBusyId(cfg.id);
    try {
      const res = await d4aiMcpTest({
        data: { url: cfg.url, name: cfg.name, authToken: cfg.authToken || undefined },
      });
      persistServers(
        servers.map((s) => {
          if (s.id !== cfg.id) return s;
          if (!res.ok) {
            return { ...s, lastTestOk: false, lastTestAt: Date.now(), lastError: res.error, tools: [] };
          }
          return {
            ...s,
            lastTestOk: true,
            lastTestAt: Date.now(),
            lastError: "warning" in res ? String(res.warning) : undefined,
            tools: res.tools || [],
          };
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Test failed";
      persistServers(
        servers.map((s) =>
          s.id === cfg.id ? { ...s, lastTestOk: false, lastTestAt: Date.now(), lastError: msg } : s,
        ),
      );
    } finally {
      setBusyId(null);
    }
  };

  const addServer = async () => {
    setFormError(null);
    const n = name.trim() || "MCP server";
    const u = url.trim();
    if (!u.startsWith("http://") && !u.startsWith("https://")) {
      setFormError("URL must start with http:// or https://");
      return;
    }
    setFormBusy(true);
    try {
      const res = await d4aiMcpTest({
        data: { url: u, name: n, authToken: token.trim() || undefined },
      });
      if (!res.ok) {
        setFormError(res.error);
        return;
      }
      persistServers([
        {
          id: `mcp-${Date.now()}`,
          name: n,
          url: u,
          authToken: token.trim() || undefined,
          enabled: true,
          lastTestOk: true,
          lastTestAt: Date.now(),
          tools: res.tools || [],
        },
        ...servers,
      ]);
      setName("");
      setUrl("");
      setToken("");
      setShowAdd(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not add server");
    } finally {
      setFormBusy(false);
    }
  };

  const rows = useMemo(() => APP_CATALOG, []);
  if (!open) return null;

  return (
    <div className="absolute inset-0 z-[70] flex flex-col">
      <button type="button" className="absolute inset-0 bg-black/55" onClick={onClose} aria-label="Close" />
      <div className="relative z-10 mt-auto flex max-h-[92%] flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-[#071428] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <p className="text-sm font-bold text-white">Connections</p>
            <p className="text-[11px] text-cyan-200/70">D4AI · Connect apps & MCP</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-white/70 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!owner ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <Lock className="h-10 w-10 text-slate-400" />
            <p className="text-sm font-semibold text-white">Restricted</p>
            <p className="text-xs text-slate-400">Sign in to connect GitHub, Lovable, Supabase, and MCP servers.</p>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 gap-1 border-b border-white/10 px-3 pt-2">
              <button type="button" onClick={() => setTab("apps")} className={cn("flex-1 rounded-t-lg px-3 py-2 text-xs font-semibold", tab === "apps" ? "bg-white/10 text-white" : "text-slate-400")}>
                Apps
              </button>
              <button type="button" onClick={() => setTab("mcp")} className={cn("flex-1 rounded-t-lg px-3 py-2 text-xs font-semibold", tab === "mcp" ? "bg-white/10 text-white" : "text-slate-400")}>
                MCP servers
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {tab === "apps" ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-400">Connect with a real token so D4AI can change repos.</p>
                  {rows.map((c) => {
                    const Icon = c.icon;
                    const on = c.id === "github" ? Boolean(ghLogin || apps.github) : Boolean(apps[c.id]);
                    return (
                      <div key={c.id} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <div className="flex items-start gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-600/20 text-cyan-300">
                            <Icon className="h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-white">{c.title}</p>
                            <p className="mt-0.5 text-[11px] text-slate-400">{c.description}</p>
                            {c.id === "github" && ghLogin ? (
                              <p className="mt-1 text-[10px] text-emerald-400">Signed in as @{ghLogin}</p>
                            ) : null}
                          </div>
                          {c.id === "github" ? (
                            on ? (
                              <button type="button" onClick={disconnectGithub} className="shrink-0 rounded-full bg-emerald-600/30 px-3 py-1.5 text-[11px] font-semibold text-emerald-300">
                                <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5" /> On</span>
                              </button>
                            ) : (
                              <button type="button" onClick={() => setGhOpen((v) => !v)} className="shrink-0 rounded-full bg-cyan-600 px-3 py-1.5 text-[11px] font-semibold text-white">
                                Connect
                              </button>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                const next = { ...apps, [c.id]: !on };
                                setApps(next);
                                saveApps(next);
                              }}
                              className={cn("shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold", on ? "bg-emerald-600/30 text-emerald-300" : "bg-cyan-600 text-white")}
                            >
                              {on ? "On" : "Mark"}
                            </button>
                          )}
                        </div>
                        {c.id === "github" && ghOpen && !ghLogin ? (
                          <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                            <p className="text-[10px] text-slate-400">
                              GitHub → Settings → Developer settings → PAT. Need scope <code className="text-cyan-200">repo</code> or fine-grained Contents Read/Write on d4exam-web.
                            </p>
                            <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder="ghp_… or github_pat_…" className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white" autoComplete="off" />
                            {ghError ? <p className="text-[11px] text-amber-300">{ghError}</p> : null}
                            <button type="button" disabled={ghBusy} onClick={() => void connectGithub()} className="w-full rounded-xl bg-cyan-600 py-2 text-xs font-semibold text-white disabled:opacity-50">
                              {ghBusy ? "Verifying…" : "Verify & connect"}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-slate-400">HTTP MCP endpoints — Test & list tools.</p>
                  {!showAdd ? (
                    <button type="button" onClick={() => setShowAdd(true)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 py-2.5 text-sm font-semibold text-white">
                      <Plus className="h-4 w-4" /> Add MCP server
                    </button>
                  ) : (
                    <div className="space-y-2 rounded-2xl border border-cyan-500/30 bg-cyan-950/30 p-3">
                      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white" />
                      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white" />
                      <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Auth token (optional)" type="password" className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white" />
                      {formError ? <p className="text-[11px] text-amber-300">{formError}</p> : null}
                      <div className="flex gap-2">
                        <button type="button" disabled={formBusy} onClick={() => void addServer()} className="flex-1 rounded-xl bg-cyan-600 py-2 text-xs font-semibold text-white">{formBusy ? "Testing…" : "Test & save"}</button>
                        <button type="button" onClick={() => setShowAdd(false)} className="rounded-xl bg-white/10 px-3 py-2 text-xs text-white">Cancel</button>
                      </div>
                    </div>
                  )}
                  {servers.map((s) => (
                    <div key={s.id} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <div className="flex items-start gap-2">
                        <Server className="mt-1 h-4 w-4 text-violet-300" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-white">{s.name}</p>
                          <p className="truncate text-[10px] text-slate-400">{s.url}</p>
                          {s.lastTestOk ? <p className="text-[10px] text-emerald-400">{(s.tools || []).length} tools</p> : s.lastError ? <p className="text-[10px] text-amber-300">{s.lastError}</p> : null}
                        </div>
                        <button type="button" disabled={busyId === s.id} onClick={() => void testServer(s)} className="text-[10px] text-cyan-200">{busyId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}</button>
                        <button type="button" onClick={() => persistServers(servers.filter((x) => x.id !== s.id))}><Trash2 className="h-3.5 w-3.5 text-slate-400" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
