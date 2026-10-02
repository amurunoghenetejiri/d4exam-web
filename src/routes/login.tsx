// @ts-nocheck
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchSessionUser,
  roleHome,
  seedPendingLoginRole,
  setPreferredRole,
  seedLoginSchoolContext,
  rememberLastPath,
  type AppRole,
} from "@/lib/session";
import { signInWithSchoolCode } from "@/lib/auth.functions";
import { runApkClientLogin, shouldUseClientLoginOnly } from "@/lib/apk-login";
import { appReplace } from "@/lib/app-navigate";

import { Eye, EyeOff } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";

export const Route = createFileRoute("/login")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — D4EXAM" },
      { name: "description", content: "Sign in to your D4EXAM school account." },
    ],
    links: [{ rel: "canonical", href: "https://d4exam.name.ng/login" }],
  }),
  beforeLoad: async () => {
    try {
      if (typeof window !== "undefined") {
        const q = new URLSearchParams(window.location.search);
        if (q.get("addAccount") === "1" || q.get("switch") === "1") return;
      }
    } catch {
      /* ignore */
    }
    try {
      const user = await Promise.race([
        fetchSessionUser(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
      ]);
      if (user?.role && user.role in roleHome) {
        throw redirect({ to: roleHome[user.role] as never });
      }
    } catch (e) {
      if (e && typeof e === "object" && "to" in e) throw e;
    }
  },
  component: LoginPage,
});

function friendlyLoginError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const cleaned = raw.replace(/\s+/g, " ").trim();
  const lower = cleaned.toLowerCase();
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "No network. Check your connection and try again.";
  }
  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed") ||
    lower.includes("load failed") ||
    lower.includes("offline") ||
    lower.includes("net::err_")
  ) {
    return "No network. Check your connection and try again.";
  }
  if (
    lower.includes("invalid login") ||
    lower.includes("invalid credentials") ||
    lower.includes("invalid_grant") ||
    lower.includes("invalid email or password")
  ) {
    return "Invalid credentials.";
  }
  if (cleaned.length > 120) return "Unable to sign in right now. Please try again.";
  return cleaned || "Unable to sign in. Please try again.";
}

function readQueryPrefill(): { email: string } {
  if (typeof window === "undefined") return { email: "" };
  try {
    const q = new URLSearchParams(window.location.search);
    return { email: (q.get("email") || "").trim() };
  } catch {
    return { email: "" };
  }
}

async function seedSchoolFromCode(schoolCode: string | null | undefined) {
  const code = (schoolCode || "").trim().toUpperCase();
  if (!code || code === "SUPER" || code === "PLATFORM") return null;
  try {
    const { data: rpcSchool } = await supabase.rpc("resolve_school_for_login", {
      _school_code: code,
    });
    const row = Array.isArray(rpcSchool) ? rpcSchool[0] : rpcSchool;
    const id =
      row && typeof row === "object" && (row as { id?: string }).id
        ? String((row as { id: string }).id)
        : null;
    if (id) {
      seedLoginSchoolContext(id, code);
      return id;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Force leave /login → role dashboard (hash-aware for APK). */
function hardNavigateToRole(role: string) {
  const r = (role in roleHome ? role : "examination_officer") as AppRole;
  const path = roleHome[r];
  try {
    seedPendingLoginRole(r);
    setPreferredRole(r);
    rememberLastPath(path, r);
  } catch {
    /* ignore */
  }

  // Prefer SPA router if bound
  try {
    appReplace(path);
  } catch {
    /* fall through */
  }

  // APK uses hash history — always set hash so WebView leaves /login
  try {
    const host = (window.location.hostname || "").toLowerCase();
    const isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "" ||
      window.location.protocol === "file:" ||
      Boolean((window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA);
    if (isLocal || window.location.hash.startsWith("#")) {
      const next = `${window.location.pathname}${window.location.search}#${path}`;
      window.location.replace(next);
      return;
    }
  } catch {
    /* ignore */
  }

  try {
    window.location.replace(path);
  } catch {
    try {
      window.location.href = path;
    } catch {
      /* ignore */
    }
  }
}

function LoginPage() {
  const loginFn = useServerFn(signInWithSchoolCode);
  const prefill = readQueryPrefill();
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [identifier, setIdentifier] = useState(prefill.email);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const inFlight = useRef(false);

  useEffect(() => {
    if (prefill.email && !identifier) setIdentifier(prefill.email);
  }, [prefill.email]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (inFlight.current || loading) {
      setLoading(false);
      inFlight.current = false;
      setError("");
      return;
    }
    setError("");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setError("No network. Check your connection and try again.");
      return;
    }
    if (!identifier.trim() || !password.trim()) {
      setError("Please enter your login details.");
      return;
    }
    inFlight.current = true;
    setLoading(true);
    let navigated = false;
    let lastServerMsg = "";
    const loginTimeout = window.setTimeout(() => {
      if (navigated) return;
      setLoading(false);
      inFlight.current = false;
      setError("Sign-in is taking longer than usual. Please try again.");
    }, 20_000);

    try {
      const schoolCode = code.trim().toUpperCase();
      const ident = identifier.trim();
      const pass = password;

      // Pure client Supabase (APK has no server functions)
      const apk = await runApkClientLogin({
        schoolCode: schoolCode || "",
        identifier: ident,
        password: pass,
      });

      if (apk.ok && apk.accessToken) {
        // setSession already done inside runApkClientLogin; reinforce
        const { error: sessErr } = await supabase.auth.setSession({
          access_token: apk.accessToken,
          refresh_token: apk.refreshToken || "",
        });
        if (sessErr) {
          lastServerMsg = sessErr.message || "Could not save session.";
        } else {
          try {
            if (apk.schoolId) {
              seedLoginSchoolContext(apk.schoolId, apk.schoolCode || schoolCode);
            } else if (schoolCode) {
              await seedSchoolFromCode(schoolCode);
            }
          } catch {
            /* ignore */
          }

          const role =
            (apk.role && apk.role in roleHome ? apk.role : null) ||
            "examination_officer";

          try {
            seedPendingLoginRole(role);
            setPreferredRole(role as AppRole);
            rememberLastPath(roleHome[role as AppRole], role);
          } catch {
            /* ignore */
          }

          navigated = true;
          hardNavigateToRole(role);
          return;
        }
      } else if (!apk.ok && apk.error) {
        lastServerMsg = String(apk.error);
      }

      // Website SSR only
      if (!shouldUseClientLoginOnly()) {
        try {
          const result = await Promise.race([
            loginFn({
              data: { schoolCode: schoolCode || "", identifier: ident, password: pass },
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
          ]);
          if (result && "session" in result && result.session?.access_token) {
            await supabase.auth.setSession({
              access_token: result.session.access_token,
              refresh_token: result.session.refresh_token,
            });
            const role =
              result.role && String(result.role) in roleHome
                ? String(result.role)
                : "student";
            navigated = true;
            hardNavigateToRole(role);
            return;
          }
          if (result && "error" in result && result.error) {
            lastServerMsg = String(result.error);
          }
        } catch (serverErr) {
          lastServerMsg = friendlyLoginError(serverErr);
        }
      }

      // Final direct email attempt
      const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ident);
      if (looksEmail) {
        const { data: d, error: de } = await supabase.auth.signInWithPassword({
          email: ident.toLowerCase(),
          password: pass,
        });
        if (!de && d?.session) {
          await seedSchoolFromCode(schoolCode);
          navigated = true;
          hardNavigateToRole("examination_officer");
          return;
        }
        if (de?.message) lastServerMsg = de.message;
      }

      setError(friendlyLoginError(lastServerMsg || "Invalid credentials."));
    } catch (err) {
      setError(friendlyLoginError(err));
    } finally {
      window.clearTimeout(loginTimeout);
      if (!navigated) {
        setLoading(false);
        inFlight.current = false;
      }
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="border-b border-slate-200 px-4 py-3">
        <Link to="/" className="inline-flex">
          <Logo size="sm" wordmark />
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-8">
        <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>
        <p className="mt-1 text-sm text-slate-500">Enter your school code and account details.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <Label htmlFor="school">School code</Label>
            <Input
              id="school"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. FUPRE185"
              autoCapitalize="characters"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="id">Email / Matric / Staff ID</Label>
            <Input
              id="id"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="you@email.com"
              className="mt-1"
              autoComplete="username"
            />
          </div>
          <div>
            <Label htmlFor="pw">Password</Label>
            <div className="relative mt-1">
              <Input
                id="pw"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="remember"
              checked={remember}
              onCheckedChange={(v) => setRemember(v === true)}
            />
            <Label htmlFor="remember" className="font-normal">
              Remember this device
            </Label>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </main>
    </div>
  );
}
