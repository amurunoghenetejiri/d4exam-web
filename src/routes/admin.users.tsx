import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, SectionCard, StatusBadge, EmptyState } from "@/components/dashboard/kit";
import { useSessionUser } from "@/lib/session";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin/users")({
  head: () => ({
    meta: [
      { title: "Users — D4EXAM" },
      { name: "description", content: "All staff and candidate accounts in your institution." },
    ],
  }),
  component: Page,
});

type UserRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  status: string | null;
  school_id?: string | null;
};

function Page() {
  const { data: user } = useSessionUser();
  const schoolId = user?.schoolId ?? null;

  const listQ = useQuery({
    queryKey: ["admin-users", schoolId],
    enabled: Boolean(schoolId),
    staleTime: 15_000,
    queryFn: async () => {
      if (!schoolId) return [] as UserRow[];
      const selects = [
        "id, full_name, email, status, school_id",
        "id, full_name, email, status",
        "id, full_name, email",
      ];
      for (const sel of selects) {
        const { data, error } = await supabase
          .from("profiles")
          .select(sel)
          .eq("school_id", schoolId)
          .order("full_name", { ascending: true, nullsFirst: false })
          .limit(2000);
        if (!error) return (data ?? []) as UserRow[];
      }
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email, status")
        .eq("school_id", schoolId)
        .limit(2000);
      if (error) {
        console.warn("[admin-users]", error);
        return [];
      }
      return (data ?? []) as UserRow[];
    },
  });

  const rows = listQ.data ?? [];

  return (
    <>
      <PageHeader
        title="Users"
        description="All staff and candidate accounts in your institution."
      />
      <SectionCard title={`Users (${rows.length})`}>
        {listQ.isLoading ? (
          <p className="text-sm text-slate-500">Loading users…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No users yet"
            description="Students, teachers, and officers appear here once added to your school."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Email</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="py-2.5 pr-3 text-slate-500">{i + 1}</td>
                    <td className="py-2.5 pr-3 font-semibold text-slate-900">
                      {(r.full_name || "").trim() || "—"}
                    </td>
                    <td className="py-2.5 pr-3 text-slate-600">{(r.email || "").trim() || "—"}</td>
                    <td className="py-2.5">
                      <StatusBadge status={String(r.status || "active")} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
