import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSessionUser } from "@/lib/session";
import { isSyntheticStudentEmail } from "@/lib/student-email";
import { notifyStudentEmailLinked } from "@/lib/email-notify.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SKIP_KEY = (userId: string) => `d4_email_skip_${userId}`;

export function StudentEmailCapture() {
  const { data: session } = useSessionUser();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [hiding, setHiding] = useState(false);

  // Restore persisted skip so "Skip for now" does not flash back on reload
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

  if (!session || session.role !== "student") return null;
  if (done || skipped) return null;
  if (!isSyntheticStudentEmail(session.email)) return null;

  function dismissSkip() {
    setHiding(true);
    try {
      if (session?.userId) localStorage.setItem(SKIP_KEY(session.userId), "1");
    } catch {
      /* ignore */
    }
    // Short fade so it does not just vanish abruptly
    window.setTimeout(() => setSkipped(true), 220);
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

  return (
    <div
      className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200"
      style={{
        opacity: hiding ? 0 : 1,
        transform: hiding ? "translateY(-6px)" : "none",
        pointerEvents: hiding ? "none" : undefined,
      }}
    >
      <p className="text-sm font-bold text-slate-900">Add your email</p>
      <p className="mt-1 text-xs text-slate-500">
        Optional but recommended. Used for results and account recovery. You can change it later.
      </p>
      <div className="mt-3 space-y-2">
        <Label htmlFor="student-personal-email" className="text-xs font-semibold">
          Email
        </Label>
        <Input
          id="student-personal-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@gmail.com"
          className="h-10"
          autoComplete="email"
        />
        {error ? <p className="text-xs text-red-600">{error}</p> : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" size="sm" className="font-semibold" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save email"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={dismissSkip}>
            Skip for now
          </Button>
        </div>
      </div>
    </div>
  );
}
