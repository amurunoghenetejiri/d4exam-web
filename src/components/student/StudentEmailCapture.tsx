import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSessionUser } from "@/lib/session";
import { isSyntheticStudentEmail } from "@/lib/student-email";
import { notifyStudentEmailLinked } from "@/lib/email-notify.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";

const SKIP_KEY = (userId: string) => `d4_email_skip_${userId}`;

/**
 * Full-screen profile-style sheet: blur backdrop, edge-to-edge, centered card.
 */
export function StudentEmailCapture() {
  const { data: session } = useSessionUser();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!session?.userId) return;
    try {
      if (localStorage.getItem(SKIP_KEY(session.userId)) === "1") {
        setSkipped(true);
      }
    } catch {
      /* ignore */
    }
  }, [session?.userId]);

  useEffect(() => {
    if (done || skipped || !session) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [done, skipped, session]);

  if (!session || session.role !== "student") return null;
  if (done || skipped) return null;
  if (!isSyntheticStudentEmail(session.email)) return null;
  if (!mounted || typeof document === "undefined") return null;

  function dismissSkip() {
    setHiding(true);
    try {
      if (session?.userId) localStorage.setItem(SKIP_KEY(session.userId), "1");
    } catch {
      /* ignore */
    }
    window.setTimeout(() => setSkipped(true), 240);
  }

  async function save() {
    setError("");
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError("Enter a valid email address.");
      return;
    }
    setSaving(true);
    try {
      if (session!.profileId) {
        await supabase
          .from("profiles")
          .update({ email: value } as never)
          .eq("id", session!.profileId);
      }
      await supabase
        .from("profiles")
        .update({ email: value } as never)
        .eq("auth_user_id", session!.userId);
      if (session!.profileId) {
        await supabase
          .from("students")
          .update({ email: value } as never)
          .eq("profile_id", session!.profileId);
      }
      try {
        if (session?.userId) localStorage.removeItem(SKIP_KEY(session.userId));
      } catch {
        /* ignore */
      }
      setDone(true);
      void qc.invalidateQueries({ queryKey: ["session-user"] });
      try {
        void notifyStudentEmailLinked({
          data: {
            email: value,
            studentName: session!.fullName || "Student",
          },
        });
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError((e as Error).message || "Could not save email.");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="d4-email-title"
      className="fixed inset-0 z-[9990] flex flex-col"
      style={{
        width: "100vw",
        height: "100dvh",
        minHeight: "100svh",
        background: "rgba(11, 27, 58, 0.55)",
        backdropFilter: "blur(12px) saturate(1.15)",
        WebkitBackdropFilter: "blur(12px) saturate(1.15)",
        opacity: hiding ? 0 : 1,
        transition: "opacity 0.22s ease",
        pointerEvents: hiding ? "none" : "auto",
      }}
    >
      {/* Top bar like profile */}
      <div
        className="flex shrink-0 items-center justify-between px-3"
        style={{
          paddingTop: "max(0.75rem, env(safe-area-inset-top))",
          paddingBottom: "0.5rem",
        }}
      >
        <button
          type="button"
          onClick={dismissSkip}
          className="grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white active:scale-95"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        <p className="text-sm font-semibold tracking-wide text-white/90">Account</p>
        <span className="h-10 w-10" aria-hidden />
      </div>

      {/* Centered card */}
      <div className="flex flex-1 items-center justify-center px-4 pb-8">
        <div
          className="w-full max-w-sm rounded-2xl border border-white/15 bg-white p-5 shadow-2xl"
          style={{
            transform: hiding ? "translateY(10px) scale(0.98)" : "none",
            transition: "transform 0.22s ease",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <p id="d4-email-title" className="text-base font-bold text-slate-900">
            Add your email
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
            Optional but recommended. Used for results and account recovery. You can change it later.
          </p>
          <div className="mt-4 space-y-2">
            <Label htmlFor="student-personal-email" className="text-xs font-semibold">
              Email
            </Label>
            <Input
              id="student-personal-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@gmail.com"
              className="h-11"
              autoComplete="email"
              autoFocus
            />
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                type="button"
                size="sm"
                className="flex-1 font-semibold"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save email"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={saving}
                onClick={dismissSkip}
              >
                Skip for now
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
