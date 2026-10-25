import { useMemo, useState } from "react";
import {
  Check,
  Github,
  Link2,
  Loader2,
  Lock,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionUser } from "@/lib/session";

/** Only platform owner can manage D4AI connectors (phase 1). */
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

type ConnectorId = "github" | "lovable" | "supabase";

type ConnectorState = {
  id: ConnectorId;
  connected: boolean;
  note?: string;
};

const STORAGE_KEY = "d4ai_owner_connectors_v1";

function loadLocal(): Record<string, ConnectorState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, ConnectorState>;
  } catch {
    return {};
  }
}

function saveLocal(map: Record<string, ConnectorState>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

const CATALOG: {
  id: ConnectorId;
  title: string;
  description: string;
  icon: typeof Github;
  status: "ready_soon" | "local_only";
}[] = [
  {
    id: "github",
    title: "GitHub",
    description: "Read repos, open PRs, edit files via your GitHub token (server-side).",
    icon: Github,
    status: "ready_soon",
  },
  {
    id: "lovable",
    title: "Lovable",
    description: "Link Lovable projects for UI/build context (API when available).",
    icon: Sparkles,
    status: "ready_soon",
  },
  {
    id: "supabase",
    title: "Supabase",
    description: "Your D4EXAM project is already the app database — no extra link needed.",
    icon: Link2,
    status: "local_only",
  },
];

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
  const [map, setMap] = useState(() => loadLocal());
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = useMemo(() => CATALOG, []);

  if (!open) return null;

  const toggleMark = (id: ConnectorId) => {
    setBusyId(id);
    setTimeout(() => {
      setMap((prev) => {
        const next = {
          ...prev,
          [id]: {
            id,
            connected: !prev[id]?.connected,
            note: "Marked for setup — live MCP tools come in the next phase.",
          },
        };
        saveLocal(next);
        return next;
      });
      setBusyId(null);
    }, 400);
  };

  return (
    <div className="absolute inset-0 z-[70] flex flex-col">
      <button
        type="button"
        className="absolute inset-0 bg-black/55"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative z-10 mt-auto max-h-[88%] overflow-hidden rounded-t-3xl border border-white/10 bg-[#071428] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <p className="text-sm font-bold text-white">Connections</p>
            <p className="text-[11px] text-cyan-200/70">D4AI · Owner tools only</p>
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
              Connector management is only available to Amurun Destiny Oghenetejiri (platform owner).
              Students can still chat with D4AI for study help.
            </p>
          </div>
        ) : (
          <div className="space-y-3 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <p className="text-xs text-slate-400">
              Signed in as{" "}
              <span className="font-medium text-cyan-200">{session?.email || session?.fullName}</span>
              . Mark connectors you plan to use. Live GitHub/Lovable actions will attach next (server
              + secure tokens).
            </p>
            {rows.map((c) => {
              const Icon = c.icon;
              const st = map[c.id];
              const on = Boolean(st?.connected);
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
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{c.description}</p>
                    {st?.note ? (
                      <p className="mt-1 text-[10px] text-amber-200/80">{st.note}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={busyId === c.id || c.id === "supabase"}
                    onClick={() => toggleMark(c.id)}
                    className={cn(
                      "shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold",
                      on
                        ? "bg-emerald-600/30 text-emerald-300"
                        : "bg-cyan-600 text-white",
                      c.id === "supabase" && "opacity-60",
                    )}
                  >
                    {busyId === c.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : on ? (
                      <span className="inline-flex items-center gap-1">
                        <Check className="h-3.5 w-3.5" /> On
                      </span>
                    ) : c.id === "supabase" ? (
                      "Built-in"
                    ) : (
                      "Connect"
                    )}
                  </button>
                </div>
              );
            })}
            <p className="px-1 pb-2 text-[10px] leading-relaxed text-slate-500">
              Safety: tokens never go into the chat model prompt. Tools run on the server with your
              owner account only. Repo edits will always require explicit confirm in a later step.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
