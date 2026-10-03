import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { OfficerResultsPage } from "@/components/officer/OfficerResultsPage";
import { ResultsRecordsPage } from "@/components/results/ResultsRecordsPage";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/officer/results")({
  head: () => ({ meta: [{ title: "Results — D4EXAM" }] }),
  component: Page,
  errorComponent: ResultsSoftError,
});

function Page() {
  const [tab, setTab] = useState<"records" | "release">("records");
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setTab("records")}
          className={cn(
            "rounded-full px-4 py-1.5 text-sm font-semibold transition",
            tab === "records" ? "bg-primary text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
          )}
        >
          Result records
        </button>
        <button
          type="button"
          onClick={() => setTab("release")}
          className={cn(
            "rounded-full px-4 py-1.5 text-sm font-semibold transition",
            tab === "release" ? "bg-primary text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200",
          )}
        >
          Release / integrity
        </button>
      </div>
      {tab === "records" ? (
        <ResultsRecordsPage
          title="Result Records"
          description="Department-scoped results only. Filter, print and export. Student rows show current level (including carryovers)."
        />
      ) : (
        <OfficerResultsPage />
      )}
    </div>
  );
}

function ResultsSoftError({ error, reset }: { error: Error; reset: () => void }) {
  console.error("[officer/results]", error);
  return (
    <div className="mx-auto flex min-h-[40vh] max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-base font-bold text-slate-900">Results page could not load</p>
      <p className="text-sm text-slate-500">You can retry or return to the officer dashboard.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Try again
        </button>
        <Link
          to="/officer"
          className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800"
        >
          Officer home
        </Link>
      </div>
    </div>
  );
}
