import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import {
  ImagePlus,
  FileText,
  Loader2,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { d4aiChat } from "@/lib/d4ai.server";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/student/d4ai")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "D4AI — D4TECH" },
      {
        name: "description",
        content: "D4AI study assistant by Amurun Destiny under D4TECH.",
      },
    ],
  }),
  component: D4AiPage,
});

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  imagePreview?: string;
  docName?: string;
};

function D4AiPage() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: "hello",
      role: "assistant",
      content:
        "What's good? I'm **D4AI**, built by Amurun Destiny under **D4TECH**. Ask me anything about your studies — or attach an image / PDF and I'll help.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageB64, setImageB64] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [docText, setDocText] = useState<string | null>(null);
  const [docName, setDocName] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileImgRef = useRef<HTMLInputElement>(null);
  const fileDocRef = useRef<HTMLInputElement>(null);

  const scrollDown = () =>
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

  const onPickImage = (file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const r = String(reader.result || "");
      setImagePreview(r);
      setImageB64(r);
    };
    reader.readAsDataURL(file);
  };

  const onPickDoc = async (file: File | null) => {
    if (!file) return;
    const name = file.name;
    if (file.type === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
      // Best-effort text extraction is limited in browser; send name + note
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Extract crude ASCII strings from PDF for small files
      let raw = "";
      const max = Math.min(bytes.length, 400_000);
      for (let i = 0; i < max; i++) {
        const c = bytes[i];
        if (c >= 32 && c < 127) raw += String.fromCharCode(c);
        else if (c === 10 || c === 13) raw += "\n";
      }
      const cleaned = raw
        .replace(/\s+/g, " ")
        .replace(/[^\x20-\x7E\n]/g, " ")
        .slice(0, 30000);
      setDocName(name);
      setDocText(
        cleaned.length > 80
          ? cleaned
          : `[PDF attached: ${name}. Text could not be fully extracted in-browser — describe what you need from it.]`,
      );
      return;
    }
    // plain text / md
    const text = await file.text();
    setDocName(name);
    setDocText(text.slice(0, 40000));
  };

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !imageB64 && !docText) || busy) return;
    setError(null);
    setBusy(true);

    const userMsg: Msg = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text || (imageB64 ? "[Image]" : `[Document: ${docName}]`),
      imagePreview: imagePreview || undefined,
      docName: docName || undefined,
    };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    const imgs = imageB64 ? [imageB64] : undefined;
    const dText = docText || undefined;
    const dName = docName || undefined;
    setImageB64(null);
    setImagePreview(null);
    setDocText(null);
    setDocName(null);
    scrollDown();

    const history = [...messages, userMsg]
      .filter((m) => m.id !== "hello")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    try {
      const res = await d4aiChat({
        data: {
          messages: history.length
            ? history
            : [{ role: "user", content: userMsg.content }],
          images: imgs,
          documentText: dText,
          documentName: dName,
        },
      });

      if (!res.ok) {
        setError(res.error);
        setMessages((m) => [
          ...m,
          {
            id: `e-${Date.now()}`,
            role: "assistant",
            content: res.error || "Something went wrong.",
          },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: res.content,
          },
        ]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to reach D4AI";
      setError(msg);
      setMessages((m) => [
        ...m,
        { id: `e-${Date.now()}`, role: "assistant", content: msg },
      ]);
    } finally {
      setBusy(false);
      scrollDown();
    }
  }, [input, busy, imageB64, imagePreview, docText, docName, messages]);

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="border-b border-cyan-900/40 bg-gradient-to-r from-slate-900 via-slate-900 to-cyan-950 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-600/30 ring-1 ring-cyan-400/40">
            <Sparkles className="h-5 w-5 text-cyan-300" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-white">D4AI</h1>
            <p className="text-xs text-cyan-200/80">
              Amurun Destiny · D4TECH · Study · Build · Adapt
            </p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4">
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              "flex",
              m.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            <div
              className={cn(
                "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow",
                m.role === "user"
                  ? "bg-cyan-600 text-white rounded-br-md"
                  : "bg-slate-800/90 text-slate-100 ring-1 ring-slate-700 rounded-bl-md",
              )}
            >
              {m.imagePreview ? (
                <img
                  src={m.imagePreview}
                  alt="attachment"
                  className="mb-2 max-h-40 rounded-lg object-cover"
                />
              ) : null}
              {m.docName ? (
                <p className="mb-1 text-xs opacity-80">📎 {m.docName}</p>
              ) : null}
              <div className="whitespace-pre-wrap">{m.content.replace(/\*\*/g, "")}</div>
            </div>
          </div>
        ))}
        {busy ? (
          <div className="flex items-center gap-2 text-xs text-slate-400 px-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            D4AI is thinking…
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {error ? (
        <p className="px-4 pb-1 text-xs text-amber-400">{error}</p>
      ) : null}

      {/* Attach previews */}
      {(imagePreview || docName) && (
        <div className="flex items-center gap-2 border-t border-slate-800 px-3 py-2 text-xs text-slate-300">
          {imagePreview ? (
            <div className="relative">
              <img src={imagePreview} alt="" className="h-12 w-12 rounded object-cover" />
              <button
                type="button"
                className="absolute -right-1 -top-1 rounded-full bg-slate-900 p-0.5"
                onClick={() => {
                  setImageB64(null);
                  setImagePreview(null);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          {docName ? (
            <span className="flex items-center gap-1 rounded-full bg-slate-800 px-2 py-1">
              <FileText className="h-3.5 w-3.5" />
              {docName}
              <button
                type="button"
                onClick={() => {
                  setDocText(null);
                  setDocName(null);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : null}
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-slate-800 bg-slate-900/95 px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-1.5">
          <input
            ref={fileImgRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
          />
          <input
            ref={fileDocRef}
            type="file"
            accept=".pdf,.txt,.md,.csv,text/plain,application/pdf"
            className="hidden"
            onChange={(e) => void onPickDoc(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className="rounded-xl p-2.5 text-cyan-300 hover:bg-slate-800"
            onClick={() => fileImgRef.current?.click()}
            title="Image"
          >
            <ImagePlus className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="rounded-xl p-2.5 text-cyan-300 hover:bg-slate-800"
            onClick={() => fileDocRef.current?.click()}
            title="Document"
          >
            <FileText className="h-5 w-5" />
          </button>
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask D4AI…"
            className="max-h-28 min-h-[44px] flex-1 resize-none rounded-2xl border border-slate-700 bg-slate-850 bg-slate-800/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-cyan-600 focus:outline-none"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void send()}
            className="rounded-2xl bg-cyan-600 p-3 text-white disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
