import { useEffect } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, SectionCard, StatusBadge, EmptyState, NavCard } from "@/components/dashboard/kit";
import { Button } from "@/components/ui/button";
import { GraduationCap, Users, BookOpen, FileText, Bell } from "lucide-react";
import { useRows } from "@/lib/queries";
import { useSessionUser } from "@/lib/session";
import { getSchoolDashboardCounts } from "@/lib/student.server";
import { processWeeklyAggregationSummaries, processDueExamReminders } from "@/lib/notify";

export const Route = createFileRoute("/admin/")({
  head: () => ({
    meta: [{ title: "School Admin Dashboard — D4EXAM" }],
  }),
  component: Page,
});

type Exam = {
  id: string;
  title: string;
  status: string;
  scheduled_start: string | null;
  duration_minutes: number;
};

type Notif = {
  id: string;
  title: string;
  created_at: string;
};

function Page() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;
  const enabled = Boolean(schoolId);

  useEffect(() => {
    if (!schoolId) return;
    const t = window.setTimeout(() => {
      void processDueExamReminders(schoolId);
      void processWeeklyAggregationSummaries(schoolId);
    }, 4000);
    return () => window.clearTimeout(t);
  }, [schoolId]);

  const countsQ = useQuery({
    queryKey: ["school-dashboard-counts", schoolId],
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!schoolId) return { students: 0, teachers: 0, courses: 0, examinations: 0 };
      return getSchoolDashboardCounts({ data: { schoolId } });
    },
  });
  const students = { isLoading: countsQ.isLoading, data: countsQ.data?.students };
  const teachers = { isLoading: countsQ.isLoading, data: countsQ.data?.teachers };
  const courses = { isLoading: countsQ.isLoading, data: countsQ.data?.courses };
  const exams = { isLoading: countsQ.isLoading, data: countsQ.data?.examinations };

  const todayExams = useRows<Exam>({
    table: "examinations",
    select: "id, title, status, scheduled_start, duration_minutes",
    filters: schoolId ? [{ column: "school_id", value: schoolId }] : [],
    order: { column: "scheduled_start", ascending: true },
    limit: 6,
    enabled,
  });

  const notifications = useRows<Notif>({
    table: "notifications",
    select: "id, title, created_at",
    filters: user?.userId ? [{ column: "recipient_user_id", value: user.userId }] : [],
    order: { column: "created_at", ascending: false },
    limit: 5,
    enabled: Boolean(user?.userId),
  });

  return (
    <>
      <PageHeader
        title={`Welcome back${user?.fullName ? `, ${user.fullName}` : ""}`}
        description={user?.schoolName ? `${user.schoolName} · School admin` : "School admin dashboard"}
      />

      {!schoolId && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Your account is not linked to a school yet. Counts stay at zero until a school is assigned.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4">
        <Stat to="/admin/students" label="Total Students" value={fmt(students)} icon={GraduationCap} />
        <Stat to="/admin/teachers" label="Total Teachers" value={fmt(teachers)} icon={Users} />
        <Stat to="/admin/courses" label="Total Courses" value={fmt(courses)} icon={BookOpen} />
        <Stat to="/admin/examinations" label="Total Exams" value={fmt(exams)} icon={FileText} />
      </div>

      <div className="mt-4 grid gap-4 sm:mt-6 sm:gap-6 lg:grid-cols-2">
        <SectionCard
          title="Examinations"
          action={
            <Button variant="ghost" size="sm" className="font-semibold text-primary" asChild>
              <Link to="/admin/examinations">View All</Link>
            </Button>
          }
        >
          {(todayExams.data ?? []).length === 0 ? (
            <EmptyState title="No examinations" description="Exams created for this school will appear here." />
          ) : (
            <ul className="max-h-[14rem] space-y-1.5 overflow-y-auto overscroll-contain pr-0.5 sm:max-h-[18rem] lg:max-h-[24rem] sm:space-y-2">
              {(todayExams.data ?? []).map((e) => (
                <li key={e.id}>
                  <NavCard
                    to="/admin/examinations"
                    ariaLabel={`Open examinations · ${e.title}`}
                    className="flex items-center justify-between gap-2 rounded-lg border-slate-100 px-2.5 py-2 sm:rounded-xl sm:px-3 sm:py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-bold text-slate-900 sm:text-sm">{e.title}</p>
                      <p className="truncate text-[11px] text-slate-500 sm:text-xs">
                        {e.scheduled_start ? new Date(e.scheduled_start).toLocaleString() : "Not scheduled"} ·{" "}
                        {e.duration_minutes} min
                      </p>
                    </div>
                    <StatusBadge status={e.status} />
                  </NavCard>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Notifications"
          action={
            <Button variant="ghost" size="sm" className="font-semibold text-primary" asChild>
              <Link to="/admin/notifications">View All</Link>
            </Button>
          }
        >
          {(notifications.data ?? []).length === 0 ? (
            <EmptyState title="No notifications" description="System and school notices will appear here." />
          ) : (
            <ul className="max-h-[14rem] space-y-1.5 overflow-y-auto overscroll-contain pr-0.5 sm:max-h-[18rem] lg:max-h-[24rem] sm:space-y-2">
              {(notifications.data ?? []).map((n) => (
                <li key={n.id}>
                  <NavCard
                    to="/admin/notifications"
                    ariaLabel={n.title}
                    className="flex items-start gap-2 rounded-lg border-slate-100 px-2.5 py-2 sm:gap-3 sm:rounded-xl sm:px-3 sm:py-2.5"
                  >
                    <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary sm:h-4 sm:w-4" />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-slate-900 sm:text-sm">{n.title}</p>
                      <p className="text-[11px] text-slate-500 sm:text-xs">{new Date(n.created_at).toLocaleString()}</p>
                    </div>
                  </NavCard>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}

function fmt(q: { isLoading: boolean; data?: number }) {
  return q.isLoading ? "…" : String(q.data ?? 0);
}

function Stat({
  to,
  label,
  value,
  icon: Icon,
}: {
  to: string;
  label: string;
  value: string;
  icon: typeof GraduationCap;
}) {
  return (
    <NavCard to={to} ariaLabel={label}>
      <div className="flex items-start justify-between gap-1.5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold leading-tight text-slate-500 sm:text-xs">{label}</p>
          <p className="mt-0.5 text-lg font-extrabold tabular-nums text-slate-900 sm:mt-1 sm:text-2xl">{value}</p>
        </div>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-50 text-primary sm:h-9 sm:w-9 sm:rounded-xl">
          <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        </span>
      </div>
    </NavCard>
  );
}
