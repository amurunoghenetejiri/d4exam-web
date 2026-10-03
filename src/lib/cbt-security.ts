import { supabase } from "@/integrations/supabase/client";
import { notifyOfficersStudentViolation } from "@/lib/notify";

export type SecurityEventType =
  | "TAB_SWITCH"
  | "FULLSCREEN_EXIT"
  | "COPY_ATTEMPT"
  | "CUT_ATTEMPT"
  | "PASTE_ATTEMPT"
  | "CONTEXT_MENU"
  | "FACE_NOT_DETECTED"
  | "ONE_FACE_DETECTED"
  | "MULTIPLE_FACES_DETECTED"
  | "NO_FACE"
  | "MULTIPLE_FACES"
  | "ONE_FACE"
  | "CAMERA_UNAVAILABLE"
  | "CAMERA_PERMISSION_REVOKED"
  | "CAMERA_PERMISSION_DENIED"
  | "CAMERA_PERMISSION_GRANTED"
  | "MIC_PERMISSION_DENIED"
  | "MIC_PERMISSION_GRANTED"
  | "SCREEN_SHARE_STARTED"
  | "SCREEN_SHARE_STOPPED"
  | "SCREEN_SHARE_RESTORED"
  | "CONNECTION_LOST"
  | "CONNECTION_RESTORED"
  | "WARNING_SHOWN"
  | "AUTO_SUBMIT"
  | "MANUAL_SUBMIT"
  | "SECURITY_CHECK_PASSED"
  | "SECURITY_CHECK_FAILED";

export async function logSecurityEvent(input: {
  schoolId: string;
  examId: string;
  attemptId: string | null;
  studentId: string;
  eventType: SecurityEventType | string;
  severity?: "low" | "medium" | "high";
  description?: string;
  questionId?: string | null;
  questionIndex?: number | null;
  extra?: Record<string, unknown>;
}) {
  try {
    await supabase.from("integrity_events").insert({
      school_id: input.schoolId,
      exam_id: input.examId,
      attempt_id: input.attemptId,
      student_id: input.studentId,
      event_type: input.eventType,
      severity: input.severity ?? "low",
      description: input.description ?? null,
      metadata: {
        question_id: input.questionId ?? null,
        question_index: input.questionIndex ?? null,
        at: new Date().toISOString(),
        ...(input.extra ?? {}),
      } as never,
    } as never);
    const sev = String(input.severity ?? "low").toLowerCase();
    if (sev === "medium" || sev === "high") {
      void notifyOfficersStudentViolation({
        schoolId: input.schoolId,
        examId: input.examId,
        studentId: input.studentId,
        eventType: String(input.eventType),
        description: input.description ?? null,
        severity: sev,
      });
    }
  } catch (e) {
    console.warn("logSecurityEvent failed", e);
  }
}

/** Simple letter grade from percentage */
export function gradeFromPercentage(pct: number): string {
  if (pct >= 70) return "A";
  if (pct >= 60) return "B";
  if (pct >= 50) return "C";
  if (pct >= 45) return "D";
  if (pct >= 40) return "E";
  return "F";
}

function normalizeAnswer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

/**
 * Resolve the correct option *text* from a letter (A–D) or stored answer string
 * using the original (pre-shuffle) options array.
 */
export function resolveCorrectOptionText(
  correctAnswer: string | null | undefined,
  options: string[],
): string | null {
  if (!correctAnswer) return null;
  const raw = String(correctAnswer).trim();
  if (!raw) return null;

  // Letter key: A / B / C / D
  if (/^[A-Da-d]$/.test(raw)) {
    const idx = raw.toUpperCase().charCodeAt(0) - 65;
    const text = options[idx];
    return text != null && String(text).trim() ? String(text) : null;
  }

  // "A. text" / "B) text" style
  const letterPrefixed = raw.match(/^([A-Da-d])[).:\-\s]+(.+)$/);
  if (letterPrefixed) {
    const idx = letterPrefixed[1].toUpperCase().charCodeAt(0) - 65;
    if (options[idx] != null && String(options[idx]).trim()) return String(options[idx]);
    const rest = letterPrefixed[2].trim();
    if (rest) return rest;
  }

  // Exact / normalized match against option texts
  const norm = normalizeAnswer(raw);
  for (const opt of options) {
    if (normalizeAnswer(String(opt ?? "")) === norm) return String(opt);
  }

  // Numeric index stored as string
  if (/^\d+$/.test(raw)) {
    const idx = Number(raw);
    if (options[idx] != null) return String(options[idx]);
  }

  return raw;
}

/**
 * Score objective answers.
 * Prefer `correctOptionText` (resolved before option shuffle) so letter answers
 * still match after randomize_options.
 */
export function scoreObjectiveAnswers(
  questions: {
    id: string;
    correct_answer: string | null;
    correctOptionText?: string | null;
    /** Options the student actually saw (may be shuffled). Used only to map answer index → text. */
    options: string[];
    /** Original A–D option texts before any shuffle. Used to resolve letter keys. */
    originalOptions?: string[];
    marks?: number | null;
  }[],
  answers: Record<string, number | string>,
) {
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  let totalScore = 0;
  let maxMarks = 0;

  for (const q of questions) {
    const marks = Number(q.marks) || 1;
    maxMarks += marks;
    const idx = answers[q.id];
    if (idx == null || typeof idx === "string" || Number.isNaN(Number(idx))) {
      // Essay/text answers are not auto-scored here
      if (typeof idx === "string" && idx.trim()) {
        // leave maxMarks counted but no auto points
        continue;
      }
      unanswered += 1;
      continue;
    }
    const chosenRaw = String(q.options[Number(idx)] ?? "");
    const chosen = normalizeAnswer(chosenRaw);
    if (!chosen) {
      unanswered += 1;
      continue;
    }

    const original = (q.originalOptions && q.originalOptions.length ? q.originalOptions : null) as string[] | null;
    // Prefer explicit correctOptionText (set before shuffle). Else resolve letter/text
    // against ORIGINAL options only — never against shuffled options.
    const textKey = (q.correctOptionText || "").trim();
    const resolvedFromOriginal = original
      ? resolveCorrectOptionText(q.correct_answer, original)
      : null;
    // Last resort: match correct_answer as free text against the options the student saw
    const resolvedFromSeen = resolveCorrectOptionText(q.correct_answer, q.options);
    const expected = normalizeAnswer(
      textKey || resolvedFromOriginal || resolvedFromSeen || "",
    );

    let ok = false;
    if (expected) {
      ok = chosen === expected;
    }

    // Free-text / letter equality without relying on index (index is invalid after shuffle)
    if (!ok) {
      const raw = (q.correct_answer || "").trim();
      if (raw) {
        const normRaw = normalizeAnswer(raw);
        if (chosen === normRaw) ok = true;
        const stripped = normalizeAnswer(raw.replace(/^[A-Da-d][).:\-\s]+/, ""));
        if (!ok && stripped && chosen === stripped) ok = true;
        // True/False synonyms
        if (!ok) {
          const tfMap: Record<string, string[]> = {
            true: ["true", "t", "yes"],
            false: ["false", "f", "no"],
          };
          for (const [, aliases] of Object.entries(tfMap)) {
            if (aliases.includes(normRaw) && aliases.includes(chosen)) {
              ok = true;
              break;
            }
            if (aliases.includes(expected) && aliases.includes(chosen)) {
              ok = true;
              break;
            }
          }
        }
      }
    }

    if (ok) {
      correct += 1;
      totalScore += marks;
    } else {
      wrong += 1;
    }
  }

  const percentage = maxMarks > 0 ? Math.round((totalScore / maxMarks) * 1000) / 10 : 0;
  return {
    correct,
    wrong,
    unanswered,
    totalScore,
    maxMarks,
    percentage,
    grade: gradeFromPercentage(percentage),
    passFail: percentage >= 40 ? "Pass" : "Fail",
  };
}
