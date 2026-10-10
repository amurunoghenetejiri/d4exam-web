import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

function schoolInitials(name?: string | null): string {
  const n = (name || "").trim();
  if (!n) return "SC";
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase().slice(0, 2);
  }
  return n.slice(0, 2).toUpperCase();
}

/**
 * School logo from DB URL only.
 * Never uses the D4EXAM app logo as the school mark — that stays for "Powered by" only.
 * Missing/broken logo → school initials badge.
 */
export function SchoolLogo({
  logoUrl,
  schoolName,
  className,
  size = "md",
  rounded = true,
  priority = false,
}: {
  logoUrl?: string | null;
  schoolName?: string | null;
  className?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  rounded?: boolean;
  priority?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [logoUrl]);
  const dims = {
    xs: "h-6 w-6",
    sm: "h-8 w-8",
    md: "h-10 w-10",
    lg: "h-14 w-14",
    xl: "h-20 w-20",
  }[size];
  const textSize = {
    xs: "text-[9px]",
    sm: "text-[10px]",
    md: "text-xs",
    lg: "text-sm",
    xl: "text-base",
  }[size];

  const showFallback = !(logoUrl && String(logoUrl).trim()) || failed;

  if (showFallback) {
    return (
      <span
        className={cn(
          dims,
          "inline-grid shrink-0 place-items-center bg-primary/10 font-extrabold text-primary",
          rounded && "rounded-lg",
          textSize,
          className,
        )}
        title={schoolName || "School"}
        aria-label={schoolName ? `${schoolName} logo` : "School"}
      >
        {schoolInitials(schoolName)}
      </span>
    );
  }

  return (
    <span
      className={cn(
        dims,
        "inline-grid shrink-0 place-items-center overflow-hidden",
        // Light checkerboard so transparent logos stay visible (never solid black)
        "bg-[length:10px_10px] bg-[linear-gradient(45deg,#e2e8f0_25%,transparent_25%,transparent_75%,#e2e8f0_75%,#e2e8f0),linear-gradient(45deg,#e2e8f0_25%,#f8fafc_25%,#f8fafc_75%,#e2e8f0_75%,#e2e8f0)] bg-[position:0_0,5px_5px]",
        rounded && "rounded-lg",
        className,
      )}
    >
      <img
        src={logoUrl}
        alt={schoolName ? `${schoolName} logo` : "School logo"}
        className="h-full w-full object-contain"
        style={{ backgroundColor: "transparent" }}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : undefined}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

/**
 * School identity first (logo + name). Platform mark is separate and optional.
 */
export function DualBrand({
  logoUrl,
  schoolName,
  className,
  showPlatform = true,
  size = "md",
}: {
  logoUrl?: string | null;
  schoolName?: string | null;
  className?: string;
  showPlatform?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <SchoolLogo logoUrl={logoUrl} schoolName={schoolName} size={size} className="bg-transparent" priority />
      {schoolName && (
        <span className="hidden min-w-0 truncate text-xs font-bold text-inherit sm:inline sm:max-w-[140px] md:max-w-[200px] lg:max-w-[240px]">
          {schoolName}
        </span>
      )}
      {showPlatform && (
        <>
          <span className="hidden h-6 w-px shrink-0 bg-current opacity-20 sm:block" aria-hidden />
          <img
            src="/logo.png"
            alt="D4EXAM"
            className="hidden h-6 w-auto shrink-0 object-contain bg-transparent opacity-90 sm:block"
            loading="eager"
          />
        </>
      )}
    </span>
  );
}
