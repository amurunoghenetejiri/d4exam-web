import { Link, useNavigate } from "@tanstack/react-router";
import { appNavigate } from "@/lib/app-navigate";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { forceUnlockBody } from "@/lib/unlock-ui";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Watermark } from "@/components/brand/Watermark";
import { Button } from "@/components/ui/button";
import { LiteDrawer, useTapThrottle } from "@/components/ui/lite-drawer";
import { isAppLikeShell } from "@/native/platform";
import { cn } from "@/lib/utils";

const links = [
  { to: "/features", label: "Features" },
  { to: "/school-application", label: "For Schools" },
  { to: "/pricing", label: "Pricing" },
  { to: "/about", label: "About Us" },
  { to: "/support", label: "Support" },
] as const;

/** Mobile menu groups — Login is a button under Apply, not a text row. */
const menuGroups = [
  {
    title: "Platform",
    items: [
      { to: "/features", label: "Features" },
      { to: "/pricing", label: "Pricing" },
      { to: "/school-application", label: "For Schools" },
    ],
  },
  {
    title: "Company",
    items: [
      { to: "/about", label: "About Us" },
      { to: "/support", label: "Support" },
      { to: "/privacy", label: "Privacy Policy" },
    ],
  },
] as const;

export function PublicLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const tapThrottle = useTapThrottle(350);
  const navThrottle = useTapThrottle(350);
  const appShell = useMemo(() => {
    try {
      return isAppLikeShell();
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    forceUnlockBody();
  }, []);

  /** Close the drawer and navigate once — repeat taps within 350ms are ignored. */
  function goTo(to: string) {
    navThrottle(() => {
      setOpen(false);
      try {
        appNavigate(to);
      } catch {
        try {
          void navigate({ to: to as never });
        } catch {
          window.location.href = to;
        }
      }
    });
  }

  return (
    <div className="relative flex min-h-dvh flex-col bg-white">
      <Watermark opacity={0.1} size="xl" />

      <header className="d4-public-header fixed top-0 left-0 right-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center justify-between gap-4 px-4 sm:h-[4.5rem] sm:px-6">
          <Link to="/" aria-label="D4EXAM home" className="shrink-0">
            <span className="inline-flex lg:hidden">
              <Logo size="sm" wordmark />
            </span>
            <span className="hidden lg:inline-flex">
              <Logo size="md" />
            </span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
            {links.map((l) => (
              <Link
                key={l.label}
                to={l.to}
                className="rounded-md px-3 py-2 text-sm font-semibold text-primary/80 transition-colors hover:text-primary"
                activeProps={{ className: "text-primary" }}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="hidden shrink-0 items-center gap-2 lg:flex">
            <Button variant="ghost" size="sm" className="font-semibold text-primary" asChild>
              <Link to="/login">Login</Link>
            </Button>
            <Button size="sm" className="rounded-full px-5 font-semibold" asChild>
              <Link to="/school-application">Apply Now</Link>
            </Button>
          </div>

          <Button
            variant="outline"
            size="icon"
            className="d4-public-menu lg:hidden"
            aria-label="Open menu"
            onClick={() => tapThrottle(() => setOpen(true))}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <LiteDrawer
            open={open}
            onClose={() => setOpen(false)}
            side="right"
            label="Menu"
            className="w-[min(100%,20rem)] border-l border-slate-200 bg-white lg:hidden"
          >
              <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
                <Logo size="sm" />
                <Button variant="ghost" size="icon" aria-label="Close menu" onClick={() => setOpen(false)}>
                  <X className="h-5 w-5" />
                </Button>
              </div>
              <div className="flex max-h-[calc(100dvh-3.5rem)] flex-col overflow-y-auto p-4">
                {menuGroups.map((g) => (
                  <div key={g.title} className="mb-4">
                    <p className="mb-1.5 px-3 text-[11px] font-bold uppercase tracking-wide text-primary">
                      {g.title}
                    </p>
                    <div className="flex flex-col gap-0.5">
                      {g.items.map((l) => (
                        <button
                          key={l.label}
                          type="button"
                          className="rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-slate-700 hover:bg-slate-50 active:bg-slate-100"
                          onClick={() => goTo(l.to)}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="mt-2 space-y-2 border-t border-slate-100 pt-4">
                  <button
                    type="button"
                    onClick={() => goTo("/school-application")}
                    className={cn(
                      "inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground",
                      "hover:bg-primary/90 active:opacity-90",
                    )}
                  >
                    Apply Now
                  </button>
                  <button
                    type="button"
                    onClick={() => goTo("/login")}
                    className={cn(
                      "inline-flex h-10 w-full items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-semibold",
                      "hover:bg-accent hover:text-accent-foreground active:opacity-90",
                    )}
                  >
                    Login
                  </button>
                </div>
              </div>
          </LiteDrawer>
        </div>
      </header>
      <div className="d4-public-header-spacer h-14 shrink-0 sm:h-[4.5rem]" aria-hidden />

      <main className="relative z-10 flex-1">{children}</main>

      {!appShell && (
        <footer className="relative z-10 border-t border-slate-200 bg-slate-50/95">
          <div className="mx-auto grid w-full max-w-[1180px] gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
            <div>
              <Logo size="md" showTagline />
              <p className="mt-4 max-w-xs text-sm text-slate-600">
                Professional examination management for schools, colleges and universities worldwide.
              </p>
            </div>
            <FooterCol
              title="Platform"
              items={[
                { to: "/features", label: "Features" },
                { to: "/pricing", label: "Pricing" },
                { to: "/school-application", label: "For Schools" },
              ]}
            />
            <FooterCol
              title="Company"
              items={[
                { to: "/about", label: "About Us" },
                { to: "/support", label: "Support" },
                { to: "/privacy", label: "Privacy Policy" },
              ]}
            />
            <FooterCol title="Access" items={[{ to: "/login", label: "Login" }]} />
          </div>
          <div className="border-t border-slate-200">
            <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-1 px-4 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p>© 2026 D4EXAM. All rights reserved.</p>
              <p>Smart. Secure. Seamless.</p>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

function FooterCol({ title, items }: { title: string; items: { to: string; label: string }[] }) {
  return (
    <div>
      <p className="text-sm font-bold text-primary">{title}</p>
      <ul className="mt-3 space-y-2">
        {items.map((it) => (
          <li key={it.to}>
            <Link to={it.to} className="text-sm text-slate-600 hover:text-primary">
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
