/**
 * Server-side CBT result save using service role (bypasses RLS).
 * Validates the authenticated user owns the student_id before writing.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SaveCbtResultServerInput = {
  examId: string;
  studentId: string;
  schoolId: string;
  attemptId: string | null;
  totalScore: number;
  maxScore: number;
  percentage: number;
  grade: string;
  passFail: string;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
  resultStatus: string;
  securityReviewStatus: string;
  releasedAt: string | null;
  answers: Record<string, number>;
  attemptStatus: "submitted" | "terminated" | "flagged";
};

export const saveCbtResultServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }): Promise<{ resultId: string | null; error: string | null }> => {
    const input = data as SaveCbtResultServerInput;
    if (!input?.examId || !input?.studentId || !input?.schoolId) {
      return { resultId: null, error: "Missing exam, student, or school id." };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const userId = context.userId as string;

    // Resolve caller → student id (must match input.studentId)
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (!profile?.id) {
      return { resultId: null, error: "Your session is invalid. Please sign in again." };
    }

    const { data: studentRow } = await supabaseAdmin
      .from("students")
      .select("id, school_id")
      .eq("profile_id", profile.id)
      .maybeSingle();

    if (!studentRow?.id || String(studentRow.id) !== String(input.studentId)) {
      return { resultId: null, error: "You don't have permission to save this result." };
    }

    if (studentRow.school_id && String(studentRow.school_id) !== String(input.schoolId)) {
      return { resultId: null, error: "School mismatch." };
    }

    const payload: Record<string, unknown> = {
      exam_id: input.examId,
      student_id: input.studentId,
      school_id: input.schoolId,
      attempt_id: input.attemptId,
      total_score: input.totalScore,
      max_score: input.maxScore,
      objective_score: input.totalScore,
      percentage: input.percentage,
      grade: input.grade,
      pass_fail: input.passFail,
      correct_count: input.correctCount,
      wrong_count: input.wrongCount,
      unanswered_count: input.unansweredCount,
      status: input.resultStatus || "pending",
      security_review_status: input.securityReviewStatus || "clear",
      released_at: input.releasedAt,
      updated_at: new Date().toISOString(),
    };

    let resultId: string | null = null;

    // Upsert by (exam_id, student_id)
    const upsert = await supabaseAdmin
      .from("results")
      .upsert(payload as never, { onConflict: "exam_id,student_id" })
      .select("id")
      .maybeSingle();

    if (upsert.error) {
      // Fallback: select then update/insert
      const existing = await supabaseAdmin
        .from("results")
        .select("id")
        .eq("exam_id", input.examId)
        .eq("student_id", input.studentId)
        .maybeSingle();

      if (existing.data?.id) {
        const { exam_id: _e, student_id: _s, ...rest } = payload;
        const upd = await supabaseAdmin
          .from("results")
          .update(rest as never)
          .eq("id", existing.data.id)
          .select("id")
          .maybeSingle();
        if (upd.error) {
          console.error("saveCbtResultServer update", upd.error);
          return { resultId: existing.data.id as string, error: null };
        }
        resultId = (upd.data?.id as string) ?? (existing.data.id as string);
      } else {
        const ins = await supabaseAdmin.from("results").insert(payload as never).select("id").maybeSingle();
        if (ins.error) {
          console.error("saveCbtResultServer insert", ins.error);
          return { resultId: null, error: ins.error.message || "Could not save result." };
        }
        resultId = (ins.data?.id as string) ?? null;
      }
    } else {
      resultId = (upsert.data?.id as string) ?? null;
    }

    // Mark attempt submitted so student cannot rewrite
    const attemptStatus = input.attemptStatus || "submitted";
    const attemptPatch: Record<string, unknown> = {
      status: attemptStatus,
      submitted_at: new Date().toISOString(),
      total_score: input.totalScore,
      objective_score: input.totalScore,
      answers: input.answers,
      updated_at: new Date().toISOString(),
    };

    if (input.attemptId) {
      const { error: attErr } = await supabaseAdmin
        .from("exam_attempts")
        .update(attemptPatch as never)
        .eq("id", input.attemptId)
        .eq("student_id", input.studentId);
      if (attErr) {
        console.warn("saveCbtResultServer attempt by id", attErr);
        await supabaseAdmin
          .from("exam_attempts")
          .update(attemptPatch as never)
          .eq("exam_id", input.examId)
          .eq("student_id", input.studentId);
      }
    } else {
      await supabaseAdmin
        .from("exam_attempts")
        .update(attemptPatch as never)
        .eq("exam_id", input.examId)
        .eq("student_id", input.studentId);
    }

    if (!resultId) {
      const { data: found } = await supabaseAdmin
        .from("results")
        .select("id")
        .eq("exam_id", input.examId)
        .eq("student_id", input.studentId)
        .maybeSingle();
      resultId = (found?.id as string) ?? null;
    }

    return { resultId, error: null };
  });

/** Fetch a student's own result by result id or exam id (service role). */
export const getMyCbtResultServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }): Promise<{ result: Record<string, unknown> | null; error: string | null }> => {
    const input = data as { id: string; studentId?: string };
    if (!input?.id) return { result: null, error: "Missing id" };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const userId = context.userId as string;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!profile?.id) return { result: null, error: "Unauthorized" };

    const { data: studentRow } = await supabaseAdmin
      .from("students")
      .select("id")
      .eq("profile_id", profile.id)
      .maybeSingle();
    if (!studentRow?.id) return { result: null, error: "Student not found" };

    const studentId = studentRow.id as string;
    if (input.studentId && String(input.studentId) !== String(studentId)) {
      return { result: null, error: "Unauthorized" };
    }

    const select = `id, exam_id, student_id, attempt_id, total_score, max_score, percentage, grade, pass_fail,
      correct_count, wrong_count, unanswered_count, status, security_review_status,
      released_at, created_at,
      examinations(title, duration_minutes, scheduled_start, scheduled_end, courses(code, name))`;

    const byId = await supabaseAdmin
      .from("results")
      .select(select)
      .eq("student_id", studentId)
      .eq("id", input.id)
      .maybeSingle();
    if (byId.data) return { result: byId.data as Record<string, unknown>, error: null };

    const byExam = await supabaseAdmin
      .from("results")
      .select(select)
      .eq("student_id", studentId)
      .eq("exam_id", input.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byExam.data) return { result: byExam.data as Record<string, unknown>, error: null };

    return { result: null, error: null };
  });
