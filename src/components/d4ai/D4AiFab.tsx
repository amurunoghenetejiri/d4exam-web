import { useNavigate } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/** Floating action button → D4AI chat */
export function D4AiFab({
  className,
  label = "D4AI",
}: {
  className?: string;
  label?: string;
}) {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => navigate({ to: "/student/d4ai" })}
      className={cn(
        "fixed z-40 flex items-center gap-2 rounded-full",
        "bg-gradient-to-r from-cyan-600 to-blue-700 text-white",
        "shadow-lg shadow-cyan-900/40",
        "px-4 py-3 text-sm font-semibold",
        "active:scale-95 transition-transform",
        "bottom-20 right-4 sm:bottom-6 sm:right-6",
        "border border-white/20",
        className,
      )}
      aria-label="Open D4AI"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15">
        <Sparkles className="h-4 w-4" />
      </span>
      <span>{label}</span>
    </button>
  );
}
