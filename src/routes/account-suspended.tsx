import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/session";

export const Route = createFileRoute("/account-suspended")({
  head: () => ({ meta: [{ title: "Account suspended — D4EXAM" }] }),
  component: Page,
});

function Page() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">
        <div className="bg-primary px-6 py-5 text-center text-white">
          <p className="text-xs font-bold uppercase tracking-wide text-white/70">D4EXAM</p>
          <h1 className="mt-1 text-xl font-extrabold">Account suspended</h1>
        </div>
        <div className="space-y-4 px-6 py-6 text-center">
          <p className="text-sm text-slate-600">
            Your account has been suspended by your school administrator. You cannot access
            dashboards, exams, or school tools until access is restored.
          </p>
          <p className="text-xs text-slate-400">
            If you believe this is a mistake, contact your school admin.
          </p>
          <div className="flex flex-col gap-2 pt-2">
            <Button type="button" className="w-full font-semibold" onClick={() => void signOut()}>
              Sign out
            </Button>
            <Button type="button" variant="outline" className="w-full font-semibold" asChild>
              <Link to="/login">Back to sign in</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
