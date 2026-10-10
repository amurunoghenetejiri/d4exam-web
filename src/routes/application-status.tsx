import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, Loader2, Clock, Info, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/application-status")({
  head: () => ({
    meta: [
      { title: "Application Status — D4EXAM" },
      {
        name: "description",
        content: "Check the progress of your D4EXAM school application.",
      },
    ],
    links: [
      { rel: "canonical", href: "https://d4exam.name.ng/application-status" },
    ],
  }),
  component: Page,
});

const TRACK_KEY = "d4exam_school_application_track";

type AppRow = {
  id: string;
  school_name: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  applicant_email: string;
  tracking_code: string | null;
  issued_school_code: string | null;
  issued_admin_email: string | null;
  issued_admin_password: string | null;
};

function friendlyStatus(status: string) {
  const s = status.toLowerCase();
  if (s === "approved") {
    return {
      title: "Approved",
      tone: "text-emerald-800 bg-emerald-50 border-emerald-200",
      icon: CheckCircle2,
      message:
        "Great news — your school has been approved. Set a password below, then sign in to your school admin panel.",
    };
  }
  if (s === "rejected") {
    return {
      title: "Not approved",
      tone: "text-rose-800 bg-rose-50 border-rose-200",
      icon: XCircle,
      message:
        "Your application was not approved at this time. Read any note from the reviewer below, or contact support if you need help.",
    };
  }
  if (s === "more_information_required") {
    return {
      title: "More information needed",
      tone: "text-amber-900 bg-amber-50 border-amber-200",
      icon: Info,
      message:
        "The reviewer needs a little more detail before they can finish. Check the note below and reply through the channel you used to apply, or submit an updated application if asked.",
    };
  }
  if (s === "under_review") {
    return {
      title: "Under review",
      tone: "text-sky-900 bg-sky-50 border-sky-200",
      icon: Clock,
      message:
        "A platform administrator is reviewing your application. You do not need to do anything right now — this page will update when there is news.",
    };
  }
  return {
    title: "Submitted",
    tone: "text-slate-800 bg-slate-50 border-slate-200",
    icon: Clock,
    message:
      "Your application has been received and is waiting for platform admin approval. Please check back here later — you will see an update as soon as a decision is made.",
  };
}

function Page() {
  const [email, setEmail] = useState("");
  const [refId, setRefId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<AppRow[] | null>(null);
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdError, setPwdError] = useState("");
  const [pwdOk, setPwdOk] = useState<{ schoolCode: string; adminEmail: string } | null>(null);
  const [setupDone, setSetupDone] = useState<{
    schoolCode: string;
    adminEmail: string;
    schoolName?: string;
  } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(TRACK_KEY);
      if (!raw) return;
      const track = JSON.parse(raw) as { email?: string; trackingCode?: string };
      if (track.email) setEmail(track.email);
      if (track.trackingCode) setRefId(track.trackingCode);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!rows?.length) return;
    const ids = rows.map((r) => r.id);
    const channel = supabase
      .channel(`app-status-${ids.join("-").slice(0, 40)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "school_applications" },
        (payload) => {
          const next = payload.new as AppRow | undefined;
          if (!next?.id) return;
          setRows((prev) => {
            const prevRow = prev?.find((r) => r.id === next.id);
            const prevStatus = prevRow ? String(prevRow.status || "").toLowerCase() : "";
            const nextStatus = String(next.status || "").toLowerCase();
            if (prevStatus && nextStatus && prevStatus !== nextStatus) {
              try {
                if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                  const title =
                    nextStatus === "approved"
                      ? "School application approved"
                      : nextStatus === "rejected"
                        ? "School application update"
                        : "School application update";
                  const body =
                    nextStatus === "approved"
                      ? `${next.school_name || "Your school"} was approved on D4EXAM.`
                      : nextStatus === "rejected"
                        ? `${next.school_name || "Your school"} application was not approved.`
                        : `${next.school_name || "Your school"} is now ${nextStatus.replaceAll("_", " ")}.`;
                  new Notification(title, { body, icon: "/icon-192.png" });
                }
              } catch {
                /* ignore */
              }
            }
            return prev ? prev.map((r) => (r.id === next.id ? { ...r, ...next } : r)) : prev;
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [rows?.map((r) => r.id).join(",")]);

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setRows(null);
    setPwdOk(null);
    setLoading(true);
    try {
      const em = email.trim().toLowerCase();
      const code = refId.trim();
      if (!em) {
        setError("Enter the email you used when you applied.");
        return;
      }
      if (!code) {
        setError("Enter the reference code you received after submitting your application.");
        return;
      }

      const fullCols =
        "id, school_name, status, created_at, reviewed_at, review_notes, applicant_email, tracking_code, issued_school_code, issued_admin_email, issued_admin_password";
      const coreCols =
        "id, school_name, status, created_at, reviewed_at, review_notes, applicant_email, tracking_code";

      let data: unknown[] | null = null;
      let qErr: { message?: string } | null = null;

      {
        const res = await supabase
          .from("school_applications")
          .select(fullCols)
          .ilike("applicant_email", em)
          .ilike("tracking_code", code)
          .order("created_at", { ascending: false })
          .limit(5);
        data = res.data as unknown[] | null;
        qErr = res.error;
      }

      // Older DBs may lack issued_* columns — retry with core fields only
      if (qErr && /issued_|column|schema cache/i.test(String(qErr.message || ""))) {
        const res = await supabase
          .from("school_applications")
          .select(coreCols)
          .ilike("applicant_email", em)
          .ilike("tracking_code", code)
          .order("created_at", { ascending: false })
          .limit(5);
        data = (res.data as unknown[] | null)?.map((r) => ({
          ...(r as object),
          issued_school_code: null,
          issued_admin_email: null,
          issued_admin_password: null,
        })) ?? null;
        qErr = res.error;
      }

      if (qErr) {
        console.warn("[application-status] lookup", qErr);
        setError("We could not look up your application right now. Please try again shortly.");
        return;
      }
      if (!data?.length) {
        setError(
          "No application found for that email and reference code. Double-check both and try again.",
        );
        return;
      }

      setRows(data as AppRow[]);
      try {
        localStorage.setItem(TRACK_KEY, JSON.stringify({ email: em, trackingCode: code }));
      } catch {
        /* ignore */
      }
      // Soft-request notification permission so applicants get live status updates
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          void Notification.requestPermission().then((perm) => {
            try {
              localStorage.setItem(
                "d4exam_applicant_notify",
                JSON.stringify({ trackingCode: code, permission: perm, at: Date.now() }),
              );
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
    } finally {
      setLoading(false);
    }
  }

  async function confirmPassword(app: AppRow) {
    setPwdError("");
    if (pwd.length < 8) {
      setPwdError("Password must be at least 8 characters.");
      return;
    }
    if (pwd !== pwd2) {
      setPwdError("Passwords do not match.");
      return;
    }

    const schoolCode = String(app.issued_school_code || "").trim();
    const adminEmail = String(app.issued_admin_email || app.applicant_email || email)
      .trim()
      .toLowerCase();
    const trackCode = String(app.tracking_code || refId).trim();
    const applicantEmail = String(app.applicant_email || email).trim().toLowerCase();

    if (!schoolCode) {
      setPwdError("Your school code is not ready yet. Please try again in a few minutes.");
      return;
    }
    if (String(app.status).toLowerCase() !== "approved") {
      setPwdError("Your application is not approved yet.");
      return;
    }

    setPwdBusy(true);
    try {
      let userId: string | null = null;

      const { data: signedUp, error: signUpErr } = await supabase.auth.signUp({
        email: adminEmail,
        password: pwd,
        options: {
          data: {
            full_name: app.school_name || "School Admin",
            role: "school_admin",
            school_code: schoolCode,
          },
        },
      });
      userId = signedUp?.user?.id ?? null;

      if (signUpErr || !userId) {
        const msg = (signUpErr?.message || "").toLowerCase();
        if (/already|registered|exists/i.test(msg) || !userId) {
          const { data: signedIn, error: inErr } = await supabase.auth.signInWithPassword({
            email: adminEmail,
            password: pwd,
          });
          if (inErr || !signedIn?.user) {
            setPwdError(
              "An account with this email already exists with a different password. Use Forgot password on the login page, then sign in with your school code.",
            );
            return;
          }
          userId = signedIn.user.id;
        } else {
          setPwdError(signUpErr?.message || "Could not create your login.");
          return;
        }
      }

      const claimEmails = [...new Set([adminEmail, applicantEmail].filter(Boolean))];
      let claimedOk = false;
      let claimMessage = "";
      for (const claimEmail of claimEmails) {
        const { data: claimed, error: claimErr } = await supabase.rpc("claim_approved_school_admin", {
          _tracking_code: trackCode,
          _email: claimEmail,
          _user_id: userId,
        });
        if (claimErr) {
          claimMessage = claimErr.message;
          continue;
        }
        const row = Array.isArray(claimed) ? claimed[0] : claimed;
        if (row && typeof row === "object" && (row as { ok?: boolean }).ok === false) {
          claimMessage = String((row as { error?: string }).error || "Claim failed");
          continue;
        }
        claimedOk = true;
        break;
      }

      if (!claimedOk && claimMessage) {
        console.warn("[confirmPassword] claim:", claimMessage);
      }

      setPwdOk({ schoolCode, adminEmail });
      setSetupDone({
        schoolCode,
        adminEmail,
        schoolName: app.school_name,
      });
      setPwd("");
      setPwd2("");
      // Close the application-status flow — no longer needed after password is set
      try {
        localStorage.removeItem(TRACK_KEY);
        localStorage.setItem(
          "d4exam_application_setup_done",
          JSON.stringify({
            schoolCode,
            adminEmail,
            schoolName: app.school_name,
            at: Date.now(),
          }),
        );
      } catch {
        /* ignore */
      }
      setRows(null);
      setRefId("");
      setError("");
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : "Could not save password.");
    } finally {
      setPwdBusy(false);
    }
  }

  if (setupDone || pwdOk) {
    const done = setupDone || pwdOk;
    return (
      <PublicLayout>
        <div className="mx-auto max-w-lg space-y-6 px-4 py-10">
          <div className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-950">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-700" />
              <div>
                <h1 className="text-xl font-extrabold">School portal is ready</h1>
                <p className="mt-1 text-sm opacity-90">
                  Your password is set. Application status is closed — sign in to your school admin panel.
                </p>
              </div>
            </div>
            <ul className="space-y-1 rounded-xl border border-emerald-200 bg-white/70 px-4 py-3 font-mono text-sm">
              <li>
                <span className="font-sans font-semibold text-slate-600">School code:</span>{" "}
                {done?.schoolCode}
              </li>
              <li>
                <span className="font-sans font-semibold text-slate-600">Admin email:</span>{" "}
                {done?.adminEmail}
              </li>
            </ul>
            <Button asChild className="h-11 w-full font-semibold">
              <Link to="/login">Go to login</Link>
            </Button>
          </div>
        </div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <div className="mx-auto max-w-lg space-y-6 px-4 py-10">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">Application status</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter the email and reference code from your application to see the latest update.
          </p>
        </div>

        <form onSubmit={check} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="space-y-1.5">
            <Label htmlFor="email">Applicant email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11"
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref">Reference code</Label>
            <Input
              id="ref"
              value={refId}
              onChange={(e) => setRefId(e.target.value)}
              className="h-11 font-mono"
              required
              placeholder="e.g. D4-XXXXXX"
            />
          </div>
          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
          <Button type="submit" className="h-11 w-full font-semibold" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking…
              </>
            ) : (
              "Check status"
            )}
          </Button>
        </form>

        {rows?.map((r) => {
          const meta = friendlyStatus(r.status);
          const Icon = meta.icon;
          const approved = r.status.toLowerCase() === "approved";
          const schoolCode = r.issued_school_code;
          const adminEmail = r.issued_admin_email || r.applicant_email;

          return (
            <div key={r.id} className={`space-y-3 rounded-2xl border p-5 ${meta.tone}`}>
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <p className="font-bold">{r.school_name}</p>
                  <p className="text-sm font-semibold">{meta.title}</p>
                  <p className="mt-1 text-sm opacity-90">{meta.message}</p>
                </div>
              </div>

              {r.review_notes ? (
                <p className="rounded-lg border border-black/5 bg-white/60 px-3 py-2 text-sm">
                  <span className="font-semibold">Note: </span>
                  {r.review_notes}
                </p>
              ) : null}

              {approved && schoolCode && (
                <div className="space-y-3 rounded-xl border border-emerald-200 bg-white p-4 text-slate-800">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Your school is ready</p>
                    <p className="mt-1 text-sm">
                      School code: <strong className="font-mono">{schoolCode}</strong>
                      <br />
                      Admin email: <strong>{adminEmail}</strong>
                    </p>
                  </div>

                  {pwdOk ? (
                    <Alert className="border-emerald-200 bg-emerald-50">
                      <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                      <AlertTitle>Password saved</AlertTitle>
                      <AlertDescription className="mt-2 space-y-2 text-sm">
                        <p>
                          Sign in with school code <strong className="font-mono">{pwdOk.schoolCode}</strong>,
                          email <strong>{pwdOk.adminEmail}</strong>, and the password you just set.
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Button asChild className="font-semibold">
                            <Link to="/login">Go to login</Link>
                          </Button>
                        </div>
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <div className="space-y-3 border-t border-emerald-100 pt-3">
                      <p className="text-sm font-semibold text-slate-800">Create your login password</p>
                      <div className="space-y-1.5">
                        <Label htmlFor={`pwd-${r.id}`}>New password</Label>
                        <Input
                          id={`pwd-${r.id}`}
                          type="password"
                          value={pwd}
                          onChange={(e) => setPwd(e.target.value)}
                          className="h-11"
                          autoComplete="new-password"
                          placeholder="At least 8 characters"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`pwd2-${r.id}`}>Confirm password</Label>
                        <Input
                          id={`pwd2-${r.id}`}
                          type="password"
                          value={pwd2}
                          onChange={(e) => setPwd2(e.target.value)}
                          className="h-11"
                          autoComplete="new-password"
                        />
                      </div>
                      {pwdError ? <p className="text-sm text-rose-600">{pwdError}</p> : null}
                      <Button
                        type="button"
                        className="h-11 w-full font-semibold"
                        disabled={pwdBusy}
                        onClick={() => void confirmPassword(r)}
                      >
                        {pwdBusy ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                          </>
                        ) : (
                          "Confirm password"
                        )}
                      </Button>
                      <p className="text-xs text-slate-500">
                        After you confirm, go to the login page and open your school admin dashboard.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {approved && !schoolCode && (
                <p className="text-sm">
                  Approval is recorded. Your school login details are being prepared — refresh this page in a
                  moment.
                </p>
              )}
            </div>
          );
        })}

        <p className="text-center text-sm text-slate-500">
          Need to apply?{" "}
          <Link to="/school-application" className="font-semibold text-primary hover:underline">
            Start a school application
          </Link>
        </p>
      </div>
    </PublicLayout>
  );
}
