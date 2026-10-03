/**
 * Teacher essay marking → official results (service role).
 * Sets security_review_status = teacher_marked so officer can release.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SaveTeacherMarksInput = {
  examId: string;
  attemptId: string;
  studentId: string;
  schoolId: string;
  objectiveScore: number;
  subjectiveScore: number;
  totalScore: number;
  maxScore: number;
  percentage: number;
  grade: string;
  releaseNow: boolean;
  subjectiveMarks?: Record<string, number>;
};

export const saveTeacherMarksServer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }): Promise<{ ok?: boolean; resultId?: string; status?: string; error?: string }> => {
    const input = data as SaveTeacherMarksInput;
    if (!input?.examId || !input?.studentId || !input?.schoolId) {
      return { error: "Missing exam, student, or school id." };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const userId = context.userId as string;

    const {
      examId,
      attemptId,
      studentId,
      schoolId,
      objectiveScore,
      subjectiveScore,
      totalScore,
      maxScore,
      percentage,
      grade,
      releaseNow,
      subjectiveMarks,
    } = input;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("id, school_id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    const profileId = profile?.id ? String(profile.id) : null;

    let allowed = false;
    if (profileId) {
      const { data: te } = await supabaseAdmin
        .from("teachers")
        .select("id")
        .eq("profile_id", profileId)
        .eq("school_id", schoolId)
        .maybeSingle();
      if (te?.id) allowed = true;
    }
    if (!allowed) {
      const ids = [userId, profileId].filter(Boolean) as string[];
      for (const id of ids) {
        const { data: roles } = await supabaseAdmin
          .from("user_roles")
          .select("role")
          .eq("user_id", id)
          .eq("school_id", schoolId);
        const list = (roles ?? []).map((r: { role: string }) => String(r.role).toLowerCase());
        if (
          list.includes("teacher") ||
          list.includes("school_admin") ||
          list.includes("examination_officer") ||
          list.includes("super_admin")
        ) {
          allowed = true;
          break;
        }
      }
    }
    if (!allowed) return { error: "Not authorized to mark this exam." };

    const passFail = percentage >= 40 ? "pass" : "fail";
    const resultStatus = releaseNow ? "published" : "pending";
    const releasedAt = releaseNow ? new Date().toISOString() : null;

    if (attemptId) {
      try {
        const { data: attempt } = await supabaseAdmin
          .from("exam_attempts")
          .select("metadata")
          .eq("id", attemptId)
          .maybeSingle();
        const prev = (attempt?.metadata || {}) as Record<string, unknown>;
        await supabaseAdmin
          .from("exam_attempts")
          .update({
            metadata: {
              ...prev,
              essay_marked: true,
              subjective_marked: true,
              subjective_marks: subjectiveMarks || {},
              score: {
                ...((prev.score as Record<string, unknown>) || {}),
                objectiveScore,
                subjectiveScore,
                totalScore,
                maxScore,
                percentage,
                grade,
              },
            },
          } as never)
          .eq("id", attemptId);
      } catch (e) {
        console.warn("[saveTeacherMarks] attempt meta", e);
      }
    }

    const payload: Record<string, unknown> = {
      school_id: schoolId,
      exam_id: examId,
      student_id: studentId,
      attempt_id: attemptId || null,
      total_score: totalScore,
      objective_score: objectiveScore,
      max_score: maxScore,
      percentage,
      grade,
      pass_fail: passFail,
      status: resultStatus,
      security_review_status: "teacher_marked",
      released_at: releasedAt,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await supabaseAdmin
      .from("results")
      .select("id")
      .eq("exam_id", examId)
      .eq("student_id", studentId)
      .maybeSingle();

    if (existing?.id) {
      const { error } = await supabaseAdmin.from("results").update(payload as never).eq("id", existing.id);
      if (error) return { error: error.message };
      return { ok: true, resultId: String(existing.id), status: resultStatus };
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("results")
      .insert(payload as never)
      .select("id")
      .maybeSingle();
    if (!insErr && inserted?.id) {
      return { ok: true, resultId: String(inserted.id), status: resultStatus };
    }

    const { data: up, error: upErr } = await supabaseAdmin
      .from("results")
      .upsert(payload as never, { onConflict: "exam_id,student_id" })
      .select("id")
      .maybeSingle();
    if (upErr) return { error: upErr.message || insErr?.message || "Could not save result" };
    return { ok: true, resultId: up?.id ? String(up.id) : undefined, status: resultStatus };
  });
