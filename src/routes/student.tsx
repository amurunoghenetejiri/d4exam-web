import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { StudentLayout } from "@/layouts";
import { requireRole } from "@/lib/guard";
import { useStudentContext, useStudentRealtimeSync } from "@/lib/student";
import { StudentEmailCapture } from "@/components/student/StudentEmailCapture";
import { ExamCountdownBootstrap } from "@/components/ExamCountdownBootstrap";
import { D4AiFab } from "@/components/d4ai/D4AiFab";

export const Route = createFileRoute("/student")({
  ssr: false,
  beforeLoad: ({ context }) => requireRole("student", context.queryClient),
  component: Layout,
});

function Layout() {
  const { data: student } = useStudentContext();
  useStudentRealtimeSync(Boolean(student?.studentId));
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showD4AiFab =
    (pathname === "/student/messages" ||
      pathname.startsWith("/student/messages/") ||
      pathname === "/student/materials") &&
    !pathname.includes("/student/d4ai");

  return (
    <StudentLayout>
      <StudentEmailCapture />
      <ExamCountdownBootstrap />
      <Outlet />
      {showD4AiFab ? <D4AiFab /> : null}
    </StudentLayout>
  );
}
