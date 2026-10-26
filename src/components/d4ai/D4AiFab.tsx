import { useNavigate, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const LOGO = "/d4ai-avatar.png";

/** Floating action button → D4AI chat (robot icon + soft float animation) */
export function D4AiFab({
  className,
  label = "D4AI",
  from,
}: {
  className?: string;
  label?: string;
  /** Where the user opened from — used for back navigation on D4AI */
  from?: "messages" | "materials" | "menu";
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const resolvedFrom =
    from ||
    (pathname.includes("/messages")
      ? "messages"
      : pathname.includes("/materials")
        ? "materials"
        : "menu");

  return (
    <button
      type="button"
      onClick={() =>
        navigate({
          to: "/student/d4ai",
          search: { from: resolvedFrom },
        })
      }
      className={cn(
        "d4-fab-float fixed z-40 flex items-center gap-2 rounded-full",
        "bg-gradient-to-r from-cyan-600 via-blue-600 to-indigo-700 text-white",
        "shadow-lg shadow-cyan-900/45",
        "px-3.5 py-2.5 text-sm font-semibold",
        "active:scale-95 transition-transform",
        "bottom-20 right-4 sm:bottom-6 sm:right-6",
        "border border-white/25",
        className,
      )}
      aria-label="Open D4AI"
    >
      <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-white/15 ring-2 ring-cyan-300/40">
        <img src={LOGO} alt="" className="h-8 w-8 rounded-full object-cover" />
      </span>
      <span>{label}</span>
      <style>{`
        @keyframes d4FabFloat {
          0%, 100% { transform: translateY(0); box-shadow: 0 10px 25px rgba(37,99,235,.35); }
          50% { transform: translateY(-4px); box-shadow: 0 16px 34px rgba(34,211,238,.5); }
        }
        .d4-fab-float { animation: d4FabFloat 2.6s ease-in-out infinite; }
      `}</style>
    </button>
  );
}
