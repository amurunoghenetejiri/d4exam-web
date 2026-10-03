import { supabase } from "@/integrations/supabase/client";
import { scoreObjectiveAnswers, resolveCorrectOptionText } from "@/lib/cbt-security";
import { friendlyError } from "@/lib/friendly-error";
import { notifyOfficersStudentResultPending } from "@/lib/notify";
import type { ResultVisibility } from "@/types";
import { saveCbtResultServer } from "@/lib/cbt-save-result.server";

function decodeOptionsFromExplanation(explanation: string | null | undefined): string[] {
  if (!explanation) return [];
  const optLine = String(explanation).split("\n").find((l) => l.startsWith("OPTIONS::"));
  if (!optLine) return [];
  const body = optLine.slice("OPTIONS::".length);
  const map: Record<string, string> = {};
  for (const part of body.split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) map[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1);
  }
  return ["A", "B", "C", "D"].map((k) => map[k]).filter(Boolean) as string[];
}

function decodeOptionsFromJson(options: unknown): string[] {
  if (!options) return [];
  let arr: unknown = options;
  if (typeof options === "string") {
    try { arr = JSON.parse(options); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const byKey: Record<string, string> = {};
  const ordered: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) ordered.push(text);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = String(o.key ?? o.option_key ?? "").trim().toUpperCase();
    const text = String(o.text ?? o.option_text ?? o.option ?? "").trim();
    if (key && text) byKey[key] = text;
    else if (text) ordered.push(text);
  }
  const fromKeys = ["A", "B", "C", "D", "E", "F"].map((k) => byKey[k]).filter(Boolean) as string[];
  return fromKeys.length ? fromKeys : ordered;
}

export async function saveCbtResult(input: {
  examId: string;
  studentId: string;
  schoolId: string;
  attemptId: string | null;
  questions: {
    id: string;
    marks: number;
    correct_answer: string | null;
    correctOptionText?: string | null;
    originalOptions?: string[];
    options: string[];
  }[];
  answers: Record<string, number>;
  terminated?: boolean;
  faceWarned?: boolean;
  resultVisibility?: ResultVisibility | string | null;
}) {
  const qIds = input.questions.map((q) => q.id).filter(Boolean);
  const bankById = new Map<string, { correct_answer: string | null; options?: unknown; explanation: string | null; marks: number | null }>();
  if (qIds.length) {
    for (const cols of ["id, correct_answer, options, marks", "id, correct_answer, options, marks, explanation", "id, correct_answer, marks"]) {
      const { data: bankRows, error } = await supabase.from("questions").select(cols).in("id", qIds);
      if (error) { console.warn("[cbt-save] questions bank select", error.message); continue; }
      for (const row of bankRows ?? []) {
        bankById.set(String((row as { id: string }).id), {
          correct_answer: (row as { correct_answer: string | null }).correct_answer,
          options: (row as { options?: unknown }).options,
          explanation: (row as { explanation?: string | null }).explanation ?? null,
          marks: (row as { marks: number | null }).marks,
        });
      }
      if (bankById.size) break;
    }
  }

  const questionsForScore = input.questions.map((q) => {
    const bank = bankById.get(q.id);
    const correctAnswer = bank?.correct_answer ?? q.correct_answer;
    const fromJson = decodeOptionsFromJson(bank?.options);
    const originals = fromJson.length ? fromJson : decodeOptionsFromExplanation(bank?.explanation).length ? decodeOptionsFromExplanation(bank?.explanation) : (q.originalOptions?.length ? q.originalOptions : []);
    const correctOptionText =
      q.correctOptionText ||
      (originals.length ? resolveCorrectOptionText(correctAnswer, originals) : null) ||
      resolveCorrectOptionText(correctAnswer, q.options) ||
      null;
    return {
      id: q.id,
      marks: Number(bank?.marks ?? q.marks) || 1,
      correct_answer: correctAnswer,
      correctOptionText,
      options: q.options,
      originalOptions: originals.length ? originals : undefined,
    };
  });

  if (input.terminated) {
    if (input.attemptId) {
      await supabase.from("exam_attempts").update({
        status: "terminated",
        answers: input.answers,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never).eq("id", input.attemptId);
    }
    return {
      scored: { totalScore: 0, maxMarks: 0, percentage: 0, grade: "—", passFail: "—", correct: 0, wrong: 0, unanswered: 0 },
      error: null,
      resultId: undefined,
      status: "terminated",
      published: false,
    };
  }

  const scored = scoreObjectiveAnswers(questionsForScore, input.answers);
  const status = input.terminated ? "terminated" : "submitted";
  const secStatus = input.terminated || input.faceWarned ? "flagged" : "pending";
  const vis = String(input.resultVisibility || "after_officer_release").toLowerCase().replace(/[\s-]+/g, "_");
  const immediateAliases = new Set(["immediate", "immediately", "immediately_after_submit", "release_immediately", "release_immediately_after_exam", "after_submit"]);
  const publishNow = immediateAliases.has(vis) && !input.terminated && secStatus !== "flagged";
  const resultStatus = publishNow ? "published" : "pending";
  const releasedAt = publishNow ? new Date().toISOString() : null;

  let resultId: string | undefined;
  let error: { message?: string } | null = null;

  // Preferred: server (service role) — bypasses RLS after ownership check
  try {
    const serverRes = await saveCbtResultServer({
      data: {
        examId: input.examId,
        studentId: input.studentId,
        schoolId: input.schoolId,
        attemptId: input.attemptId,
        totalScore: scored.totalScore,
        maxScore: scored.maxMarks,
        percentage: scored.percentage,
        grade: scored.grade,
        passFail: scored.passFail,
        correctCount: scored.correct,
        wrongCount: scored.wrong,
        unansweredCount: scored.unanswered,
        resultStatus,
        securityReviewStatus: secStatus,
        releasedAt,
        answers: input.answers,
        attemptStatus: (status === "terminated" ? "terminated" : "submitted") as "submitted" | "terminated" | "flagged",
      },
    });
    if (serverRes?.resultId) {
      resultId = serverRes.resultId;
      error = null;
    } else if (serverRes?.error) {
      error = { message: serverRes.error };
    }
  } catch (e) {
    console.warn("saveCbtResultServer threw", e);
  }

  // Fallback: client upsert (needs student INSERT policy on results)
  if (!resultId) {
    const payload = {
      exam_id: input.examId,
      student_id: input.studentId,
      school_id: input.schoolId,
      attempt_id: input.attemptId,
      total_score: scored.totalScore,
      max_score: scored.maxMarks,
      objective_score: scored.totalScore,
      percentage: scored.percentage,
      grade: scored.grade,
      pass_fail: scored.passFail,
      correct_count: scored.correct,
      wrong_count: scored.wrong,
      unanswered_count: scored.unanswered,
      status: resultStatus,
      security_review_status: secStatus,
      released_at: releasedAt,
    };
    const upsert = await supabase.from("results").upsert(payload as never, { onConflict: "exam_id,student_id" }).select("id").maybeSingle();
    if (!upsert.error) {
      resultId = upsert.data?.id as string | undefined;
      error = null;
    } else {
      error = upsert.error;
      const ins = await supabase.from("results").insert(payload as never).select("id").maybeSingle();
      if (!ins.error) {
        resultId = ins.data?.id as string | undefined;
        error = null;
      }
    }
  }

  if (!resultId) {
    const { data: again } = await supabase.from("results").select("id").eq("exam_id", input.examId).eq("student_id", input.studentId).maybeSingle();
    resultId = (again?.id as string) ?? undefined;
    if (resultId) error = null;
  }

  if (!error && input.schoolId && !publishNow) {
    void notifyOfficersStudentResultPending({
      schoolId: input.schoolId,
      examId: input.examId,
      studentId: input.studentId,
      resultId: resultId ?? null,
      published: false,
    });
  }

  return {
    scored,
    error: error ? { message: friendlyError(error, "Could not save your result. Please try again.") } : null,
    resultId,
    status,
    published: publishNow,
  };
}
