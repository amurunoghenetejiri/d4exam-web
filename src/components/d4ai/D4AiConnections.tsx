import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Github,
  Link2,
  Loader2,
  Lock,
  Plus,
  Server,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionUser } from "@/lib/session";
import { d4aiMcpTest } from "@/lib/d4ai-mcp.server";

/** Only platform owner can manage D4AI connectors. */
export function isD4AiOwner(session: SessionUser | null | undefined): boolean {
  if (!session) return false;
  const email = String(session.email || "").trim().toLowerCase();
  const name = String(session.fullName || "").trim().toLowerCase();
  const ownerEmails = (
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: Record<string, string> }).env?.VITE_D4AI_OWNER_EMAILS) ||
    "amurundestiny@gmail.com"
  )
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (ownerEmails.includes(email)) return true;
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
  } catch {
    /* ignore */
  }
}

type AppId = "github" | "lovable" | "supabase";

const APP_CATALOG: {
  id: AppId;
  title: string;
  description: string;
  icon: typeof Github;
}[] = [
  {
    id: "github",
    title: "GitHub",
    description: "Repos & PRs via MCP (e.g. official GitHub MCP) or native API next.",
    icon: Github,
  },
  {
    id: "lovable",
    title: "Lovable",
    description: "Link when you have an HTTP MCP or API endpoint for your projects.",
    icon: Sparkles,
  },
  {
    id: "supabase",
    title: "Supabase",
    description: "Already powers D4EXAM — use an MCP bridge if you expose one.",
    icon: Link2,
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
  } catch {
    /* ignore */
  }
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
  const owner = isD4AiOwner(session);
  const [tab, setTab] = useState<"apps" | "mcp">("mcp");
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [apps, setApps] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setServers(loadMcp());
    setApps(loadApps());
  }, [open]);

  const persistServers = useCallback((list: McpServerConfig[]) => {
    setServers(list);
    saveMcp(list);
  }, []);

  const testServer = async (cfg: McpServerConfig) => {
    setBusyId(cfg.id);
    try {
      const res = await d4aiMcpTest({
        data: {
          url: cfg.url,
          name: cfg.name,
          authToken: cfg.authToken || undefined,
        },
      });
      const next = servers.map((s) => {
        if (s.id !== cfg.id) return s;
        if (!res.ok) {
          return {
            ...s,
            lastTestOk: false,
            lastTestAt: Date.now(),
            lastError: res.error,
            tools: [],
          };
        }
        return {
          ...s,
          lastTestOk: true,
          lastTestAt: Date.now(),
          lastError: "warning" in res ? String(res.warning) : undefined,
          tools: res.tools || [],
        };
      });
      persistServers(next);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Test failed";
      persistServers(
        servers.map((s) =>
          s.id === cfg.id
            ? { ...s, lastTestOk: false, lastTestAt: Date.now(), lastError: msg }
            : s,
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
        data: {
          url: u,
          name: n,
          authToken: token.trim() || undefined,
        },
      });
      if (!res.ok) {
        setFormError(res.error);
        setFormBusy(false);
        return;
      }
      const entry: McpServerConfig = {
        id: `mcp-${Date.now()}`,
        name: n,
        url: u,
        authToken: token.trim() || undefined,
        enabled: true,
        lastTestOk: true,
        lastTestAt: Date.now(),
        lastError: "warning" in res ? String(res.warning) : undefined,
        tools: res.tools || [],
      };
      persistServers([entry, ...servers]);
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

  const removeServer = (id: string) => {
    persistServers(servers.filter((s) => s.id !== id));
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
            <p className="text-[11px] text-cyan-200/70">D4AI · Owner tools</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-white/70 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!owner ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <Lock className="h-10 w-10 text-slate-400" />
            <p className="text-sm font-semibold text-white">Restricted</p>
            <p className="text-xs leading-relaxed text-slate-400">
              Only Amurun Destiny Oghenetejiri can add MCP servers and app connectors.
            </p>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 gap-1 border-b border-white/10 px-3 pt-2">
              <button
                type="button"
                onClick={() => setTab("mcp")}
                className={cn(
                  "flex-1 rounded-t-lg px-3 py-2 text-xs font-semibold",
                  tab === "mcp" ? "bg-white/10 text-white" : "text-slate-400",
                )}
              >
                MCP servers
              </button>
              <button
                type="button"
                onClick={() => setTab("apps")}
                className={cn(
                  "flex-1 rounded-t-lg px-3 py-2 text-xs font-semibold",
                  tab === "apps" ? "bg-white/10 text-white" : "text-slate-400",
                )}
              >
                Apps
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {tab === "mcp" ? (
                <div className="space-y-3">
                  <p className="text-xs text-slate-400">
                    Add any <span className="text-cyan-200">HTTP MCP</span> endpoint (Streamable HTTP /
                    JSON-RPC). Stdio-only servers need a bridge URL first.
                  </p>

                  {!showAdd ? (
                    <button
                      type="button"
                      onClick={() => setShowAdd(true)}
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 py-2.5 text-sm font-semibold text-white"
                    >
                      <Plus className="h-4 w-4" /> Add MCP server
                    </button>
                  ) : (
                    <div className="space-y-2 rounded-2xl border border-cyan-500/30 bg-cyan-950/30 p-3">
                      <p className="text-xs font-semibold text-cyan-100">New MCP server</p>
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Name (e.g. GitHub MCP)"
                        className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                      />
                      <input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://your-mcp-host/mcp"
                        className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                      />
                      <input
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="Auth token (optional)"
                        type="password"
                        autoComplete="off"
                        className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                      />
                      {formError ? <p className="text-[11px] text-amber-300">{formError}</p> : null}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={formBusy}
                          onClick={() => void addServer()}
                          className="flex-1 rounded-xl bg-cyan-600 py-2 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          {formBusy ? "Testing…" : "Test & save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAdd(false);
                            setFormError(null);
                          }}
                          className="rounded-xl bg-white/10 px-3 py-2 text-xs text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {servers.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-500">No MCP servers yet.</p>
                  ) : (
                    servers.map((s) => (
                      <div
                        key={s.id}
                        className="rounded-2xl border border-white/10 bg-white/5 p-3"
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/20 text-violet-300">
                            <Server className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-white">{s.name}</p>
                            <p className="truncate text-[10px] text-slate-400">{s.url}</p>
                            {s.lastTestOk === true ? (
                              <p className="mt-1 text-[10px] text-emerald-400">
                                Connected · {(s.tools || []).length} tool(s)
                              </p>
                            ) : s.lastTestOk === false ? (
                              <p className="mt-1 text-[10px] text-amber-300">
                                {s.lastError || "Last test failed"}
                              </p>
                            ) : null}
                            {(s.tools || []).length > 0 ? (
                              <ul className="mt-1 max-h-20 overflow-y-auto text-[10px] text-slate-400">
                                {s.tools!.slice(0, 12).map((t) => (
                                  <li key={t.name} className="truncate">
                                    · {t.name}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              disabled={busyId === s.id}
                              onClick={() => void testServer(s)}
                              className="rounded-lg bg-white/10 px-2 py-1 text-[10px] font-semibold text-cyan-200"
                            >
                              {busyId === s.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                "Test"
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => removeServer(s.id)}
                              className="rounded-lg p-1 text-slate-400 hover:text-red-400"
                              aria-label="Remove"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}

                  <p className="text-[10px] leading-relaxed text-slate-500">
                    Tokens stay in this device’s browser storage for now. Live tool calls from chat
                    use the server and only work for your owner account.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-slate-400">
                    Preferred apps. Prefer adding their MCP URL under MCP servers when available.
                  </p>
                  {rows.map((c) => {
                    const Icon = c.icon;
                    const on = Boolean(apps[c.id]);
                    return (
                      <div
                        key={c.id}
                        className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-3"
                      >
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-600/20 text-cyan-300">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-white">{c.title}</p>
                          <p className="mt-0.5 text-[11px] text-slate-400">{c.description}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const next = { ...apps, [c.id]: !on };
                            setApps(next);
                            saveApps(next);
                          }}
                          className={cn(
                            "shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold",
                            on ? "bg-emerald-600/30 text-emerald-300" : "bg-cyan-600 text-white",
                          )}
                        >
                          {on ? (
                            <span className="inline-flex items-center gap-1">
                              <Check className="h-3.5 w-3.5" /> On
                            </span>
                          ) : (
                            "Mark"
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
