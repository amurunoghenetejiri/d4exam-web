import { createFileRoute } from "@tanstack/react-router";
import { CourseMaterialsPanel } from "@/components/materials/CourseMaterialsPanel";
import { EmptyState } from "@/components/dashboard/kit";
import { useStudentContext } from "@/lib/student";
import { shortDisplayName } from "@/lib/utils";

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
  const { data: student, isLoading } = useStudentContext();

  if (isLoading) return <p className="text-sm text-slate-500">Loading…</p>;

  if (!student) {
    return (
      <EmptyState
        title="Student profile not found"
        description="Ask School Admin to add you under Academic Structure."
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
