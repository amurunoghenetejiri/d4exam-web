#!/usr/bin/env python3
"""Surgical fixes: voice/file promote, exam questions, stuck clocks."""
from pathlib import Path

def rep(path, old, new, label):
    p = Path(path)
    t = p.read_text()
    if old not in t:
        print("MISS", label)
        return False
    p.write_text(t.replace(old, new, 1))
    print("OK", label)
    return True

# --- Voice promote ---
rep(
    "src/routes/student.messages.$conversationId.tsx",
    '''            const up = await uploadMessageMedia(
              blob,
              "audio/webm",
              `campus/${conversationId}`,
            );
            await sendCampusMessage({
              conversationId,
              senderId: userId,
              attachmentUrl: up.url,
              attachmentType: "audio",
              clientId,
              durationSec,
              replyToId: replyId,
            });
            void qc.invalidateQueries({
              queryKey: ["campus-messages", conversationId],
            });
          } catch (e) {
            toast.error("Voice note could not send — try again");
          }''',
    '''            const up = await uploadMessageMedia(
              blob,
              blob.type || "audio/webm",
              `campus/${conversationId}`,
            );
            const sent = await sendCampusMessage({
              conversationId,
              senderId: userId,
              attachmentUrl: up.url,
              attachmentType: "audio",
              clientId,
              durationSec,
              replyToId: replyId,
            });
            try { removeOutbox(clientId); } catch {}
            setOptimistic((prev) =>
              prev.filter((m) => m.client_id !== clientId && m.id !== clientId),
            );
            if (sent?.id) {
              qc.setQueryData(["campus-messages", conversationId], (old) => {
                const list = Array.isArray(old) ? old.slice() : [];
                const idx = list.findIndex(
                  (m) => m.id === sent.id || m.client_id === clientId || m.id === clientId,
                );
                if (idx >= 0) list[idx] = sent;
                else list.push(sent);
                return list.sort(
                  (a, b) =>
                    new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
                );
              });
            }
            void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
          } catch (e) {
            console.warn("[voice] send failed", e);
            try {
              const { blobToDataUrlIfSmall } = await import("@/lib/message-outbox");
              const dataUrl = await blobToDataUrlIfSmall(blob);
              if (dataUrl) {
                enqueueOutbox({
                  clientId,
                  kind: "campus_audio",
                  text: "",
                  mediaType: "audio",
                  blobDataUrl: dataUrl,
                  role: "student",
                  userId,
                  conversationId,
                  durationSec,
                });
              }
            } catch {}
            toast.error("Voice note could not send — try again");
          }''',
    "voice-promote",
)

# --- File promote ---
rep(
    "src/routes/student.messages.$conversationId.tsx",
    '''      const up = await uploadMessageMedia(file, kind, `campus/${conversationId}`);
      await sendCampusMessage({
        conversationId,
        senderId: userId,
        attachmentUrl: up.url,
        attachmentType:
          up.type === "image" ? "image" : up.type === "audio" ? "audio" : attType,
        clientId,
        replyToId: replyId,
      });
      void qc.invalidateQueries({ queryKey: ["campus-messages", conversationId] });
    } catch (e) {
      toast.error("Upload failed — try a smaller file");
    }''',
    '''      const up = await uploadMessageMedia(file, kind, `campus/${conversationId}`);
      const sent = await sendCampusMessage({
        conversationId,
        senderId: userId,
        attachmentUrl: up.url,
        attachmentType:
          up.type === "image" ? "image" : up.type === "audio" ? "audio" : attType,
        clientId,
        replyToId: replyId,
      });
      try { removeOutbox(clientId); } catch {}
      setOptimistic((prev) =>
        prev.filter((m) => m.client_id !== clientId && m.id !== clientId),
      );
      if (sent?.id) {
        qc.setQueryData(["campus-messages", conversationId], (old) => {
          const list = Array.isArray(old) ? old.slice() : [];
          const idx = list.findIndex(
            (m) => m.id === sent.id || m.client_id === clientId || m.id === clientId,
          );
          if (idx >= 0) list[idx] = sent;
          else list.push(sent);
          return list.sort(
            (a, b) =>
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          );
        });
      }
      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
    } catch (e) {
      console.warn("[file] send failed", e);
      toast.error("Upload failed — try a smaller file");
    }''',
    "file-promote",
)

# --- Safety net effect (insert after serverMsgs) ---
p = Path("src/routes/student.messages.$conversationId.tsx")
t = p.read_text()
needle = "  const serverMsgs = msgQuery.data || [];"
effect = '''  const serverMsgs = msgQuery.data || [];

  // Safety net: clear optimistic once server has matching client_id (stops stuck clocks)
  useEffect(() => {
    if (!serverMsgs.length) return;
    const confirmed = new Set(
      serverMsgs.map((m) => m.client_id).filter(Boolean) as string[],
    );
    const ids = new Set(serverMsgs.map((m) => m.id).filter(Boolean));
    setOptimistic((prev) => {
      if (!prev.length) return prev;
      const next = prev.filter(
        (o) =>
          !(o.client_id && (confirmed.has(o.client_id) || ids.has(o.client_id) || ids.has(o.id))),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [serverMsgs]);
'''
if "Safety net: clear optimistic" not in t and needle in t:
    p.write_text(t.replace(needle, effect, 1))
    print("OK safety-net")
else:
    print("safety-net skip")

# --- Merged strengthen ---
rep(
    "src/routes/student.messages.$conversationId.tsx",
    '''    const merged = useMemo(() => {
    const byClient = new Set(
      serverMsgs.map((m) => m.client_id).filter(Boolean) as string[],
    );
    const pending = optimistic.filter(
      (o) => o.client_id && !byClient.has(o.client_id),
    );
    return [...serverMsgs, ...pending].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }, [serverMsgs, optimistic]);''',
    '''    const merged = useMemo(() => {
    const byClient = new Set(
      serverMsgs.map((m) => m.client_id).filter(Boolean) as string[],
    );
    const byId = new Set(serverMsgs.map((m) => m.id).filter(Boolean));
    const pending = optimistic.filter((o) => {
      if (!o.client_id) return false;
      if (byClient.has(o.client_id)) return false;
      if (byId.has(o.client_id) || byId.has(o.id)) return false;
      return true;
    });
    return [...serverMsgs, ...pending].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }, [serverMsgs, optimistic]);''',
    "merged",
)

# --- Exam: auto-link without schoolId required ---
rep(
    "src/components/cbt/CbtExamSession.impl.tsx",
    '''      let rows = await loadExamQuestionBank({ courseId, schoolId, examId: id || null });
      if ((!rows || rows.length === 0) && id && courseId && schoolId) {
        try {
          const linked = await ensureExamQuestionsLinked({
            examId: id, courseId, schoolId,
            maxQuestions: (exam as { questions_to_answer?: number | null })?.questions_to_answer ?? null,
          });
          if (linked > 0) rows = await loadExamQuestionBank({ courseId, schoolId, examId: id });
        } catch (e) { console.warn("[cbt] auto-link questions", e); }
      }
      return rows;''',
    '''      let rows = await loadExamQuestionBank({ courseId, schoolId, examId: id || null });
      if ((!rows || rows.length === 0) && id && courseId) {
        try {
          const linked = await ensureExamQuestionsLinked({
            examId: id,
            courseId,
            schoolId: schoolId || "",
            maxQuestions: (exam as { questions_to_answer?: number | null })?.questions_to_answer ?? null,
          });
          if (linked > 0) rows = await loadExamQuestionBank({ courseId, schoolId, examId: id });
        } catch (e) { console.warn("[cbt] auto-link questions", e); }
      }
      return rows;''',
    "exam-query",
)

rep(
    "src/components/cbt/CbtExamSession.impl.tsx",
    '''  if (!started) {
    return (
      <ExamSecurityGate
        examTitle={previewMode ? `${exam.title} (Officer preview)` : exam.title}
        courseLine={`${(exam as { courses?: { code?: string; name?: string } }).courses?.code ?? ""} · ${(exam as { courses?: { code?: string; name?: string } }).courses?.name ?? ""}`}
        durationMinutes={exam.duration_minutes ?? 60}
        totalQuestions={TOTAL}
        security={security}
        busy={mediaBusy}
        schoolLogoUrl={resolvedLogoUrl}
        schoolName={resolvedSchoolName}
        windowLabel={previewMode ? "Officer interactive preview" : formatExamWindow(exam.scheduled_start, exam.scheduled_end)}
        cancelTo={previewMode ? "/officer/approvals" : "/student/examinations"}
        onStart={(opts) => void beginWithMedia(opts)}
      />
    );
  }''',
    '''  if (!started) {
    const questionsLoading = questionsQ.isLoading || questionsQ.isFetching;
    if (questionsLoading && TOTAL === 0) {
      return (
        <div className="grid min-h-dvh place-items-center bg-white p-6 text-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-[#2563eb]" />
            <p className="text-sm font-semibold text-slate-700">Loading exam questions…</p>
            <p className="max-w-xs text-xs text-slate-500">Preparing your paper. This only takes a moment.</p>
          </div>
        </div>
      );
    }
    return (
      <ExamSecurityGate
        examTitle={previewMode ? `${exam.title} (Officer preview)` : exam.title}
        courseLine={`${(exam as { courses?: { code?: string; name?: string } }).courses?.code ?? ""} · ${(exam as { courses?: { code?: string; name?: string } }).courses?.name ?? ""}`}
        durationMinutes={exam.duration_minutes ?? 60}
        totalQuestions={TOTAL}
        security={security}
        busy={mediaBusy || questionsLoading}
        schoolLogoUrl={resolvedLogoUrl}
        schoolName={resolvedSchoolName}
        windowLabel={previewMode ? "Officer interactive preview" : formatExamWindow(exam.scheduled_start, exam.scheduled_end)}
        cancelTo={previewMode ? "/officer/approvals" : "/student/examinations"}
        onStart={(opts) => void beginWithMedia(opts)}
      />
    );
  }''',
    "exam-gate",
)

# --- ensureExamQuestionsLinked school filter ---
rep(
    "src/lib/cbt-load-questions.ts",
    '''  let qs: { id: string; marks: number | null }[] | null = null;
  for (const statuses of [["active", "approved"], ["active", "approved", "pending"], null] as (string[] | null)[]) {
    let q = sbLoose
      .from("questions")
      .select("id, marks")
      .eq("course_id", courseId)
      .eq("school_id", schoolId)
      .order("created_at", { ascending: true })
      .limit(300);
    if (statuses) q = q.in("status", statuses);
    const res = (await q) as { data: { id: string; marks: number | null }[] | null; error: { message: string } | null };
    if (!res.error && res.data?.length) {
      qs = res.data;
      break;
    }
  }''',
    '''  let qs: { id: string; marks: number | null }[] | null = null;
  for (const statuses of [["active", "approved"], ["active", "approved", "pending"], null] as (string[] | null)[]) {
    let q = sbLoose
      .from("questions")
      .select("id, marks")
      .eq("course_id", courseId)
      .order("created_at", { ascending: true })
      .limit(300);
    if (schoolId) q = q.eq("school_id", schoolId);
    if (statuses) q = q.in("status", statuses);
    const res = (await q) as { data: { id: string; marks: number | null }[] | null; error: { message: string } | null };
    if (!res.error && res.data?.length) {
      qs = res.data;
      break;
    }
  }
  if (!qs?.length && schoolId) {
    for (const statuses of [["active", "approved"], ["active", "approved", "pending"], null] as (string[] | null)[]) {
      let q = sbLoose
        .from("questions")
        .select("id, marks")
        .eq("course_id", courseId)
        .order("created_at", { ascending: true })
        .limit(300);
      if (statuses) q = q.in("status", statuses);
      const res = (await q) as { data: { id: string; marks: number | null }[] | null; error: { message: string } | null };
      if (!res.error && res.data?.length) {
        qs = res.data;
        break;
      }
    }
  }''',
    "ensure-link",
)

print("done")
