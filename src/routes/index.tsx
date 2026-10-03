import { createFileRoute, Link, redirect, isRedirect } from "@tanstack/react-router";
import {
  ShieldCheck,
  Gauge,
  BarChart3,
  Globe2,
  Lock,
  Eye,
  FileCheck2,
  Users,
  GraduationCap,
  ClipboardCheck,
  Building2,
  ArrowRight,
  CheckCircle2,
  Check,
} from "lucide-react";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { Button } from "@/components/ui/button";
import { fetchSessionUser, roleHome, readLastPath, readLastRole, readPreferredRole, type AppRole } from "@/lib/session";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "D4EXAM — Smart, Secure Online Examination Platform for Schools" },
      {
        name: "description",
        content:
          "D4EXAM lets schools, colleges and universities conduct secure CBT examinations, manage students, build question banks, automate marking and publish results.",
      },
    ],
  }),
  beforeLoad: async () => {
    try {
      // Prefer cached role/path so Capacitor relaunch does not flash marketing home
      const lastRole = readLastRole() || readPreferredRole();
      const last = readLastPath();
      if (lastRole && roleHome[lastRole as AppRole]) {
        const home = roleHome[lastRole as AppRole];
        // Always land on role dashboard home (not a deep exam page) on cold start
        throw redirect({ to: home as never });
      }
      if (last && last !== "/" && !last.startsWith("/login") && !last.startsWith("/about") && !last.startsWith("/pricing") && !last.startsWith("/privacy") && !last.startsWith("/support") && !last.startsWith("/features")) {
        const rolePrefix = ["student", "teacher", "officer", "admin", "super-admin"].find((r) => last.startsWith(`/${r}`));
        if (rolePrefix) {
          const home = rolePrefix === "officer" ? "/officer" : rolePrefix === "admin" ? "/admin" : rolePrefix === "super-admin" ? "/super-admin" : `/${rolePrefix}`;
          throw redirect({ to: home as never });
        }
      }
      const session = await fetchSessionUser();
      if (session?.role && session.role in roleHome) {
        throw redirect({ to: roleHome[session.role as AppRole] as never });
      }
    } catch (e) {
      if (isRedirect(e)) throw e;
      if (e && typeof e === "object" && ("to" in e || "isRedirect" in e)) throw e;
    }
  },
  component: HomePage,
});

const features = [
  { icon: Gauge, title: "Fast CBT Delivery", body: "Low-latency exam sessions that work on everyday devices and modest bandwidth." },
  { icon: ShieldCheck, title: "Exam Integrity", body: "Fullscreen lockdown, tab monitoring, randomised questions and officer oversight." },
  { icon: BarChart3, title: "Powerful Analytics", body: "Detailed reports and analytics for better decisions." },
  { icon: Globe2, title: "Anywhere Access", body: "Access the platform from any device, anytime." },
];

const steps = [
  { n: "01", title: "Register your institution", body: "Submit a school application and receive your institution code." },
  { n: "02", title: "Set up academics", body: "Import students, faculties, departments, levels and courses." },
  { n: "03", title: "Build examinations", body: "Create question banks, schedule exams and set security rules." },
  { n: "04", title: "Deliver and publish", body: "Candidates sit CBT, marking is automated and results go live." },
];

const security = [
  { icon: Lock, title: "Fullscreen lockdown", body: "Candidates stay inside the examination window." },
  { icon: Eye, title: "Tab & focus monitoring", body: "Every switch is recorded against a threshold." },
  { icon: FileCheck2, title: "Randomised delivery", body: "Question and option shuffling reduces collusion." },
  { icon: ShieldCheck, title: "Integrity timeline", body: "Officers review a full audit trail per attempt." },
];

const roles = [
  { icon: GraduationCap, title: "Students", body: "Sit examinations, track courses and view results." },
  { icon: Users, title: "Teachers", body: "Build question banks, create exams and mark scripts." },
  { icon: Building2, title: "School Admins", body: "Manage users, academics and institutional reports." },
  { icon: ClipboardCheck, title: "Exam Officers", body: "Approve exams, monitor live sessions and integrity." },
];

const plans = [
  {
    name: "Starter",
    audience: "Technical schools & academies",
    price: "₦45,000",
    period: "/term",
    features: ["Up to 500 students", "Unlimited MCQ exams", "Basic integrity logs", "Email support"],
    cta: "Get Started",
    highlight: false,
  },
  {
    name: "Professional",
    audience: "Colleges & polytechnics",
    price: "₦120,000",
    period: "/term",
    features: [
      "Up to 5,000 students",
      "Question bank & marking center",
      "Live officer monitor",
      "Priority support",
    ],
    cta: "Get Started",
    highlight: true,
  },
  {
    name: "Enterprise",
    audience: "Universities & multi-campus",
    price: "Custom",
    period: "",
    features: ["Unlimited scale", "Custom integrations", "Dedicated success manager", "SLA & training"],
    cta: "Contact us",
    highlight: false,
  },
];

function HomePage() {
  return (
    <PublicLayout>
      <section className="relative min-h-[min(88vh,720px)] w-full overflow-hidden">
        <img
          src="https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=1920&q=85"
          alt="Students using laptops for online examination"
          className="absolute inset-0 h-full w-full object-cover"
          loading="eager"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#0b1b3a]/95 via-[#0b1b3a]/75 to-[#0b1b3a]/40" />
        <div className="relative mx-auto flex min-h-[min(88vh,720px)] w-full max-w-[1180px] items-center px-4 py-16 sm:px-6">
          <div className="max-w-2xl text-white">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-blue-200">
              Smart. Secure. Seamless.
            </p>
            <h1 className="text-3xl font-extrabold leading-tight sm:text-4xl lg:text-5xl">
              Smart Examination Management for Every Institution
            </h1>
            <p className="mt-4 text-base leading-relaxed text-slate-200 sm:text-lg">
              Conduct exams, manage students, create questions, automate marking and publish results
              seamlessly — for universities, polytechnics, colleges and technical schools.
            </p>
            <div className="mt-8 flex flex-row flex-nowrap items-center gap-2 sm:gap-3">
              <Button
                size="lg"
                className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold sm:h-12 sm:px-7 sm:text-base"
                asChild
              >
                <Link to="/school-application">
                  Apply — Full school
                  <ArrowRight className="ml-1.5 h-4 w-4 sm:ml-2" />
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-11 shrink-0 rounded-full border-white/40 bg-white/10 px-4 text-sm font-semibold text-white hover:bg-white/20 hover:text-white sm:h-12 sm:px-7 sm:text-base"
                asChild
              >
                <Link to="/school-application?type=trial">Start Trial / Demo</Link>
              </Button>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-200">
              {["No installation required", "Works on low bandwidth", "Institution-grade security"].map(
                (i) => (
                  <li key={i} className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-300" />
                    {i}
                  </li>
                ),
              )}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-100 bg-slate-50/80">
        <div className="mx-auto grid w-full max-w-[1180px] gap-4 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-primary">
                <f.icon className="h-5 w-5" />
              </span>
              <h3 className="mt-4 text-base font-bold text-slate-900">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-14 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">How D4EXAM works</h2>
            <p className="mt-2 text-slate-600">From application to live results in four clear steps.</p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((s) => (
              <div key={s.n} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-5">
                <p className="font-mono text-xs font-bold text-primary">{s.n}</p>
                <h3 className="mt-2 text-base font-bold text-slate-900">{s.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-slate-100 bg-slate-50/60">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-14 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Built for exam integrity</h2>
            <p className="mt-2 text-slate-600">Practical controls that officers and invigilators actually use.</p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {security.map((s) => (
              <div key={s.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                  <s.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-bold text-slate-900">{s.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-14 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Roles that fit your campus</h2>
            <p className="mt-2 text-slate-600">Everyone has a clear workspace — no shared passwords, no confusion.</p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {roles.map((r) => (
              <div key={r.title} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-5">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-900 text-white">
                  <r.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-base font-bold text-slate-900">{r.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{r.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-slate-100 bg-slate-50/80">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-14 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Simple plans</h2>
            <p className="mt-2 text-slate-600">Start small or scale campus-wide. Trial / Demo available for evaluation.</p>
          </div>
          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {plans.map((p) => (
              <div
                key={p.name}
                className={
                  p.highlight
                    ? "rounded-2xl border-2 border-primary bg-white p-6 shadow-md ring-2 ring-primary/20"
                    : "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                }
              >
                <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{p.audience}</p>
                <h3 className="mt-1 text-xl font-extrabold text-slate-900">{p.name}</h3>
                <p className="mt-3 text-3xl font-extrabold text-slate-900">
                  {p.price}
                  <span className="text-base font-medium text-slate-500">{p.period}</span>
                </p>
                <ul className="mt-5 space-y-2">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-slate-700">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  <Button className="w-full font-semibold" variant={p.highlight ? "default" : "outline"} asChild>
                    <Link to={p.name === "Enterprise" ? "/support" : "/school-application"}>{p.cta}</Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white">
        <div className="mx-auto w-full max-w-[1180px] px-4 py-14 sm:px-6">
          <div className="flex flex-col items-start gap-6 rounded-2xl border border-blue-100 bg-blue-50/60 p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">
                Bring your examinations online — properly.
              </h2>
              <p className="mt-2 max-w-xl text-slate-600">
                Choose full school registration or a short Trial / Demo. Super admin reviews and activates you.
              </p>
            </div>
            <div className="flex shrink-0 flex-row flex-nowrap items-center gap-2 sm:gap-3">
              <Button size="lg" className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold sm:h-12 sm:px-6 sm:text-base" asChild>
                <Link to="/school-application">Apply — Full school</Link>
              </Button>
              <Button size="lg" variant="outline" className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold sm:h-12 sm:px-6 sm:text-base" asChild>
                <Link to="/school-application?type=trial">Start Trial / Demo</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
