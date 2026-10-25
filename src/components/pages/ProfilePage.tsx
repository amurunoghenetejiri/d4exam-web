import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Loader2,
  Shield,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui/section-card";
import { useSchoolIdentity } from "@/hooks/use-school-identity";
import { useSessionUser } from "@/lib/session";
import { useStudentContext } from "@/hooks/use-student-context";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";

const roleLabel: Record<string, string> = {
  student: "Student",
  teacher: "Teacher",
  school_admin: "School admin",
  examination_officer: "Examination officer",
  super_admin: "Super admin",
};

const roleBadgeStyles: Record<
  string,
  { className: string; icon: typeof UserRound }
> = {
  student: {
    className:
      "border-sky-200/80 bg-sky-50 text-sky-800 shadow-sm shadow-sky-100/80",
    icon: UserRound,
  },
  teacher: {
    className:
      "border-violet-200/80 bg-violet-50 text-violet-800 shadow-sm shadow-violet-100/80",
    icon: UserRound,
  },
  school_admin: {
    className:
      "border-emerald-200/80 bg-emerald-50 text-emerald-800 shadow-sm shadow-emerald-100/80",
    icon: Building2,
  },
  examination_officer: {
    className:
      "border-amber-200/80 bg-amber-50 text-amber-900 shadow-sm shadow-amber-100/80",
    icon: Shield,
  },
  super_admin: {
    className:
      "border-indigo-200/80 bg-indigo-50 text-indigo-900 shadow-sm shadow-indigo-100/80",
    icon: ShieldCheck,
  },
};

function ProfileField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-b border-slate-100 py-2.5 last:border-0 last:pb-0 first:pt-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 sm:text-[11px]">
        {label}
      </p>
      <p className="mt-0.5 break-words text-sm font-semibold leading-snug text-slate-900 [overflow-wrap:anywhere]">
        {value ?? "—"}
      </p>
    </div>
  );
}

function RoleBadge({ roleKey }: { roleKey: string }) {
  const label = roleLabel[roleKey] ?? roleKey;
  const style = roleBadgeStyles[roleKey] ?? {
    className: "border-slate-200 bg-slate-50 text-slate-700 shadow-sm",
    icon: UserRound,
  };
  const Icon = style.icon;

  return (
    <Badge
      variant="outline"
      className={cn(
        "mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide sm:text-xs",
        style.className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {label}
    </Badge>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function ProfilePage() {
  const { data: user, isLoading, error } = useSessionUser();
  const { data: school } = useSchoolIdentity(user?.schoolId);
  const { data: student } = useStudentContext();
  const qc = useQueryClient();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    const roleLike =
      /^(school\s*admin|examination\s*officer|departmental\s*officer|teacher|student|super\s*admin|user)$/i;
    const seed = (user.fullName || student?.fullName || "").trim();
    setFullName(seed && !roleLike.test(seed) ? seed : "");
    setEmail(user.email || "");
    void (async () => {
      try {
        let data: { phone?: string | null; full_name?: string | null } | null = null;
        const byAuth = await supabase
          .from("profiles")
          .select("phone, full_name")
          .eq("auth_user_id", user.userId)
          .maybeSingle();
        data = byAuth.data;
        if (!data) {
          const byId = await supabase
            .from("profiles")
            .select("phone, full_name")
            .eq("id", user.userId)
            .maybeSingle();
          data = byId.data;
        }
        if (data?.phone) setPhone(data.phone);
        if (data?.full_name && !fullName) {
          const fn = data.full_name.trim();
          if (fn && !roleLike.test(fn)) setFullName(fn);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [user, student?.fullName]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!user?.userId) return;
    setSaving(true);
    setEmailNote(null);
    try {
      const payload: Record<string, unknown> = { full_name: fullName.trim() };
      if (phone.trim()) payload.phone = phone.trim();
      const nextEmail = email.trim().toLowerCase();
      const prevEmail = (user.email || "").trim().toLowerCase();
      if (nextEmail && nextEmail !== prevEmail) {
        const { error: authErr } = await supabase.auth.updateUser({ email: nextEmail });
        if (authErr) throw authErr;
        payload.email = nextEmail;
        setEmailNote(
          "Check your inbox to confirm the new email if Supabase asks for verification.",
        );
      }
      const { error: upErr } = await supabase
        .from("profiles")
        .update(payload as never)
        .eq("auth_user_id", user.userId);
      if (upErr) {
        const { error: up2 } = await supabase
          .from("profiles")
          .update({ full_name: fullName.trim() } as never)
          .eq("auth_user_id", user.userId);
        if (up2) throw up2;
      }
      await qc.invalidateQueries({ queryKey: ["session-user"] });
      await qc.invalidateQueries({ queryKey: ["student-context"] });
      toast.success(
        nextEmail && nextEmail !== prevEmail
          ? "Profile saved. Confirm the new email if required."
          : "Profile saved",
      );
    } catch (err) {
      toast.error(friendlyError(err, "Could not save profile"));
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading profile…
      </div>
    );
  }

  if (error || !user) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
        Could not load profile.
      </div>
    );
  }

  const isSuperAdmin = user.roles?.includes("super_admin");
  const statusLabel = (user.status || "active").toLowerCase();
  const avatar = initials(user.fullName || user.email || "U");
  const primaryRole = user.roles?.[0] || "student";

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-8">
      <div className="space-y-4">
        <SectionCard title="Your profile" description={school?.name || undefined}>
          <div className="flex flex-col items-center gap-3 border-b border-slate-100 px-4 pb-4 pt-2 sm:flex-row sm:items-start sm:gap-4 sm:px-5">
            <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#0b1b3a] to-[#1e3a5f] text-lg font-bold text-white shadow-md">
              {avatar}
            </div>
            <div className="min-w-0 flex-1 text-center sm:text-left">
              <p className="truncate text-lg font-bold text-slate-900">
                {user.fullName || "User"}
              </p>
              <p className="truncate text-sm text-slate-500">{user.email}</p>
              <RoleBadge roleKey={primaryRole} />
            </div>
          </div>

          <div className="px-4 pb-4 pt-1 sm:px-5 sm:pb-5">
            {!isSuperAdmin ? (
              <ProfileField
                label={user.identifierLabel || "Matric number"}
                value={user.identifier || student?.matric || "—"}
              />
            ) : null}
            <ProfileField label="Email" value={user.email || "—"} />
            <ProfileField
              label="Status"
              value={
                <span className="inline-flex items-center gap-1.5 capitalize">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      statusLabel === "active" ? "bg-emerald-500" : "bg-slate-400",
                    )}
                    aria-hidden
                  />
                  {statusLabel}
                </span>
              }
            />
            {user.schoolCode && !isSuperAdmin ? (
              <ProfileField label="School code" value={user.schoolCode} />
            ) : null}
            {student?.departmentName ? (
              <ProfileField label="Department" value={student.departmentName} />
            ) : null}
            {student?.facultyName ? (
              <ProfileField label="Faculty / College" value={student.facultyName} />
            ) : null}
            {student?.levelName ? <ProfileField label="Level" value={student.levelName} /> : null}
            {student?.sessionName ? (
              <ProfileField label="Session" value={student.sessionName} />
            ) : null}
            {student?.semesterName ? (
              <ProfileField label="Semester" value={student.semesterName} />
            ) : null}
          </div>
        </SectionCard>

        <SectionCard
          title="Edit details"
          description="Only fields you are allowed to change are editable"
        >
          <form className="grid gap-3 sm:grid-cols-2 sm:gap-4" onSubmit={save}>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="fn">Full name</Label>
              <Input
                id="fn"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="w-full"
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full text-xs sm:text-sm"
                autoComplete="email"
              />
              {emailNote ? (
                <p className="text-[11px] text-amber-600">{emailNote}</p>
              ) : (
                <p className="text-[11px] text-slate-500">
                  Changing email may require confirming the new address from your inbox.
                </p>
              )}
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="phone">Phone number</Label>
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Optional phone"
                className="w-full"
              />
            </div>
            <div className="space-y-1.5 min-w-0 sm:col-span-2">
              <Label htmlFor="ident">{user.identifierLabel || "Matric number"}</Label>
              <Input
                id="ident"
                value={user.identifier || student?.matric || "—"}
                readOnly
                className="w-full bg-slate-50 text-xs sm:text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={saving} className={cn("w-full font-semibold sm:w-auto")}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save profile
              </Button>
            </div>
          </form>
        </SectionCard>
      </div>
    </div>
  );
}
