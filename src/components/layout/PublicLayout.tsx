import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/features", label: "Features" },
  { to: "/pricing", label: "Pricing" },
  { to: "/about", label: "About" },
  { to: "/support", label: "Support" },
] as const;

export function PublicLayout({ children, className }: { children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("flex min-h-dvh flex-col bg-white", className)}>
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
          <Link to="/" className="shrink-0" aria-label="D4EXAM home">
            <Logo size="md" wordmark />
          </Link>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" className="hidden sm:inline-flex">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button asChild className="hidden sm:inline-flex">
              <Link to="/register">Get started</Link>
            </Button>
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="md:hidden"
                  aria-label="Open menu"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[min(100vw-2rem,18rem)] p-0">
                <SheetTitle className="sr-only">Menu</SheetTitle>
                <div className="flex h-14 items-center justify-between border-b px-4">
                  <Logo size="sm" wordmark />
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="grid h-9 w-9 place-items-center rounded-full hover:bg-slate-100"
                    aria-label="Close"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <nav className="flex flex-col gap-1 p-3" aria-label="Mobile">
                  {NAV.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setOpen(false)}
                      className="rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      {item.label}
                    </Link>
                  ))}
                  <Link
                    to="/login"
                    onClick={() => setOpen(false)}
                    className="mt-2 rounded-lg bg-slate-900 px-3 py-2.5 text-center text-sm font-semibold text-white"
                  >
                    Sign in
                  </Link>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo size="sm" wordmark />
          <p className="text-xs text-slate-500">© {new Date().getFullYear()} D4EXAM. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
