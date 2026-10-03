/**
 * D4EXAM notification helpers — DB-backed inserts + push.
 * recipient_user_id MUST be auth.users id (auth.uid()), never profiles.id.
 *
 * ROOT CAUSE FIXES:
 * - Call sites often pass student table ids as studentIds; helpers now resolve to auth ids.
 * - Missing examTitle/studentName is resolved from DB when possible.
 * - Every successful insert fires dispatchPushToUser.
 */
import { supabase } from "@/integrations/supabase/client";
import * as Msg from "@/lib/notify-messages";

function templateLink(copy: Msg.NotificationTemplate, fallback: string): string {
  return (copy.action?.link || fallback || "").trim() || fallback;
}

export type NotifyType =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "exam_submitted"
  | "exam_approved"
  | "exam_rejected"
  | "exam_revision_requested"
  | "exam_scheduled"
  | "exam_available"
  | "result_published"
  | "result_pending_release"
  | "announcement"
  | "system_alert"
  | "officer_warning"
  | string;

export type NotifyPayload = {
  recipientUserId: string;
  schoolId?: string | null;
  title: string;
  message: string;
  type?: NotifyType | string;
  link?: string | null;
  /** Optional action button label for push / native tray (e.g. VIEW EXAM) */
  actionLabel?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  dedupeMinutes?: number;
};

async function firePush(
  recipientUserId: string,
  title: string,
  message: string,
  link: string | null,
  actionLabel?: string | null,
): Promise<void> {
  if (!recipientUserId) return;
  try {
    const m = await import("@/lib/push-send.functions");
    const result = await m.dispatchPushToUser({
      data: {
        recipientUserId,
        title,
        message,
        link: link || "/",
        actionLabel: actionLabel || undefined,
      },
    });
    const r = result as { sent?: number; skipped?: boolean; reason?: string };
    if (r?.skipped || (r?.sent ?? 0) === 0) {
      console.warn("[notify] push not delivered", recipientUserId, r?.reason || r);
    }
  } catch (e) {
    console.warn("[notify] firePush failed", e);
  }
}

export async function resolveAuthUserIds(
  ids: string[],
  schoolId?: string | null,
): Promise<string[]> {
  const uniq = (xs: (string | null | undefined)[]) =>
    [...new Set(xs.filter((x): x is string => Boolean(x)))];
  const input = uniq(ids);
  if (!input.length) return [];
  try {
    let q1 = supabase.from("profiles").select("auth_user_id").in("auth_user_id", input);
    if (schoolId) q1 = q1.eq("school_id", schoolId);
    const { data: byAuth } = await q1;
    const matched = uniq((byAuth ?? []).map((p) => (p as { auth_user_id: string | null }).auth_user_id));
    const missing = input.filter((id) => !matched.includes(id));
    if (!missing.length) return matched.length ? matched : input;
    let q2 = supabase.from("profiles").select("auth_user_id").in("id", missing);
    if (schoolId) q2 = q2.eq("school_id", schoolId);
    const { data: byProfile } = await q2;
    const via = uniq((byProfile ?? []).map((p) => (p as { auth_user_id: string | null }).auth_user_id));
    return uniq([...matched, ...via]);
  } catch {
    return input;
  }
}

export async function studentIdsToAuthUserIds(studentIds: string[]): Promise<string[]> {
  if (!studentIds.length) return [];
  try {
    const { data: students, error } = await supabase
      .from("students")
      .select("id, profile_id, profiles(auth_user_id)")
      .in("id", studentIds);
    if (!error && students?.length) {
      const auth = [
        ...new Set(
          (students as { profiles?: { auth_user_id?: string | null } | null }[])
            .map((s) => s.profiles?.auth_user_id)
            .filter((x): x is string => Boolean(x)),
        ),
      ];
      if (auth.length) return auth;
    }
    return resolveAuthUserIds(studentIds);
  } catch {
    return resolveAuthUserIds(studentIds);
  }
}

async function resolveStudentAuthIds(opts: {
  schoolId?: string | null;
  studentAuthUserIds?: string[] | null;
  studentIds?: string[] | null;
}): Promise<string[]> {
  const fromAuth = [...new Set((opts.studentAuthUserIds ?? []).filter(Boolean))];
  const fromStudents = await studentIdsToAuthUserIds([...(opts.studentIds ?? [])].filter(Boolean));
  const merged = [...new Set([...fromAuth, ...fromStudents])];
  if (!merged.length) return [];
  return resolveAuthUserIds(merged, opts.schoolId);
}

export async function notifyUser(p: NotifyPayload): Promise<string | null> {
  if (!p.recipientUserId) return null;
  try {
    const resolved = await resolveAuthUserIds([p.recipientUserId], p.schoolId);
    p = { ...p, recipientUserId: resolved[0] || p.recipientUserId };

    if (p.dedupeMinutes && p.entityId) {
      const since = new Date(Date.now() - p.dedupeMinutes * 60_000).toISOString();
      let q = supabase
        .from("notifications")
        .select("id")
        .eq("recipient_user_id", p.recipientUserId)
        .eq("type", p.type || "info")
        .gte("created_at", since)
        .limit(1);
      if (p.entityId) q = q.eq("entity_id" as never, p.entityId as never);
      const { data: existing } = await q.maybeSingle();
      if (existing?.id) return existing.id as string;
    }

    const { data: rpcId, error: rpcErr } = await supabase.rpc("insert_notification" as never, {
      _recipient: p.recipientUserId,
      _title: p.title,
      _message: p.message,
      _type: p.type || "info",
      _school_id: p.schoolId ?? null,
      _link: p.link ?? null,
      _entity_type: p.entityType ?? null,
      _entity_id: p.entityId ?? null,
    } as never);

    if (!rpcErr && rpcId) {
      await firePush(p.recipientUserId, p.title, p.message, p.link ?? null, p.actionLabel);
      return String(rpcId);
    }

    const row: Record<string, unknown> = {
      recipient_user_id: p.recipientUserId,
      title: p.title,
      message: p.message,
      type: p.type || "info",
    };
    if (p.schoolId) row.school_id = p.schoolId;
    if (p.link) {
      row.link = p.link;
      row.action_url = p.link;
    }
    if (p.entityType) row.entity_type = p.entityType;
    if (p.entityId) row.entity_id = String(p.entityId);

    const { data, error } = await supabase.from("notifications").insert(row as never).select("id").maybeSingle();
    if (error) {
      console.warn("[notify] insert failed", error.message);
      return null;
    }
    if (data?.id) await firePush(p.recipientUserId, p.title, p.message, p.link ?? null, p.actionLabel);
    return (data?.id as string) ?? null;
  } catch (e) {
    console.warn("[notify] error:", e);
    return null;
  }
}

export async function notifyMany(payloads: NotifyPayload[]): Promise<void> {
  await Promise.all(payloads.map((p) => notifyUser(p)));
}

export async function listOfficerUserIds(schoolId: string): Promise<string[]> {
  const uniq = (ids: (string | null | undefined)[]) =>
    [...new Set(ids.filter((x): x is string => Boolean(x)))];
  try {
    const { data: bySchool } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("school_id", schoolId)
      .eq("role", "examination_officer");
    const ids = uniq((bySchool ?? []).map((r) => (r as { user_id: string }).user_id));
    if (ids.length) {
      const resolved = await resolveAuthUserIds(ids, schoolId);
      return resolved.length ? resolved : ids;
    }
    return [];
  } catch {
    return [];
  }
}

export async function listAdminUserIds(schoolId: string): Promise<string[]> {
  try {
    const { data: roles } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("school_id", schoolId)
      .eq("role", "school_admin");
    const ids = [...new Set((roles ?? []).map((r) => (r as { user_id: string }).user_id).filter(Boolean))];
    if (!ids.length) return [];
    const resolved = await resolveAuthUserIds(ids, schoolId);
    return resolved.length ? resolved : ids;
  } catch {
    return [];
  }
}

export async function listTeacherUserIds(schoolId: string): Promise<string[]> {
  try {
    const { data: roles } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("school_id", schoolId)
      .eq("role", "teacher");
    const fromRoles = [...new Set((roles ?? []).map((r) => (r as { user_id: string }).user_id).filter(Boolean))];
    if (fromRoles.length) {
      const resolved = await resolveAuthUserIds(fromRoles, schoolId);
      return resolved.length ? resolved : fromRoles;
    }
    return [];
  } catch {
    return [];
  }
}

export async function listSuperAdminUserIds(): Promise<string[]> {
  try {
    const { data: roles } = await supabase.from("user_roles").select("user_id").eq("role", "super_admin");
    return [...new Set((roles ?? []).map((r) => (r as { user_id: string }).user_id).filter(Boolean))];
  } catch {
    return [];
  }
}

async function schoolNameById(schoolId: string | null | undefined): Promise<string> {
  if (!schoolId) return "A school";
  try {
    const { data } = await supabase.from("schools").select("name").eq("id", schoolId).maybeSingle();
    return (data as { name?: string } | null)?.name || "A school";
  } catch {
    return "A school";
  }
}

async function examTitleById(examId: string | null | undefined): Promise<string> {
  if (!examId) return "Examination";
  try {
    const { data } = await supabase.from("examinations").select("title").eq("id", examId).maybeSingle();
    return (data as { title?: string } | null)?.title || "Examination";
  } catch {
    return "Examination";
  }
}

async function studentDisplayName(studentId: string | null | undefined): Promise<string> {
  if (!studentId) return "A student";
  try {
    const { data: st } = await supabase
      .from("students")
      .select("matric_number, profiles(full_name)")
      .eq("id", studentId)
      .maybeSingle();
    const name = (st as { profiles?: { full_name?: string } | null } | null)?.profiles?.full_name;
    const matric = (st as { matric_number?: string } | null)?.matric_number;
    return name || matric || "A student";
  } catch {
    return "A student";
  }
}

async function studentDisplayNameFromAuth(authUserId: string): Promise<string> {
  if (!authUserId) return "";
  try {
    const { data } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    return String((data as { full_name?: string } | null)?.full_name || "").trim();
  } catch {
    return "";
  }
}


async function authUserDisplayNames(authIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(authIds.filter(Boolean))];
  if (!uniq.length) return map;
  try {
    const { data } = await supabase.from("profiles").select("auth_user_id, full_name").in("auth_user_id", uniq);
    for (const row of data ?? []) {
      const r = row as { auth_user_id?: string | null; full_name?: string | null };
      if (r.auth_user_id) map.set(r.auth_user_id, (r.full_name || "").trim() || "Student");
    }
  } catch { /* ignore */ }
  return map;
}

function formatExamWhen(iso: string | null | undefined): { date: string; time: string; full: string } {
  if (!iso) return { date: "", time: "", full: "" };
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: "", time: "", full: "" };
    const date = d.toLocaleDateString(undefined, { dateStyle: "medium" });
    const time = d.toLocaleTimeString(undefined, { timeStyle: "short" });
    return { date, time, full: `${date} at ${time}` };
  } catch { return { date: "", time: "", full: "" }; }
}

async function courseStudentAuthIds(courseId: string | null | undefined, schoolId: string): Promise<string[]> {
  try {
    if (courseId) {
      const sids: string[] = [];
      const { data: sc } = await supabase
        .from("student_courses")
        .select("student_id")
        .eq("course_id", courseId)
        .eq("school_id", schoolId)
        .limit(3000);
      for (const r of sc ?? []) {
        const id = (r as { student_id?: string }).student_id;
        if (id) sids.push(id);
      }
      if (!sids.length) {
        const { data: enroll } = await supabase
          .from("course_enrollments")
          .select("student_id")
          .eq("course_id", courseId)
          .limit(3000);
        for (const r of enroll ?? []) {
          const id = (r as { student_id?: string }).student_id;
          if (id) sids.push(id);
        }
      }
      if (sids.length) return studentIdsToAuthUserIds([...new Set(sids)]);
    }
    const { data: roles } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("school_id", schoolId)
      .eq("role", "student")
      .limit(3000);
    const fromRoles = [...new Set((roles ?? []).map((r) => (r as { user_id: string }).user_id).filter(Boolean))];
    if (fromRoles.length) return fromRoles;
    const { data: students } = await supabase
      .from("students")
      .select("id, profiles(auth_user_id)")
      .eq("school_id", schoolId)
      .limit(3000);
    const auth: string[] = [];
    for (const s of students ?? []) {
      const aid = (s as { profiles?: { auth_user_id?: string | null } | null }).profiles?.auth_user_id;
      if (aid) auth.push(aid);
    }
    if (auth.length) return [...new Set(auth)];
    return studentIdsToAuthUserIds((students ?? []).map((s) => (s as { id: string }).id).filter(Boolean));
  } catch (e) {
    console.warn("[notify] courseStudentAuthIds failed", e);
    return [];
  }
}

export async function notifyOfficersStudentResultPending(opts: {
  schoolId: string;
  examId?: string | null;
  examTitle: string;
  studentName: string;
  studentId?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
}): Promise<void> {
  try {
    const officers = await listOfficerUserIds(opts.schoolId);
    if (!officers.length) return;
    const link = "/officer/results";
    const copy = Msg.officerResultAwaitingReview({
      studentName: opts.studentName,
      examTitle: opts.examTitle,
      courseCode: opts.courseCode,
      courseTitle: opts.courseTitle,
      link,
    });
    await notifyMany(
      officers.map((uid) => ({
        recipientUserId: uid,
        schoolId: opts.schoolId,
        title: copy.title,
        message: copy.message,
        type: "result_pending_release",
        link: templateLink(copy, link),
        actionLabel: copy.action?.label ?? "REVIEW RESULT",
        entityType: "examination",
        entityId: opts.examId || opts.examTitle,
        dedupeMinutes: 15,
      })),
    );
  } catch (e) {
    console.warn("[notify] notifyOfficersStudentResultPending failed", e);
  }
}

export async function notifyStudentResultPublished(opts: {
  studentUserId: string;
  schoolId?: string | null;
  examId: string;
  examTitle: string;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentName?: string | null;
  username?: string | null;
  officerName?: string | null;
}): Promise<void> {
  try {
    const link = "/student/results";
    const name =
      (opts.studentName || "").trim() ||
      (await studentDisplayNameFromAuth(opts.studentUserId)) ||
      "Student";
    const copy = Msg.studentResultReady({
      studentName: name,
      username: opts.username,
      examTitle: opts.examTitle,
      courseCode: opts.courseCode,
      courseTitle: opts.courseTitle,
      officerName: opts.officerName,
      link,
    });
    await notifyUser({
      recipientUserId: opts.studentUserId,
      schoolId: opts.schoolId,
      title: copy.title,
      message: copy.message,
      type: "result_published",
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? null,
      entityType: "examination",
      entityId: opts.examId,
    });
  } catch (e) {
    console.warn("[notify] notifyStudentResultPublished failed", e);
  }
}

export async function notifyStudentsResultsReleased(opts: {
  schoolId: string;
  examId?: string;
  examTitle: string;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentAuthUserIds?: string[];
  studentIds?: string[];
}): Promise<void> {
  try {
    const authIds = await resolveStudentAuthIds(opts);
    const examId = opts.examId || "released";
    const link = "/student/results";
    const names = await Promise.all(
      authIds.map(async (uid) => [uid, await studentDisplayNameFromAuth(uid)] as const),
    );
    const nameMap = new Map(names);
    await notifyMany(
      authIds.map((uid) => {
        const copy = Msg.studentResultReady({
          studentName: nameMap.get(uid) || "Student",
          examTitle: opts.examTitle,
          courseCode: opts.courseCode,
          courseTitle: opts.courseTitle,
          link,
        });
        return {
          recipientUserId: uid,
          schoolId: opts.schoolId,
          title: copy.title,
          message: copy.message,
          type: "result_published",
          link: templateLink(copy, link),
          actionLabel: copy.action?.label ?? null,
          entityType: "examination",
          entityId: examId,
          dedupeMinutes: 30,
        };
      }),
    );
  } catch (e) {
    console.warn("[notify] notifyStudentsResultsReleased failed", e);
  }
}

export async function notifyStudentExamSubmitted(opts: {
  studentUserId: string;
  schoolId?: string | null;
  examId: string;
  examTitle: string;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentName?: string | null;
  username?: string | null;
}): Promise<void> {
  try {
    const link = "/student/examinations";
    const name =
      (opts.studentName || "").trim() ||
      (await studentDisplayNameFromAuth(opts.studentUserId)) ||
      "Student";
    const copy = Msg.studentExamSubmitted({
      studentName: name,
      username: opts.username,
      examTitle: opts.examTitle,
      courseCode: opts.courseCode,
      courseTitle: opts.courseTitle,
      link,
    });
    await notifyUser({
      recipientUserId: opts.studentUserId,
      schoolId: opts.schoolId,
      title: copy.title,
      message: copy.message,
      type: "exam_submitted",
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? null,
      entityType: "examination",
      entityId: opts.examId,
    });
  } catch (e) {
    console.warn("[notify] notifyStudentExamSubmitted failed", e);
  }
}

export async function notifyStudentOfficerWarning(opts: {
  studentUserId?: string | null;
  studentId?: string | null;
  schoolId?: string | null;
  examId?: string | null;
  message: string;
  violationCount?: number | null;
  studentName?: string | null;
  username?: string | null;
}): Promise<void> {
  try {
    let uid = (opts.studentUserId || "").trim();
    if (!uid && opts.studentId) {
      const ids = await studentIdsToAuthUserIds([opts.studentId]);
      uid = ids[0] || "";
    }
    if (!uid) return;
    const link = "/student/examinations";
    const name =
      (opts.studentName || "").trim() ||
      (await studentDisplayNameFromAuth(uid)) ||
      "Student";
    const copy = Msg.studentExamWarning({
      studentName: name,
      username: opts.username,
      message: opts.message,
      violationCount: opts.violationCount,
      link,
    });
    await notifyUser({
      recipientUserId: uid,
      schoolId: opts.schoolId,
      title: copy.title,
      message: copy.message,
      type: "officer_warning",
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? null,
      entityType: "examination",
      entityId: opts.examId || undefined,
      dedupeMinutes: 2,
    });
  } catch (e) {
    console.warn("[notify] notifyStudentOfficerWarning failed", e);
  }
}

export async function notifyStudentsResultsHeld(opts: {
  schoolId: string;
  examId?: string;
  examTitle: string;
  studentAuthUserIds?: string[];
  studentIds?: string[];
  reason?: string | null;
}): Promise<void> {
  try {
    const authIds = await resolveStudentAuthIds(opts);
    const link = "/student/results";
    const reasonBody = (opts.reason || "").trim();
    await notifyMany(
      authIds.map((uid) => {
        let body =
          "Your examination result has been held by the Departmental Officer.\n\n" +
          `📝 Examination: ${opts.examTitle}`;
        if (reasonBody) body += `\n\nReason:\n${reasonBody}`;
        body += "\n\nPlease check D4EXAM for further instructions.";
        const copy = Msg.roleNotification({
          name: "Student",
          role: "Student",
          title: "Result Held",
          message: body,
          link,
          actionLabel: "VIEW RESULT",
        });
        return {
          recipientUserId: uid,
          schoolId: opts.schoolId,
          title: copy.title,
          message: copy.message,
          type: "result_pending_release",
          link: templateLink(copy, link),
          actionLabel: copy.action?.label ?? null,
          entityType: "examination",
          entityId: opts.examId || "held",
          dedupeMinutes: 30,
        };
      }),
    );
  } catch (e) {
    console.warn("[notify] notifyStudentsResultsHeld failed", e);
  }
}


export async function notifyStudentsExamRescheduled(opts: {
  schoolId: string;
  studentIds: string[];
  examTitle: string;
  reason?: string | null;
  windowLabel?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  start?: string | null;
  end?: string | null;
}): Promise<void> {
  try {
    const authIds = await studentIdsToAuthUserIds(opts.studentIds);
    if (!authIds.length) return;
    const link = "/student/examinations";
    const names = await authUserDisplayNames(authIds);
    await notifyMany(
      authIds.map((uid) => {
        const copy = Msg.studentExamRescheduled({
          studentName: names.get(uid) || "Student",
          examTitle: opts.examTitle,
          courseCode: opts.courseCode,
          courseTitle: opts.courseTitle,
          start: opts.start,
          end: opts.end,
          link,
        });
        let message = copy.message;
        if (opts.windowLabel) message += `\n\nNew window: ${opts.windowLabel}`;
        return {
          recipientUserId: uid,
          schoolId: opts.schoolId,
          title: copy.title,
          message,
          type: "exam_scheduled",
          link: templateLink(copy, link),
          actionLabel: copy.action?.label ?? "VIEW SCHEDULE",
          entityType: "examination",
          entityId: opts.examTitle,
          dedupeMinutes: 20,
        };
      }),
    );
  } catch (e) {
    console.warn("[notify] notifyStudentsExamRescheduled failed", e);
  }
}

export async function notifyStudentsRewriteAllowed(opts: {
  schoolId: string;
  examId?: string;
  examTitle: string;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentAuthUserIds?: string[];
  studentIds?: string[];
  reason?: string | null;
}): Promise<void> {
  try {
    const authIds = await resolveStudentAuthIds(opts);
    const link = "/student/examinations";
    const reason = (opts.reason || "").trim();
    await notifyMany(
      authIds.map((uid) => {
        const copy = Msg.roleNotification({
          name: "Student",
          role: "Student",
          title: "Rewrite Required",
          message:
            `You are required to rewrite your examination.

` +
            `📝 Examination: ${opts.examTitle}` +
            (reason ? `

Reason:
${reason}` : "") +
            `

Please open D4EXAM to start when ready.`,
          link,
          actionLabel: "VIEW EXAM",
        });
        return {
          recipientUserId: uid,
          schoolId: opts.schoolId,
          title: copy.title,
          message: copy.message,
          type: "exam_available",
          link: templateLink(copy, link),
          actionLabel: copy.action?.label ?? null,
          entityType: "examination",
          entityId: opts.examId || "rewrite",
          dedupeMinutes: 30,
        };
      }),
    );
  } catch (e) {
    console.warn("[notify] notifyStudentsRewriteAllowed failed", e);
  }
}

export async function notifyStudentResultTerminated(opts: {
  studentUserId?: string;
  studentId?: string;
  schoolId?: string | null;
  examId?: string;
  examTitle: string;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentName?: string | null;
  username?: string | null;
  reason?: string | null;
}): Promise<void> {
  try {
    let uid = opts.studentUserId;
    if (!uid && opts.studentId) {
      const ids = await studentIdsToAuthUserIds([opts.studentId]);
      uid = ids[0];
    }
    if (!uid) return;
    const link = "/student/results";
    const name =
      (opts.studentName || "").trim() ||
      (await studentDisplayNameFromAuth(uid)) ||
      "Student";
    const copy = Msg.studentExamTerminated({
      studentName: name,
      username: opts.username,
      examTitle: opts.examTitle,
      courseCode: opts.courseCode,
      courseTitle: opts.courseTitle,
      reason: opts.reason,
      link,
    });
    await notifyUser({
      recipientUserId: uid,
      schoolId: opts.schoolId,
      title: copy.title,
      message: copy.message,
      type: "warning",
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? null,
      entityType: "examination",
      entityId: opts.examId || null,
    });
  } catch (e) {
    console.warn("[notify] notifyStudentResultTerminated failed", e);
  }
}

export async function notifyOfficersExamSubmitted(opts: {
  schoolId: string;
  examId: string;
  examTitle: string;
  teacherName?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  courseLabel?: string | null;
}): Promise<void> {
  try {
    const officers = await listOfficerUserIds(opts.schoolId);
    if (!officers.length) return;
    const teacherName = (opts.teacherName || "A teacher").trim();
    await notifyMany(
      officers.map((uid) => {
        const link = "/officer/approvals";
        const copy = Msg.officerExamSubmittedForReview({
          teacherName,
          examTitle: opts.examTitle,
          courseCode: opts.courseCode ?? opts.courseLabel,
          courseTitle: opts.courseTitle,
          courseLabel: opts.courseLabel,
          link,
        });
        return {
          recipientUserId: uid,
          schoolId: opts.schoolId,
          title: copy.title,
          message: copy.message,
          type: "exam_submitted",
          link: templateLink(copy, link),
          actionLabel: copy.action?.label ?? null,
          entityType: "examination",
          entityId: opts.examId,
          dedupeMinutes: 10,
        };
      }),
    );
  
    try {
      const { sendOfficerExamSubmittedEmail } = await import("@/lib/email.server");
      const { data: profs } = await supabase
        .from("profiles")
        .select("auth_user_id, full_name, email")
        .in("auth_user_id", officers);
      const courseLabel = opts.courseCode || opts.courseTitle || opts.courseLabel || null;
      for (const pr of profs ?? []) {
        const row = pr as { email?: string | null; full_name?: string | null };
        const em = (row.email || "").trim();
        if (!em || !em.includes("@") || em.endsWith(".local")) continue;
        void sendOfficerExamSubmittedEmail({
          to: em,
          officerName: row.full_name,
          teacherName,
          examTitle: opts.examTitle,
          courseLabel,
        });
      }
    } catch (ee) {
      console.warn("[email] officer exam submitted", ee);
    }
} catch (e) {
    console.warn("[notify] notifyOfficersExamSubmitted failed", e);
  }
}

export async function notifyTeacherExamDecision(opts: {
  teacherUserId: string;
  schoolId?: string | null;
  examId: string;
  examTitle: string;
  decision:
    | "approved"
    | "rejected"
    | "revision_requested"
    | "approve"
    | "reject"
    | "changes"
    | string;
  note?: string | null;
  comment?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  officerName?: string | null;
  start?: string | null;
  end?: string | null;
  scheduleNote?: string | null;
}): Promise<void> {
  try {
    const link = "/teacher/examinations";
    const teacherName = (await studentDisplayNameFromAuth(opts.teacherUserId)) || "Teacher";
    const note = (opts.note ?? opts.comment ?? "").trim() || null;
    const raw = String(opts.decision || "").toLowerCase().trim();
    let decision: "approved" | "rejected" | "revision_requested";
    if (raw === "approved" || raw === "approve") decision = "approved";
    else if (raw === "rejected" || raw === "reject") decision = "rejected";
    else if (
      raw === "revision_requested" ||
      raw === "changes" ||
      raw === "request_changes" ||
      raw === "changes_requested"
    )
      decision = "revision_requested";
    else {
      console.warn("[notify] unknown exam decision:", opts.decision);
      decision = "revision_requested";
    }
    let copy: Msg.NotificationTemplate;
    let type: NotifyType = "info";
    if (decision === "approved") {
      type = "exam_approved";
      copy = Msg.teacherExamApproved({
        teacherName,
        examTitle: opts.examTitle,
        courseCode: opts.courseCode,
        courseTitle: opts.courseTitle,
        officerName: opts.officerName,
        start: opts.start,
        end: opts.end,
        link,
      });
    } else if (decision === "rejected") {
      type = "exam_rejected";
      copy = Msg.teacherExamRejected({
        teacherName,
        examTitle: opts.examTitle,
        courseCode: opts.courseCode,
        courseTitle: opts.courseTitle,
        reason: note,
        note,
        link,
      });
    } else {
      type = "exam_revision_requested";
      copy = Msg.teacherExamRevisionRequested({
        teacherName,
        examTitle: opts.examTitle,
        courseCode: opts.courseCode,
        courseTitle: opts.courseTitle,
        note,
        link,
      });
    }
    let message = copy.message;
    if (opts.scheduleNote) message = `${copy.message}\n${opts.scheduleNote}`;
    await notifyUser({
      recipientUserId: opts.teacherUserId,
      schoolId: opts.schoolId,
      title: copy.title,
      message,
      type,
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? null,
      entityType: "examination",
      entityId: opts.examId,
    });
  } catch (e) {
    console.warn("[notify] notifyTeacherExamDecision failed", e);
  }
}

export async function notifyStudentsExamApproved(opts: {
  schoolId: string;
  examId: string;
  examTitle: string;
  studentIds?: string[];
  studentAuthUserIds?: string[];
  courseCode?: string | null;
  courseTitle?: string | null;
  /** Optional course UUID — used to resolve enrolled students */
  courseId?: string | null;
  start?: string | null;
  end?: string | null;
  /** @deprecated alias for start */
  scheduledStart?: string | null;
  /** @deprecated alias for end */
  scheduledEnd?: string | null;
  /** When true (officer Post to students), use "exam available" template */
  availableNow?: boolean;
}): Promise<void> {
  try {
    const startIso = opts.start ?? opts.scheduledStart ?? null;
    const endIso = opts.end ?? opts.scheduledEnd ?? null;

    // Resolve recipients: explicit list → course enrollments → school students
    let authIds = await resolveStudentAuthIds(opts);
    if (!authIds.length) {
      authIds = await courseStudentAuthIds(opts.courseId ?? null, opts.schoolId);
    }
    if (!authIds.length) {
      console.warn("[notify] notifyStudentsExamApproved: no student recipients", {
        schoolId: opts.schoolId,
        examId: opts.examId,
        courseId: opts.courseId,
      });
      return;
    }

    // Resolve course labels when only courseId was provided
    let courseCode = opts.courseCode ?? null;
    let courseTitle = opts.courseTitle ?? null;
    if (opts.courseId && (!courseCode || !courseTitle)) {
      try {
        const { data } = await supabase
          .from("courses")
          .select("code, name")
          .eq("id", opts.courseId)
          .maybeSingle();
        const c = data as { code?: string; name?: string } | null;
        if (c) {
          courseCode = courseCode || c.code || null;
          courseTitle = courseTitle || c.name || null;
        }
      } catch {
        /* ignore */
      }
    }

    const link = "/student/examinations";
    const names = await authUserDisplayNames(authIds);
    const availableNow = Boolean((opts as { availableNow?: boolean }).availableNow);
    await notifyMany(
      authIds.map((uid) => {
        const studentName = names.get(uid) || "Student";
        const copy = availableNow
          ? (Msg as any).studentExamAvailableDetailed({
              studentName,
              examTitle: opts.examTitle,
              courseCode,
              courseTitle,
              start: startIso,
              end: endIso,
              link,
            })
          : Msg.studentExamScheduled({
              studentName,
              examTitle: opts.examTitle,
              courseCode,
              courseTitle,
              start: startIso,
              end: endIso,
              link,
            });
        return {
          recipientUserId: uid,
          schoolId: opts.schoolId,
          title: copy.title,
          message: copy.message,
          type: (availableNow ? "exam_available" : "exam_scheduled") as NotifyType,
          link: templateLink(copy, link),
          actionLabel: copy.action?.label ?? (availableNow ? "START EXAM" : "VIEW EXAM"),
          entityType: "examination",
          entityId: opts.examId,
          dedupeMinutes: 30,
        };
      }),
    );
  } catch (e) {
    console.warn("[notify] notifyStudentsExamApproved failed", e);
  }
}

export async function notifyStudentExamAvailable(opts: {
  studentUserId: string;
  schoolId?: string | null;
  examId: string;
  examTitle: string;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentName?: string | null;
  username?: string | null;
  start?: string | null;
  end?: string | null;
}): Promise<void> {
  try {
    const link = "/student/examinations";
    const name =
      (opts.studentName || "").trim() ||
      (await studentDisplayNameFromAuth(opts.studentUserId)) ||
      "Student";
    // Notification 20.0 scheduled template (name + exam + schedule)
    const copy = Msg.studentExamScheduled({
      studentName: name,
      username: opts.username,
      examTitle: opts.examTitle,
      courseCode: opts.courseCode,
      courseTitle: opts.courseTitle,
      start: opts.start,
      end: opts.end,
      link,
    });
    await notifyUser({
      recipientUserId: opts.studentUserId,
      schoolId: opts.schoolId,
      title: copy.title,
      message: copy.message,
      type: "exam_available",
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? "START EXAM",
      entityType: "examination",
      entityId: opts.examId,
      dedupeMinutes: 30,
    });
  } catch (e) {
    console.warn("[notify] notifyStudentExamAvailable failed", e);
  }
}

export async function notifySuperAdminsOfApplication(opts: {
  schoolName: string;
  applicationId: string;
  trackingCode?: string;
  applicantName?: string | null;
  applicantUsername?: string | null;
}): Promise<void> {
  try {
    const ids = await listSuperAdminUserIds();
    const link = "/super-admin/applications";
    const copy = Msg.newSchoolApplication({
      schoolName: opts.schoolName,
      applicantName: opts.applicantName,
      applicantUsername: opts.applicantUsername ?? opts.trackingCode,
      link,
    });
    await notifyMany(
      ids.map((uid) => ({
        recipientUserId: uid,
        title: copy.title,
        message: copy.message,
        type: "system_alert",
        link: templateLink(copy, link),
        actionLabel: copy.action?.label ?? "VIEW APPLICATION",
        entityType: "school_application",
        entityId: opts.applicationId,
        dedupeMinutes: 5,
      })),
    );
  } catch (e) {
    console.warn("[notify] notifySuperAdminsOfApplication failed", e);
  }
}

export async function notifySuperAdminsStudentsAdded(opts: {
  schoolId: string;
  count: number;
  schoolName?: string;
}): Promise<void> {
  try {
    if (opts.count < 1) return;
    const name = opts.schoolName || (await schoolNameById(opts.schoolId));
    const ids = await listSuperAdminUserIds();
    const link = "/super-admin/schools";
    const copy = Msg.newStudentRegistered({
      studentName: `${opts.count} new student(s)`,
      schoolName: name,
      link,
    });
    // Prefer 20.0 weekly-style summary for batch adds
    const batch = Msg.weeklyEnrollmentUpdate({
      schoolName: name,
      students: opts.count,
      link,
    });
    await notifyMany(
      ids.map((uid) => ({
        recipientUserId: uid,
        title: batch.title,
        message: batch.message,
        type: "system_alert",
        link: templateLink(batch, link),
        actionLabel: batch.action?.label ?? "VIEW STUDENTS",
        entityType: "school",
        entityId: opts.schoolId,
        dedupeMinutes: 5,
      })),
    );
  } catch (e) {
    console.warn("[notify] notifySuperAdminsStudentsAdded failed", e);
  }
}


export async function notifySuperAdminsTeachersAdded(opts: {
  schoolId: string;
  count: number;
  schoolName?: string;
}): Promise<void> {
  try {
    if (opts.count < 1) return;
    const name = opts.schoolName || (await schoolNameById(opts.schoolId));
    const ids = await listSuperAdminUserIds();
    const link = "/super-admin/schools";
    const copy = Msg.newTeacherRegistered({
      teacherName: `${opts.count} new teacher(s)`,
      schoolName: name,
      link,
    });
    await notifyMany(
      ids.map((uid) => ({
        recipientUserId: uid,
        title: copy.title,
        message:
          copy.message +
          (opts.count > 1 ? `\n\nCount: ${opts.count} teachers were added.` : ""),
        type: "system_alert",
        link: templateLink(copy, link),
        actionLabel: copy.action?.label ?? "VIEW DETAILS",
        entityType: "school",
        entityId: opts.schoolId,
        dedupeMinutes: 5,
      })),
    );
  } catch (e) {
    console.warn("[notify] notifySuperAdminsTeachersAdded failed", e);
  }
}


export async function notifyExamCompleted(opts: {
  schoolId: string;
  examId?: string;
  examTitle: string;
  courseCode?: string | null;
  courseTitle?: string | null;
  attempted?: number;
  submitted?: number;
}): Promise<void> {
  try {
    const officers = await listOfficerUserIds(opts.schoolId);
    const admins = await listAdminUserIds(opts.schoolId);
    const recipients = [...new Set([...officers, ...admins])];
    if (!recipients.length) return;
    const school = await schoolNameById(opts.schoolId);
    const exam = [opts.courseCode, opts.examTitle || opts.courseTitle].filter(Boolean).join(" — ") || opts.examTitle;
    const counts =
      opts.attempted != null || opts.submitted != null
        ? `\n\n📊 Attempts: ${opts.attempted ?? "—"}\n✅ Submitted: ${opts.submitted ?? "—"}`
        : "";
    const link = "/officer/results";
    const copy = Msg.systemAlert({
      title: "Examination Completed",
      message:
        `The examination has been completed.\n\n` +
        `🏫 School: ${school}\n` +
        `📝 Examination: ${exam}` +
        counts +
        `\n\nResults and monitoring records are available for review.`,
      link,
      actionLabel: "VIEW RESULTS",
    });
    await notifyMany(
      recipients.map((uid) => ({
        recipientUserId: uid,
        schoolId: opts.schoolId,
        title: copy.title,
        message: copy.message,
        type: "info",
        link: templateLink(copy, link),
        actionLabel: copy.action?.label ?? "VIEW RESULTS",
        entityType: "examination",
        entityId: opts.examId || opts.examTitle,
        dedupeMinutes: 30,
      })),
    );
  } catch (e) {
    console.warn("[notify] notifyExamCompleted failed", e);
  }
}


export async function notifyStudentsNewMaterial(opts: {
  schoolId: string;
  courseId?: string | null;
  courseLabel?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  materialTitle?: string | null;
  kind?: string | null;
  studentAuthUserIds?: string[];
  studentIds?: string[];
}): Promise<void> {
  try {
    let authIds = await resolveStudentAuthIds(opts);
    if (!authIds.length && opts.courseId) {
      authIds = await courseStudentAuthIds(opts.courseId, opts.schoolId);
    }
    if (!authIds.length) return;
    const course =
      opts.courseCode ||
      opts.courseTitle ||
      opts.courseLabel ||
      "your course";
    const kind = (opts.kind || "material").trim();
    const label = opts.materialTitle?.trim() ? `: ${opts.materialTitle.trim()}` : "";
    const link = "/student/materials";
    const names = await authUserDisplayNames(authIds);
    await notifyMany(
      authIds.map((uid) => {
        const studentName = names.get(uid) || "Student";
        const copy = Msg.roleNotification({
          name: studentName,
          role: "Student",
          title: "New Study Material",
          message:
            `New study material has been uploaded.\n\n` +
            `📚 Type: ${kind}${label}\n` +
            `📖 Course: ${course}\n\n` +
            `Open D4EXAM to view the material.`,
          link,
          actionLabel: "VIEW MATERIAL",
        });
        return {
          recipientUserId: uid,
          schoolId: opts.schoolId,
          title: copy.title,
          message: copy.message,
          type: "info",
          link: templateLink(copy, link),
          actionLabel: copy.action?.label ?? "VIEW MATERIAL",
          entityType: "material",
          entityId: opts.courseId || "material",
          dedupeMinutes: 30,
        };
      }),
    );
  } catch (e) {
    console.warn("[notify] notifyStudentsNewMaterial failed", e);
  }
}


export async function notifyStudentExamTerminated(opts: {
  studentUserId?: string | null;
  studentId?: string | null;
  schoolId?: string | null;
  examId?: string | null;
  examTitle?: string | null;
  reason?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentName?: string | null;
  username?: string | null;
}): Promise<void> {
  try {
    let uid = (opts.studentUserId || "").trim();
    if (!uid && opts.studentId) {
      const ids = await studentIdsToAuthUserIds([opts.studentId]);
      uid = ids[0] || "";
    }
    if (!uid) return;
    const link = "/student/examinations";
    const name =
      (opts.studentName || "").trim() ||
      (await studentDisplayNameFromAuth(uid)) ||
      "Student";
    const copy = Msg.studentExamTerminated({
      studentName: name,
      username: opts.username,
      examTitle: opts.examTitle,
      courseCode: opts.courseCode,
      courseTitle: opts.courseTitle,
      reason: opts.reason,
      link,
    });
    await notifyUser({
      recipientUserId: uid,
      schoolId: opts.schoolId,
      title: copy.title,
      message: copy.message,
      type: "error",
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? null,
      entityType: "examination",
      entityId: opts.examId || undefined,
    });
  } catch (e) {
    console.warn("[notify] notifyStudentExamTerminated failed", e);
  }
}

export async function notifyStudentExamAutoSubmitted(opts: {
  studentUserId?: string | null;
  studentId?: string | null;
  schoolId?: string | null;
  examId?: string | null;
  examTitle?: string | null;
  reason?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentName?: string | null;
  username?: string | null;
}): Promise<void> {
  try {
    let uid = (opts.studentUserId || "").trim();
    if (!uid && opts.studentId) {
      const ids = await studentIdsToAuthUserIds([opts.studentId]);
      uid = ids[0] || "";
    }
    if (!uid) return;
    const link = "/student/examinations";
    const name =
      (opts.studentName || "").trim() ||
      (await studentDisplayNameFromAuth(uid)) ||
      "Student";
    const copy = Msg.studentAutoSubmitted({
      studentName: name,
      username: opts.username,
      examTitle: opts.examTitle,
      courseCode: opts.courseCode,
      courseTitle: opts.courseTitle,
      reason: opts.reason,
      link,
    });
    await notifyUser({
      recipientUserId: uid,
      schoolId: opts.schoolId,
      title: copy.title,
      message: copy.message,
      type: "warning",
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? null,
      entityType: "examination",
      entityId: opts.examId || undefined,
    });
  } catch (e) {
    console.warn("[notify] notifyStudentExamAutoSubmitted failed", e);
  }
}


export async function notifyStudentExamReminder(opts: {
  studentUserId: string;
  schoolId?: string | null;
  examId: string;
  examTitle: string;
  kind: "24h" | "30m" | "10m" | "start";
  courseCode?: string | null;
  courseTitle?: string | null;
  studentName?: string | null;
  username?: string | null;
}): Promise<void> {
  try {
    const link = "/student/examinations";
    const name =
      (opts.studentName || "").trim() ||
      (await studentDisplayNameFromAuth(opts.studentUserId)) ||
      "Student";
    const copy = Msg.studentExamReminder({
      studentName: name,
      username: opts.username,
      examTitle: opts.examTitle,
      courseCode: opts.courseCode,
      courseTitle: opts.courseTitle,
      kind: opts.kind,
      link,
    });
    await notifyUser({
      recipientUserId: opts.studentUserId,
      schoolId: opts.schoolId,
      title: copy.title,
      message: copy.message,
      type: "exam_available",
      link: templateLink(copy, link),
      actionLabel: copy.action?.label ?? null,
      entityType: `exam_reminder_${opts.kind}`,
      entityId: opts.examId,
      dedupeMinutes: opts.kind === "start" ? 45 : opts.kind === "10m" ? 20 : opts.kind === "30m" ? 40 : 12 * 60,
    });
  } catch (e) {
    console.warn("[notify] notifyStudentExamReminder failed", e);
  }
}

export async function notifyOfficersStudentViolation(opts: {
  schoolId: string;
  examId?: string | null;
  examTitle?: string | null;
  courseCode?: string | null;
  courseTitle?: string | null;
  studentName?: string | null;
  eventType?: string | null;
  detail?: string | null;
}): Promise<void> {
  try {
    const officers = await listOfficerUserIds(opts.schoolId);
    if (!officers.length) return;
    const who = (opts.studentName || "A student").trim();
    const et = (opts.eventType || "a security event").trim();
    const exam =
      [opts.courseCode, opts.examTitle || opts.courseTitle].filter(Boolean).join(" — ") ||
      opts.examTitle ||
      "an examination";
    const detail = (opts.detail || "").trim();
    const link = "/officer/live-monitor";
    const copy = Msg.systemAlert({
      title: "Examination Security Alert",
      message:
        `A security event was detected during an examination.\n\n` +
        `👤 Student: ${who}\n` +
        `📝 Examination: ${exam}\n` +
        `⚠️ Event: ${et}` +
        (detail ? `\n\nDetails:\n${detail}` : "") +
        `\n\nOpen live monitoring to review this student.`,
      link,
      actionLabel: "OPEN MONITORING",
    });
    await notifyMany(
      officers.map((uid) => ({
        recipientUserId: uid,
        schoolId: opts.schoolId,
        title: copy.title,
        message: copy.message,
        type: "warning",
        link: templateLink(copy, link),
        actionLabel: copy.action?.label ?? "OPEN MONITORING",
        entityType: "examination",
        entityId: opts.examId || opts.examTitle || "violation",
        dedupeMinutes: 2,
      })),
    );
  } catch (e) {
    console.warn("[notify] notifyOfficersStudentViolation failed", e);
  }
}


export async function processDueExamReminders(schoolId?: string | null): Promise<{ sent: number }> {
  let sent = 0;
  try {
    const now = Date.now();
    let q = supabase
      .from("examinations")
      .select("id, title, school_id, scheduled_start, status, course_id")
      .in("status", ["approved", "scheduled", "published", "ongoing"])
      .not("scheduled_start", "is", null)
      .limit(80);
    if (schoolId) q = q.eq("school_id", schoolId);
    const { data: exams, error } = await q;
    if (error || !exams?.length) return { sent: 0 };
    for (const raw of exams) {
      const exam = raw as { id: string; title: string; school_id: string; scheduled_start: string; course_id?: string | null };
      const startMs = new Date(exam.scheduled_start).getTime();
      if (Number.isNaN(startMs)) continue;
      const delta = startMs - now;
      let kind: "24h" | "30m" | "10m" | "start" | null = null;
      if (delta >= 23.5 * 3600_000 && delta <= 24.5 * 3600_000) kind = "24h";
      else if (delta >= 26 * 60_000 && delta <= 34 * 60_000) kind = "30m";
      else if (delta >= 7 * 60_000 && delta <= 13 * 60_000) kind = "10m";
      else if (delta >= -2 * 60_000 && delta <= 2 * 60_000) kind = "start";
      if (!kind) continue;
      const authIds = await courseStudentAuthIds(exam.course_id ?? null, exam.school_id);
      const names = await authUserDisplayNames(authIds);
      for (const uid of authIds) {
        await notifyStudentExamReminder({
          studentUserId: uid,
          schoolId: exam.school_id,
          examId: exam.id,
          examTitle: exam.title,
          studentName: names.get(uid),
          kind,
        });
        sent += 1;
      }
    }
  } catch (e) {
    console.warn("[notify] processDueExamReminders failed", e);
  }
  return { sent };
}

export async function processWeeklyAggregationSummaries(schoolId?: string | null): Promise<void> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const schoolsQ = schoolId
      ? await supabase.from("schools").select("id, name").eq("id", schoolId)
      : await supabase.from("schools").select("id, name").limit(40);
    const schools = (schoolsQ.data ?? []) as { id: string; name: string }[];
    for (const school of schools) {
      const [{ count: studentCount }, { count: examCount }, { count: violationCount }] = await Promise.all([
        supabase.from("students").select("id", { count: "exact", head: true }).eq("school_id", school.id).gte("created_at", since),
        supabase.from("examinations").select("id", { count: "exact", head: true }).eq("school_id", school.id).gte("created_at", since),
        supabase.from("integrity_events").select("id", { count: "exact", head: true }).eq("school_id", school.id).gte("created_at", since),
      ]);
      const admins = await listAdminUserIds(school.id);
      const weekKey = new Date().toISOString().slice(0, 10);
      const payloads: Parameters<typeof notifyMany>[0] = [];
      if ((studentCount ?? 0) > 0) {
        const copy = Msg.weeklyEnrollmentUpdate({
          schoolName: school.name,
          students: studentCount ?? 0,
          link: "/admin/students",
        });
        for (const uid of admins) {
          payloads.push({
            recipientUserId: uid,
            schoolId: school.id,
            title: copy.title,
            message: copy.message,
            type: "info",
            link: templateLink(copy, "/admin/students"),
            actionLabel: copy.action?.label ?? "VIEW STUDENTS",
            entityType: "weekly_enrollment",
            entityId: `${school.id}:${weekKey}`,
            dedupeMinutes: 6 * 24 * 60,
          });
        }
      }
      if ((examCount ?? 0) > 0 || (studentCount ?? 0) > 0) {
        const copy = Msg.weeklySchoolReport({
          schoolName: school.name,
          students: studentCount ?? undefined,
          exams: examCount ?? undefined,
          link: "/admin",
        });
        for (const uid of admins) {
          payloads.push({
            recipientUserId: uid,
            schoolId: school.id,
            title: copy.title,
            message: copy.message,
            type: "info",
            link: templateLink(copy, "/admin"),
            actionLabel: copy.action?.label ?? "OPEN DASHBOARD",
            entityType: "weekly_exams",
            entityId: `${school.id}:${weekKey}`,
            dedupeMinutes: 6 * 24 * 60,
          });
        }
      }
      if ((violationCount ?? 0) > 0) {
        const copy = Msg.systemAlert({
          title: "Weekly Security Summary",
          message:
            `Weekly examination security summary.\n\n` +
            `🏫 School: ${school.name}\n` +
            `🛡️ ${violationCount} examination security violations were recorded this week.\n\n` +
            `Review integrity reports in the school dashboard.`,
          link: "/admin",
          actionLabel: "OPEN DASHBOARD",
        });
        for (const uid of admins) {
          payloads.push({
            recipientUserId: uid,
            schoolId: school.id,
            title: copy.title,
            message: copy.message,
            type: "warning",
            link: templateLink(copy, "/admin"),
            actionLabel: copy.action?.label ?? "OPEN DASHBOARD",
            entityType: "weekly_security",
            entityId: `${school.id}:${weekKey}`,
            dedupeMinutes: 6 * 24 * 60,
          });
        }
      }
      if (payloads.length) await notifyMany(payloads);
    }
  } catch (e) {
    console.warn("[notify] processWeeklyAggregationSummaries failed", e);
  }
}
