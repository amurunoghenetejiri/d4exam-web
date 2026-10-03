/**
 * Multi-account switcher for D4EXAM.
 * Tokens only (never passwords). Instant switch — no refresh-login screen.
 *
 * Important: Supabase refresh tokens are single-use. We only refresh when the
 * access JWT is expired, and we always save the new pair immediately.
 */
import { supabase } from "@/integrations/supabase/client";
import type { AppRole, SessionUser } from "@/lib/session";
import { roleHome, clearPendingLoginRole, seedPendingLoginRole } from "@/lib/session";
import { offlineClearUser } from "@/lib/offline-cache";
import { clearFingerprintIfUser, disableFingerprint } from "@/lib/fingerprint-lock";

const VAULT_KEY = "d4_account_vault_v1";
const ACTIVE_KEY = "d4_account_active_v1";
const ADD_ACCOUNT_FLAG = "d4_add_account_flow";

export type SavedAccount = {
  userId: string;
  email: string;
  fullName: string;
  role: AppRole | null;
  roles: AppRole[];
  schoolId: string | null;
  schoolName: string | null;
  schoolCode: string | null;
  identifier: string | null;
  accessToken: string;
  refreshToken: string;
  savedAt: number;
  lastUsedAt: number;
};

type Vault = { accounts: SavedAccount[] };

function readVault(): Vault {
  if (typeof window === "undefined") return { accounts: [] };
  try {
    const raw = window.localStorage.getItem(VAULT_KEY);
    if (!raw) return { accounts: [] };
    const parsed = JSON.parse(raw) as Vault;
    if (!parsed || !Array.isArray(parsed.accounts)) return { accounts: [] };
    return { accounts: parsed.accounts.filter((a) => a && a.userId && a.refreshToken) };
  } catch {
    return { accounts: [] };
  }
}

function writeVault(vault: Vault): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  } catch {
    /* quota */
  }
}

export function listSavedAccounts(): SavedAccount[] {
  return [...readVault().accounts].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
}

export function getActiveAccountId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function setActiveAccountId(userId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (userId) window.localStorage.setItem(ACTIVE_KEY, userId);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

export type AccountListItem = {
  userId: string;
  email: string;
  fullName: string;
  role: AppRole | null;
  roles: AppRole[];
  schoolId: string | null;
  schoolName: string | null;
  schoolCode: string | null;
  identifier: string | null;
  lastUsedAt: number;
  isActive: boolean;
};

export function listAccountsForUi(activeUserId?: string | null): AccountListItem[] {
  const active = activeUserId ?? getActiveAccountId();
  return listSavedAccounts().map((a) => ({
    userId: a.userId,
    email: a.email,
    fullName: a.fullName,
    role: a.role,
    roles: a.roles,
    schoolId: a.schoolId,
    schoolName: a.schoolName,
    schoolCode: a.schoolCode,
    identifier: a.identifier,
    lastUsedAt: a.lastUsedAt,
    isActive: Boolean(active && a.userId === active),
  }));
}

export function roleLabel(role: AppRole | string | null | undefined): string {
  switch (role) {
    case "super_admin":
      return "Super Admin";
    case "school_admin":
      return "School Admin";
    case "examination_officer":
      return "Officer";
    case "teacher":
      return "Teacher";
    case "student":
      return "Student";
    default:
      return role ? String(role) : "User";
  }
}

function envSupabase(): { url: string; key: string } {
  const env =
    typeof import.meta !== "undefined"
      ? (import.meta as unknown as { env?: Record<string, string> }).env || {}
      : {};
  const url = String(env["VITE_SUPABASE_URL"] || "").replace(/\/$/, "");
  const key = String(env["VITE_SUPABASE_PUBLISHABLE_KEY"] || env["VITE_SUPABASE_ANON_KEY"] || "");
  return { url, key };
}

function decodeJwt(access: string): { sub?: string; exp?: number } | null {
  try {
    const part = access.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(b64)) as { sub?: string; exp?: number };
    return json;
  } catch {
    return null;
  }
}

function accessStillValid(access: string): boolean {
  const jwt = decodeJwt(access);
  if (!jwt?.exp) return false;
  return jwt.exp * 1000 > Date.now() + 45_000;
}

function updateAccountTokens(userId: string, access: string, refresh: string): void {
  const vault = readVault();
  const idx = vault.accounts.findIndex((a) => String(a.userId) === String(userId));
  if (idx < 0) return;
  vault.accounts[idx] = {
    ...vault.accounts[idx],
    accessToken: access,
    refreshToken: refresh,
    lastUsedAt: Date.now(),
  };
  writeVault(vault);
}

/** Write session where supabase-js will read it on next page load. */
function injectSessionIntoStorage(access: string, refresh: string, user: unknown): void {
  if (typeof window === "undefined") return;
  const { url } = envSupabase();
  if (!url) return;
  let ref = "";
  try {
    ref = new URL(url).hostname.split(".")[0] || "";
  } catch {
    return;
  }
  if (!ref) return;
  const jwt = decodeJwt(access);
  const expiresAt = jwt?.exp || Math.floor(Date.now() / 1000) + 3600;
  const payload = {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAt,
    expires_in: Math.max(60, expiresAt - Math.floor(Date.now() / 1000)),
    token_type: "bearer",
    user: user ?? null,
  };
  try {
    window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export async function saveCurrentAccountToVault(sessionUser?: SessionUser | null): Promise<boolean> {
  try {
    // Do NOT force refreshSession here — that burns the single-use refresh token.
    const { data } = await supabase.auth.getSession();
    const sess = data.session;
    if (!sess?.access_token || !sess.refresh_token || !sess.user?.id) return false;

    let user = sessionUser;
    if (!user) {
      const { fetchSessionUser } = await import("@/lib/session");
      user = await fetchSessionUser();
    }
    if (!user?.userId) return false;

    const entry: SavedAccount = {
      userId: user.userId,
      email: user.email || sess.user.email || "",
      fullName: user.fullName || user.email || "Account",
      role: user.role,
      roles: user.roles || [],
      schoolId: user.schoolId,
      schoolName: user.schoolName,
      schoolCode: user.schoolCode,
      identifier: user.identifier,
      accessToken: sess.access_token,
      refreshToken: sess.refresh_token,
      savedAt: Date.now(),
      lastUsedAt: Date.now(),
    };

    const vault = readVault();
    const idx = vault.accounts.findIndex((a) => a.userId === entry.userId);
    if (idx >= 0) vault.accounts[idx] = { ...vault.accounts[idx], ...entry };
    else vault.accounts.push(entry);
    writeVault(vault);
    setActiveAccountId(entry.userId);
    return true;
  } catch {
    return false;
  }
}

export async function touchActiveAccountTokens(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const sess = data.session;
    if (!sess?.user?.id || !sess.access_token || !sess.refresh_token) return;
    updateAccountTokens(sess.user.id, sess.access_token, sess.refresh_token);
    setActiveAccountId(sess.user.id);
  } catch {
    /* ignore */
  }
}

let keepAliveStarted = false;
export function startAccountVaultKeepAlive(): void {
  if (typeof window === "undefined" || keepAliveStarted) return;
  keepAliveStarted = true;
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      if (!session?.user?.id || !session.access_token || !session.refresh_token) return;
      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN" || event === "INITIAL_SESSION") {
        updateAccountTokens(session.user.id, session.access_token, session.refresh_token);
        setActiveAccountId(session.user.id);
      }
    });
  } catch {
    /* ignore */
  }
  window.setInterval(() => {
    void touchActiveAccountTokens();
  }, 90_000);
}

export function isAccountSaved(userId: string): boolean {
  return readVault().accounts.some((a) => a.userId === userId);
}

export async function removeAccountFromDevice(userId: string): Promise<void> {
  const vault = readVault();
  vault.accounts = vault.accounts.filter((a) => a.userId !== userId);
  writeVault(vault);
  try {
    await offlineClearUser(userId);
  } catch {
    /* ignore */
  }
  if (getActiveAccountId() === userId) setActiveAccountId(null);
}

async function refreshViaApi(
  refreshToken: string,
): Promise<{ access: string; refresh: string; uid: string; user: unknown } | null> {
  try {
    const { url, key } = envSupabase();
    if (!url || !key) return null;
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        ...(key.startsWith("sb_publishable_") || key.startsWith("sb_secret_")
          ? {}
          : { Authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      user?: { id?: string };
    };
    if (!json.access_token || !json.refresh_token) return null;
    return {
      access: json.access_token,
      refresh: json.refresh_token,
      uid: String(json.user?.id || ""),
      user: json.user || null,
    };
  } catch {
    return null;
  }
}

/**
 * Instant switch into another saved account.
 * Primary path: valid tokens → inject localStorage session → hard navigate to role home.
 * setSession is best-effort only (different-user setSession is flaky in supabase-js).
 */
export async function switchToAccount(
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const vault = readVault();
  const account = vault.accounts.find((a) => a.userId === userId);
  if (!account) return { ok: false, error: "Account not found on this device." };

  const path = account.role && account.role in roleHome ? roleHome[account.role] : "/";
  const targetId = String(userId);

  let prevAccess: string | null = null;
  let prevRefresh: string | null = null;
  let prevUserId: string | null = null;
  let prevUser: unknown = null;

  try {
    const { data: cur } = await supabase.auth.getSession();
    if (cur.session?.access_token && cur.session.refresh_token && cur.session.user?.id) {
      prevAccess = cur.session.access_token;
      prevRefresh = cur.session.refresh_token;
      prevUserId = String(cur.session.user.id);
      prevUser = cur.session.user;
      updateAccountTokens(prevUserId, prevAccess, prevRefresh);
    }
  } catch {
    /* ignore */
  }

  if (prevUserId === targetId && prevAccess) {
    setActiveAccountId(targetId);
    if (account.role) seedPendingLoginRole(account.role);
    if (typeof window !== "undefined") {
      try {
        window.location.replace(path);
      } catch {
        window.location.href = path;
      }
    }
    return { ok: true };
  }

  let refreshTok = (account.refreshToken || "").trim();
  let accessTok = (account.accessToken || "").trim();
  if (!refreshTok) {
    return {
      ok: false,
      error: "No saved session for that account. Use Add Account and sign in once.",
    };
  }

  async function restorePrevious(): Promise<void> {
    if (!prevAccess || !prevRefresh) return;
    try {
      injectSessionIntoStorage(prevAccess, prevRefresh, prevUser);
      await supabase.auth.setSession({
        access_token: prevAccess,
        refresh_token: prevRefresh,
      });
      if (prevUserId) setActiveAccountId(prevUserId);
    } catch {
      /* ignore */
    }
  }

  /** Always inject + hard navigate — this is the reliable switch path. */
  function goHome(access: string, refresh: string, user: unknown): { ok: true } {
    updateAccountTokens(targetId, access, refresh);
    setActiveAccountId(targetId);
    injectSessionIntoStorage(access, refresh, user);
    if (account.role) seedPendingLoginRole(account.role);
    // Best-effort setSession (ignore result — storage injection is the source of truth)
    void supabase.auth
      .setSession({ access_token: access, refresh_token: refresh })
      .catch(() => {});
    if (typeof window !== "undefined") {
      // Cache-bust so WebView / PWA does not reuse old session shell
      const sep = path.includes("?") ? "&" : "?";
      const dest = `${path}${sep}_sw=${Date.now()}`;
      try {
        window.location.replace(dest);
      } catch {
        window.location.href = dest;
      }
    }
    return { ok: true };
  }

  try {
    let userPayload: unknown = null;

    // Prefer existing access token if still valid (does NOT burn refresh token)
    if (accessTok && accessStillValid(accessTok)) {
      const jwt = decodeJwt(accessTok);
      if (!jwt?.sub || jwt.sub === targetId) {
        try {
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 20));
        return goHome(accessTok, refreshTok, null);
      }
      // wrong user token stored — must refresh
    }

    // Access expired or wrong user → refresh once and SAVE immediately
    const api = await refreshViaApi(refreshTok);
    if (api && (!api.uid || api.uid === targetId)) {
      accessTok = api.access;
      refreshTok = api.refresh;
      userPayload = api.user;
      updateAccountTokens(targetId, accessTok, refreshTok);
    } else {
      await restorePrevious();
      return {
        ok: false,
        error:
          "That account’s saved session expired. Use Add Account and sign in as that user once, then Switch will work.",
      };
    }

    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 20));

    return goHome(accessTok, refreshTok, userPayload);
  } catch (e) {
    await restorePrevious();
    return { ok: false, error: (e as Error).message || "Could not switch account." };
  }
}

export function beginRefreshAccountLogin(_opts: {
  email?: string | null;
  userId?: string | null;
  role?: AppRole | null;
}): void {
  void _opts;
}

export async function signOutThisAccount(): Promise<void> {
  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getSession();
    userId = data.session?.user?.id ?? getActiveAccountId();
  } catch {
    userId = getActiveAccountId();
  }
  try {
    clearFingerprintIfUser(userId);
  } catch {
    /* ignore */
  }
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    try {
      await supabase.auth.signOut();
    } catch {
      /* ignore */
    }
  }
  clearPendingLoginRole();
  if (userId) await removeAccountFromDevice(userId);
  const remaining = listSavedAccounts();
  if (typeof window !== "undefined") {
    window.location.href = remaining.length > 0 ? "/login?switched=1" : "/login";
  }
}

export async function signOutAllAccounts(): Promise<void> {
  const vault = readVault();
  const ids = vault.accounts.map((a) => a.userId);
  try {
    disableFingerprint();
  } catch {
    /* ignore */
  }
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    try {
      await supabase.auth.signOut();
    } catch {
      /* ignore */
    }
  }
  clearPendingLoginRole();
  writeVault({ accounts: [] });
  setActiveAccountId(null);
  for (const id of ids) {
    try {
      await offlineClearUser(id);
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== "undefined") window.location.href = "/login";
}

export function beginAddAccountFlow(): void {
  if (typeof window === "undefined") return;
  void saveCurrentAccountToVault().finally(() => {
    try {
      window.sessionStorage.setItem(ADD_ACCOUNT_FLAG, "1");
    } catch {
      /* ignore */
    }
    void supabase.auth.signOut({ scope: "local" }).finally(() => {
      window.location.href = "/login?addAccount=1";
    });
  });
}

export function consumeAddAccountFlow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = window.sessionStorage.getItem(ADD_ACCOUNT_FLAG);
    if (v) {
      window.sessionStorage.removeItem(ADD_ACCOUNT_FLAG);
      return true;
    }
  } catch {
    /* ignore */
  }
  try {
    return new URLSearchParams(window.location.search).get("addAccount") === "1";
  } catch {
    return false;
  }
}

export function isAddAccountUrl(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("addAccount") === "1";
  } catch {
    return false;
  }
}
