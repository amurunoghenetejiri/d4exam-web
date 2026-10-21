/**
 * Load & prepare CBT questions for a student paper.
 * Priority: RPC → exam_questions → course bank.
 * Always merges real option texts from questions.options, explanation, and question_options.
 */
import { supabase } from "@/integrations/supabase/client";
import { sbLoose } from "@/lib/supabase-loose";
import { parseQuestionOptions } from "@/lib/question-options";
import { resolveCorrectOptionText } from "@/lib/cbt-security";
import { pickExamQuestions, seededShuffle } from "@/lib/exam-meta";

export type CbtQuestionRow = {
  id: string;
  question_text: string;
  question_type: string;
  marks: number;
  correct_answer: string | null;
  options: string[];
  originalOptions: string[];
  correctOptionText: string | null;
};

type RawQ = {
  id: string;
  question_text: string;
  question_type: string | null;
  marks: number | null;
  correct_answer: string | null;
  explanation: string | null;
  options?: unknown;
};

function decodeOptionsLegacy(explanation: string | null): string[] {
  if (!explanation) return [];
  const optLine = explanation.split("\n").find((l) => l.startsWith("OPTIONS::"));
  if (!optLine) return [];
  const body = optLine.slice("OPTIONS::".length);
  const map: Record<string, string> = {};
  for (const part of body.split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) map[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1);
  }
  return ["A", "B", "C", "D"].map((k) => map[k]).filter(Boolean) as string[];
}

function optionTextCount(options: unknown): number {
  return parseQuestionOptions({ options }).length;
}

function hasUsableOptions(q: RawQ): boolean {
  if (optionTextCount(q.options) > 0) return true;
  if (q.explanation && q.explanation.includes("OPTIONS::")) return true;
  return false;
}

function normalizeRows(data: unknown): RawQ[] {
  if (!Array.isArray(data)) return [];
  const out: RawQ[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    // RPC may return nested json already
    const id = r.id != null ? String(r.id) : "";
    const text = r.question_text != null ? String(r.question_text) : "";
    if (!id) continue;
    out.push({
      id,
      question_text: text,
      question_type: r.question_type != null ? String(r.question_type) : null,
      marks: r.marks != null ? Number(r.marks) : 1,
      correct_answer: r.correct_answer != null ? String(r.correct_answer) : null,
      explanation: r.explanation != null ? String(r.explanation) : null,
      options: r.options,
    });
  }
  return out;
}

function mergeRaw(base: RawQ, extra: RawQ): RawQ {
  return {
    id: base.id,
    question_text: base.question_text || extra.question_text,
    question_type: base.question_type ?? extra.question_type,
    marks: base.marks ?? extra.marks,
    correct_answer: base.correct_answer ?? extra.correct_answer,
    explanation: hasUsableOptions(base) ? base.explanation : extra.explanation ?? base.explanation,
    options: hasUsableOptions(base) ? base.options : extra.options ?? base.options,
  };
}

/** Load option rows from question_options table (legacy / alternate storage). */
async function fetchOptionsFromQuestionOptionsTable(
  ids: string[],
): Promise<Map<string, { key: string; text: string; is_correct?: boolean }[]>> {
  const map = new Map<string, { key: string; text: string; is_correct?: boolean }[]>();
  if (!ids.length) return map;
  for (const cols of [
    "question_id, option_text, is_correct, option_key, sort_order",
    "question_id, option_text, is_correct, key, sort_order",
    "question_id, option_text, is_correct, sort_order",
    "question_id, option_text, is_correct",
    "question_id, option_text",
  ]) {
    const { data, error } = (await sbLoose.from("question_options").select(cols).in("question_id", ids).limit(2000)) as { data: Record<string, unknown>[] | null; error: { message: string } | null };
    if (error) {
      console.warn("[cbt] question_options", error.message);
      continue;
    }
    if (!data?.length) continue;
    for (const row of data) {
      const r = row;
      const qid = String(r.question_id ?? "");
      const text = String(r.option_text ?? "").trim();
      if (!qid || !text) continue;
      const keyRaw = String(r.option_key ?? r.key ?? "").trim().toUpperCase();
      const list = map.get(qid) ?? [];
      const key = keyRaw || String.fromCharCode(65 + list.length);
      list.push({ key, text, is_correct: Boolean(r.is_correct) });
      map.set(qid, list);
    }
    if (map.size) break;
  }
  return map;
}

async function enrichMissingOptions(rows: RawQ[]): Promise<RawQ[]> {
  if (!rows.length) return rows;
  const needIds = rows.filter((q) => !hasUsableOptions(q)).map((q) => q.id);
  let next = rows;

  if (needIds.length) {
    const full = await fetchQuestionsByIds(needIds);
    if (full.length) {
      const byId = new Map(full.map((q) => [q.id, q]));
      next = next.map((q) => {
        if (hasUsableOptions(q)) return q;
        const f = byId.get(q.id);
        return f ? mergeRaw(q, f) : q;
      });
    }
  }

  const stillNeed = next.filter((q) => !hasUsableOptions(q)).map((q) => q.id);
  if (stillNeed.length) {
    const fromTable = await fetchOptionsFromQuestionOptionsTable(stillNeed);
    if (fromTable.size) {
      next = next.map((q) => {
        if (hasUsableOptions(q)) return q;
        const opts = fromTable.get(q.id);
        if (!opts?.length) return q;
        return { ...q, options: opts };
      });
    }
  }

  return next;
}

async function loadViaRpc(examId: string, courseId: string | null, schoolId: string | null): Promise<RawQ[]> {
  try {
    const { data, error } = await Promise.race([
      sbLoose.rpc("get_cbt_exam_questions", {
        p_exam_id: examId,
        p_course_id: courseId || null,
        p_school_id: schoolId || null,
      }),
      new Promise<{ data: null; error: { message: string } }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: { message: "rpc timeout" } }), 6_000),
      ),
    ]);
    if (error) {
      console.warn("[cbt] get_cbt_exam_questions rpc", error.message);
      return [];
    }
    let rows: unknown = data;
    if (typeof data === "string") {
      try { rows = JSON.parse(data); } catch { rows = []; }
    }
    if (rows && typeof rows === "object" && !Array.isArray(rows) && Array.isArray((rows as { data?: unknown }).data)) {
      rows = (rows as { data: unknown[] }).data;
    }
    const list = Array.isArray(rows) ? rows : [];
    return enrichMissingOptions(normalizeRows(list));
  } catch (e) {
    console.warn("[cbt] rpc exception", e);
    return [];
  }
}

async function loadFromExamQuestions(examId: string): Promise<RawQ[]> {
  try {
    let linkRes = await supabase
      .from("exam_questions")
      .select("question_id, marks, question_order")
      .eq("exam_id", examId)
      .order("question_order", { ascending: true })
      .limit(300);
    if (linkRes.error) {
      // Legacy column names
      linkRes = await supabase
        .from("exam_questions")
        .select("question_id, marks, sort_order")
        .eq("examination_id", examId)
        .order("sort_order", { ascending: true })
        .limit(300);
      if (linkRes.error) {
        console.warn("[cbt] exam_questions link", linkRes.error.message);
        return [];
      }
      // normalize
      linkRes = {
        ...linkRes,
        data: (linkRes.data || []).map((r: any) => ({
          question_id: r.question_id,
          marks: r.marks,
          question_order: r.sort_order ?? r.question_order,
        })),
      } as typeof linkRes;
    }
    const links = (linkRes.data ?? []).filter((r) => r.question_id);
    if (!links.length) return [];
    const ids = links.map((r) => String(r.question_id));
    const marksById = new Map(links.map((r) => [String(r.question_id), r.marks]));
    const orderById = new Map(links.map((r, i) => [String(r.question_id), r.question_order ?? i]));
    const qRows = await fetchQuestionsByIds(ids);
    if (!qRows.length) return [];
    const enriched = await enrichMissingOptions(qRows);
    enriched.sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));
    return enriched.map((q) => ({ ...q, marks: marksById.get(q.id) ?? q.marks ?? 1 }));
  } catch (e) {
    console.warn("[cbt] exam_questions exception", e);
    return [];
  }
}

async function fetchQuestionsByIds(ids: string[]): Promise<RawQ[]> {
  if (!ids.length) return [];
  // Prefer selecting options; fall back if column missing
  for (const cols of [
    "id, question_text, question_type, marks, correct_answer, explanation, options, status",
    "id, question_text, question_type, marks, correct_answer, explanation, status",
    "id, question_text, question_type, marks, correct_answer, status",
    "id, question_text, marks, correct_answer",
  ]) {
    const { data, error } = await supabase.from("questions").select(cols).in("id", ids).limit(300);
    if (!error && data?.length) return normalizeRows(data);
    if (error) console.warn("[cbt] questions by id", error.message);
  }
  return [];
}

async function loadFromCourseBank(courseId: string, schoolId: string | null): Promise<RawQ[]> {
  if (!courseId) return [];
  // Fast path: one query (avoid nested retries that delay exam start)
  let q = supabase
    .from("questions")
    .select("id, question_text, question_type, marks, correct_answer, explanation, options, school_id, status, course_id")
    .eq("course_id", courseId)
    .limit(150);
  if (schoolId) q = q.eq("school_id", schoolId);
  const { data, error } = await q;
  if (!error && data?.length) return enrichMissingOptions(normalizeRows(data));
  if (schoolId) {
    const { data: d2 } = await supabase
      .from("questions")
      .select("id, question_text, question_type, marks, correct_answer, explanation, options, school_id, status, course_id")
      .eq("course_id", courseId)
      .limit(150);
    if (d2?.length) return enrichMissingOptions(normalizeRows(d2));
  }
  if (error) console.warn("[cbt] course bank", error.message);
  return [];
}

export async function loadExamQuestionBank(opts: {
  courseId: string;
  schoolId?: string | null;
  examId?: string | null;
}): Promise<RawQ[]> {
  const courseId = opts.courseId ? String(opts.courseId) : "";
  const schoolId = opts.schoolId ? String(opts.schoolId) : null;
  const examId = opts.examId ? String(opts.examId) : null;

  let rows: RawQ[] = [];

  if (examId) {
    rows = await loadViaRpc(examId, courseId || null, schoolId);
  }

  // If RPC gave questions but no options, merge from exam_questions path
  if (examId && (!rows.length || rows.some((r) => !hasUsableOptions(r)))) {
    const linked = await loadFromExamQuestions(examId);
    if (linked.length) {
      if (!rows.length) {
        rows = linked;
      } else {
        const byId = new Map(linked.map((q) => [q.id, q]));
        rows = rows.map((q) => {
          if (hasUsableOptions(q)) return q;
          const f = byId.get(q.id);
          return f ? mergeRaw(q, f) : q;
        });
      }
    }
  }

  if (!rows.length && courseId) {
    rows = await loadFromCourseBank(courseId, schoolId);
  } else if (rows.length && rows.some((r) => !hasUsableOptions(r)) && courseId) {
    const bank = await loadFromCourseBank(courseId, schoolId);
    if (bank.length) {
      const byId = new Map(bank.map((q) => [q.id, q]));
      rows = rows.map((q) => {
        if (hasUsableOptions(q)) return q;
        const f = byId.get(q.id);
        return f ? mergeRaw(q, f) : q;
      });
    }
  }

  return enrichMissingOptions(rows);
}

export async function ensureExamQuestionsLinked(opts: {
  examId: string;
  courseId: string;
  schoolId: string;
  maxQuestions?: number | null;
  /** Explicit bank questions chosen by teacher for this paper */
  questionIds?: string[] | null;
}): Promise<number> {
  const { examId, courseId, schoolId, questionIds } = opts;
  if (!examId || !courseId) return 0;

  // If teacher picked specific questions, (re)link exactly those
  if (questionIds && questionIds.length > 0) {
    const unique = [...new Set(questionIds.map(String).filter(Boolean))];
    const qRows = await fetchQuestionsByIds(unique);
    const marksById = new Map(qRows.map((q) => [q.id, q.marks ?? 1]));
    try {
      await sbLoose.from("exam_questions").delete().eq("exam_id", examId);
    } catch {
      /* ignore */
    }
    const rows = unique.map((qid, i) => ({
      exam_id: examId,
      question_id: qid,
      marks: marksById.get(qid) ?? 1,
      question_order: i + 1,
    }));
    let { error } = await sbLoose.from("exam_questions").insert(rows);
    if (error && /examination_id|column/i.test(error.message || "")) {
      const legacy = unique.map((qid, i) => ({
        examination_id: examId,
        question_id: qid,
        marks: marksById.get(qid) ?? 1,
        sort_order: i + 1,
      }));
      ({ error } = await sbLoose.from("exam_questions").insert(legacy));
    }
    if (error) {
      console.warn("[cbt] ensureExamQuestionsLinked selected", error.message);
      return 0;
    }
    return rows.length;
  }

  let existing = await supabase.from("exam_questions").select("question_id").eq("exam_id", examId).limit(1);
  if (existing.error) {
    existing = await supabase.from("exam_questions").select("question_id").eq("examination_id", examId).limit(1);
  }
  if (!existing.error && (existing.data?.length ?? 0) > 0) return 0;
  let qs: { id: string; marks: number | null }[] | null = null;
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
  }
  if (!qs?.length) return 0;
  const limit = opts.maxQuestions && opts.maxQuestions > 0 ? opts.maxQuestions : qs.length;
  const picked = qs.slice(0, Math.min(limit, qs.length));
  const rows = picked.map((q, i) => ({
    exam_id: examId,
    question_id: q.id,
    marks: q.marks ?? 1,
    question_order: i + 1,
  }));
  let { error } = await sbLoose.from("exam_questions").insert(rows);
  if (error && /examination_id|column/i.test(error.message || "")) {
    const legacy = picked.map((q, i) => ({
      examination_id: examId,
      question_id: q.id,
      marks: q.marks ?? 1,
      sort_order: i + 1,
    }));
    ({ error } = await sbLoose.from("exam_questions").insert(legacy));
  }
  if (error) {
    console.warn("[cbt] ensureExamQuestionsLinked", error.message);
    return 0;
  }
  return rows.length;
}

export function prepareStudentPaper(
  bankRows: RawQ[],
  opts: {
    questionsToAnswer: number | null;
    randomizeQuestions: boolean;
    randomizeOptions: boolean;
    studentKey: string;
    examId: string;
  },
): CbtQuestionRow[] {
  const bank: CbtQuestionRow[] = bankRows
    .map((q) => {
      const parsed = parseQuestionOptions({
        options: q.options,
        explanation: q.explanation ?? null,
        correct_answer: q.correct_answer,
      });
      let optionTexts = parsed.map((o) => o.text).filter(Boolean);
      if (!optionTexts.length) optionTexts = decodeOptionsLegacy(q.explanation ?? null);
      if (!optionTexts.length && String(q.question_type || "").toLowerCase().includes("true")) {
        optionTexts = ["True", "False"];
      }
      const originalOptions = [...optionTexts];
      const correctOptionText = resolveCorrectOptionText(q.correct_answer, originalOptions);
      const text = String(q.question_text || "").trim() || "Question";
      return {
        id: String(q.id),
        question_text: text,
        question_type: String(q.question_type || "mcq"),
        marks: Number(q.marks) || 1,
        correct_answer: q.correct_answer,
        options: optionTexts,
        originalOptions,
        correctOptionText,
      };
    })
    .filter((q) => q.id);

  let picked = pickExamQuestions(bank as never, {
    questionsToAnswer: opts.questionsToAnswer,
    randomize: opts.randomizeQuestions,
    studentKey: opts.studentKey,
    examId: opts.examId,
  }) as CbtQuestionRow[];

  if (opts.randomizeOptions) {
    picked = picked.map((q) => ({
      ...q,
      options: seededShuffle(q.options, `${opts.examId}:${opts.studentKey}:${q.id}:opts`),
    }));
  }
  return picked;
}


/**
 * On tab-leave during CBT: keep answered questions fixed; replace unanswered
 * slots with other questions from the teacher bank (or reshuffle unanswered
 * among themselves when the bank is exhausted). Option order may be remixed;
 * correct answers stay bound via correctOptionText / originalOptions.
 */
export function reshuffleUnansweredPaper(
  fullBank: CbtQuestionRow[],
  currentPaper: CbtQuestionRow[],
  answers: Record<string, number | string | null | undefined>,
  opts: {
    examId: string;
    studentKey: string;
    salt: string | number;
    randomizeOptions: boolean;
  },
): CbtQuestionRow[] {
  if (!currentPaper.length) return currentPaper;

  const isAnswered = (id: string) => {
    const v = answers[id];
    if (v === undefined || v === null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    return true;
  };

  const answeredIds = new Set(currentPaper.filter((q) => isAnswered(q.id)).map((q) => q.id));
  const need = currentPaper.filter((q) => !isAnswered(q.id)).length;
  if (need <= 0) return currentPaper;

  const byId = new Map(fullBank.map((q) => [q.id, q]));
  let pool = fullBank.filter((q) => !answeredIds.has(q.id));
  if (pool.length < need) {
    pool = currentPaper.filter((q) => !isAnswered(q.id));
  }

  const seed = `${opts.examId}:${opts.studentKey}:tableave:${opts.salt}`;
  let picked = seededShuffle(pool, seed).slice(0, need);

  if (picked.length < need) {
    const extra = currentPaper.filter(
      (q) => !isAnswered(q.id) && !picked.some((p) => p.id === q.id),
    );
    picked = [...picked, ...seededShuffle(extra, seed + ":fill")].slice(0, need);
  }

  if (opts.randomizeOptions) {
    picked = picked.map((q) => {
      const base = byId.get(q.id) || q;
      const optsList = base.originalOptions?.length ? [...base.originalOptions] : [...base.options];
      return {
        ...base,
        options: seededShuffle(optsList, `${seed}:${q.id}:opts`),
      };
    });
  } else {
    picked = picked.map((q) => byId.get(q.id) || q);
  }

  const queue = [...picked];
  return currentPaper.map((q) => {
    if (isAnswered(q.id)) return q;
    return queue.shift() || q;
  });
}
