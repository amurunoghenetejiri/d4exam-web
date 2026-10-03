import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Mail, Phone, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { submitSupportMessage } from "@/lib/support.server";

const SUPPORT_EMAIL = "amurundestiny@gmail.com";
const SUPPORT_PHONE = "08165906606";

const CATEGORIES = [
  "Technical Problem",
  "Examination Problem",
  "Account Problem",
  "Result Problem",
  "Payment/School Problem",
  "Other",
] as const;

const faqs = [
  {
    q: "A candidate lost connection mid-examination. What happens?",
    a: "Answers are saved continuously. When the connection returns, the candidate resumes at the same question with the remaining time intact.",
  },
  {
    q: "How do we reset a candidate's password?",
    a: "School administrators can reset any candidate password from Admin → Students → Edit Student. Candidates can also use the Forgot Password page.",
  },
  {
    q: "Can results be released automatically?",
    a: "Yes. Each examination has result settings that control instant release, or release only after examination officer approval.",
  },
  {
    q: "Which file formats are supported for student import?",
    a: "CSV and Excel (.xlsx). Download the official template from Admin → Student Import to avoid validation errors.",
  },
];

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: "Contact & Support — D4EXAM" },
      {
        name: "description",
        content:
          "Get help with examinations, accounts, imports and result publication from the D4EXAM support team.",
      },
      { property: "og:title", content: "Contact & Support — D4EXAM" },
      {
        property: "og:description",
        content:
          "Get help with examinations, accounts, imports and result publication from the D4EXAM support team.",
      },
    ],
    links: [
      { rel: "canonical", href: "https://d4exam.name.ng/support" },
    ],
  }),
  component: Page,
});

function Page() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [school, setSchool] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<string>("Technical Problem");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || sent) return;
    const sub = subject.trim();
    const msg = message.trim();
    if (!name.trim() || !email.trim()) {
      toast.error("Name and email are required.");
      return;
    }
    if (!sub) {
      toast.error("Subject is required.");
      return;
    }
    if (msg.length < 5) {
      toast.error("Please describe the issue in more detail.");
      return;
    }
    setBusy(true);
    try {
      const result = await submitSupportMessage({
        data: {
          subject: sub,
          message: msg,
          category,
          name: name.trim(),
          email: email.trim(),
          school: school.trim() || undefined,
          route: "/support",
        },
      });
      if (!result?.ok) {
        toast.error(result?.error || "Could not send. Try emailing us directly.");
        return;
      }
      setSent(true);
      toast.success("Support request submitted. We will respond by email.");
      setSubject("");
      setMessage("");
    } catch (err) {
      console.error("[support]", err);
      toast.error("Could not send support message. Please try again or use the email below.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <div className="mx-auto w-full max-w-[1100px] px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-extrabold sm:text-4xl">Contact & Support</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Candidates should contact their school administrator first. Institutional staff and users can
          reach the D4EXAM team using the form below or the contact channels.
        </p>
        <div className="mt-10 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <form className="surface-panel space-y-4 p-6" onSubmit={(e) => void onSubmit(e)}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Full name</Label>
                <Input
                  id="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Grace Okonkwo"
                  disabled={busy || sent}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@school.edu"
                  disabled={busy || sent}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="school">School / Institution code</Label>
              <Input
                id="school"
                value={school}
                onChange={(e) => setSchool(e.target.value)}
                placeholder="ESU"
                disabled={busy || sent}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select value={category} onValueChange={setCategory} disabled={busy || sent}>
                <SelectTrigger id="category">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Candidate cannot access CSC101 exam"
                disabled={busy || sent}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="message">Message</Label>
              <Textarea
                id="message"
                required
                rows={6}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe the issue, including matric numbers and the examination affected."
                disabled={busy || sent}
              />
            </div>
            <Button type="submit" disabled={busy || sent}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending…
                </>
              ) : sent ? (
                "Request sent"
              ) : (
                "Submit request"
              )}
            </Button>
            {sent ? (
              <p className="text-sm text-emerald-700">
                Your message was delivered to {SUPPORT_EMAIL}. We will reply by email.
              </p>
            ) : null}
          </form>
          <div className="space-y-6">
            <div className="surface-panel p-6">
              <h2 className="text-base font-semibold">Contact channels</h2>
              <ul className="mt-3 space-y-3 text-sm text-muted-foreground">
                <li>
                  <a
                    className="flex items-center gap-2 hover:text-primary"
                    href={`mailto:${SUPPORT_EMAIL}`}
                  >
                    <Mail className="h-4 w-4 text-primary" aria-hidden /> {SUPPORT_EMAIL}
                  </a>
                </li>
                <li>
                  <a className="flex items-center gap-2 hover:text-primary" href={`tel:${SUPPORT_PHONE}`}>
                    <Phone className="h-4 w-4 text-primary" aria-hidden /> {SUPPORT_PHONE}
                  </a>
                </li>
                <li className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-primary" aria-hidden /> 24/7 during examination periods
                </li>
              </ul>
            </div>
            <div className="surface-panel p-6">
              <h2 className="text-base font-semibold">Common questions</h2>
              <Accordion type="single" collapsible className="mt-2">
                {faqs.map((f, i) => (
                  <AccordionItem key={f.q} value={`i${i}`}>
                    <AccordionTrigger className="text-left text-sm">{f.q}</AccordionTrigger>
                    <AccordionContent className="text-sm text-muted-foreground">{f.a}</AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
