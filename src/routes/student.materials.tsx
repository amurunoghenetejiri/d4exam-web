import { createFileRoute } from "@tanstack/react-router";
import { CourseMaterialsPanel } from "@/components/materials/CourseMaterialsPanel";
import { EmptyState } from "@/components/dashboard/kit";
import { useStudentContext } from "@/lib/student";
import { useSessionUser } from "@/lib/session";
import { shortDisplayName } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/student/materials")({
  head: () => ({
    meta: [
      { title: "Course materials — D4EXAM" },
      {
        name: "description",
        content: "Notes, assignments, and study resources for your courses.",
      },
    ],
  }),
  component: Page,
});

function Page() {
  const { data: session, isLoading: sessionLoading } = useSessionUser();
  const { data: student, isLoading, isFetching, error } = useStudentContext();

  if (sessionLoading || (isLoading && !student)) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading materials…
      </div>
    );
  }

  // Soft fallback: session exists but student row still linking
  if (!student) {
    if (session?.userId) {
      const courses: { id: string; code: string; name: string }[] = [];
      return (
        <div className="space-y-3">
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Your student record is still syncing. You can open materials once courses are linked.
            {error ? ` (${String((error as Error)?.message || error)})` : ""}
            {isFetching ? " Retrying…" : ""}
          </p>
          <CourseMaterialsPanel
            role="student"
            schoolId={session.schoolId || ""}
            courses={courses}
            displayName={shortDisplayName(session.fullName || session.email || "Student")}
          />
        </div>
      );
    }
    return (
      <EmptyState
        title="Could not load materials"
        description="Sign in again, or ask School Admin to link your student profile."
      />
    );
  }

  const courses = (student.courses ?? []).map((c) => ({
    id: c.id,
    code: c.code ?? "",
    name: c.name ?? "Course",
  }));

  return (
    <CourseMaterialsPanel
      role="student"
      schoolId={student.schoolId}
      courses={courses}
      displayName={shortDisplayName(student.fullName || student.matric || "Student")}
    />
  );
}
