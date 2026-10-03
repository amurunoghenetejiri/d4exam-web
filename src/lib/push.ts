/**
 * Client-side push registration.
 *
 * Native Android APK:
 * - Capacitor PushNotifications.register() → real FCM token (background delivery)
 * - Requires google-services.json in the Android app module for FCM
 * - Never save fake native-* tokens (FCM cannot deliver to them)
 * - System tray uses D4EXAM Local Notifications channel (app icon, not Chrome)
 *
 * Web/PWA:
 * - Firebase web push via service worker (icon-192 / logo — app branding)
 * - Background handled by public/firebase-messaging-sw.js
 */
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getMessaging, getToken, isSupported, onMessage, type Messaging } from "firebase/messaging";
import { FIREBASE_WEB_CONFIG, FIREBASE_VAPID_KEY } from "@/lib/firebase-config";
import { supabase } from "@/integrations/supabase/client";
import { isNativeShell, getRuntimePlatform, waitForNativeShell } from "@/native/platform";
import { showD4ExamNativeNotification, bindLocalNotificationActions } from "@/native/localNotify";
import { notificationsEnabledConfirm } from "@/lib/notify-messages";

let app: FirebaseApp | null = null;
let messaging: Messaging | null = null;
let nativePermissionCache: "granted" | "denied" | "default" | "unsupported" | null = null;

/** Native permission via D4NativeAuth (POST_NOTIFICATIONS) — works with server.url WebView. */
async function d4NativeNotifPermission(request: boolean): Promise<"granted" | "denied" | "default" | null> {
  try {
    const { registerPlugin } = await import("@capacitor/core");
    const plugin = registerPlugin<{
      checkNotificationPermission: () => Promise<{ display?: string }>;
      requestNotificationPermission: () => Promise<{ display?: string }>;
    }>("D4NativeAuth");
    const st = request
      ? await plugin.requestNotificationPermission()
      : await plugin.checkNotificationPermission();
    const d = (st?.display || "").toLowerCase();
    if (d === "granted") return "granted";
    if (d === "denied") return "denied";
    return "default";
  } catch {
    return null;
  }
}


let nativeListenersBound = false;
let webOnMessageBound = false;

/** Real FCM registration (needs google-services.json in APK build). */
/** false until APK is built with google-services.json — register() crashes the process without it. */
const ENABLE_NATIVE_FCM_REGISTER = true; // real FCM token registration for background call wake

export type PushPermissionState = "granted" | "denied" | "default" | "unsupported";

export function getPushPermissionState(): PushPermissionState {
  if (typeof window === "undefined") return "unsupported";
  if (isNativeShell()) {
    return nativePermissionCache || "default";
  }
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission as PushPermissionState;
}

export async function refreshNativePushPermissionState(): Promise<PushPermissionState> {
  if (!isNativeShell()) {
    await waitForNativeShell(5_000);
  }
  if (!isNativeShell()) return getPushPermissionState();
  try {
    const d4 = await d4NativeNotifPermission(false);
    if (d4 === "granted") {
      nativePermissionCache = "granted";
      return "granted";
    }
    if (d4 === "denied") {
      nativePermissionCache = "denied";
      return "denied";
    }
  } catch {
    /* fall through */
  }
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    const status = await LocalNotifications.checkPermissions();
    if (status.display === "granted") {
      nativePermissionCache = "granted";
      return "granted";
    }
    if (status.display === "denied") {
      nativePermissionCache = "denied";
      return "denied";
    }
  } catch {
    /* fall through */
  }
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const status = await PushNotifications.checkPermissions();
    if (status.receive === "granted") {
      nativePermissionCache = "granted";
      return "granted";
    }
    if (status.receive === "denied") {
      nativePermissionCache = "denied";
      return "denied";
    }
    nativePermissionCache = "default";
    return "default";
  } catch {
    nativePermissionCache = "unsupported";
    return "unsupported";
  }
}

async function disableWebPushInNativeShell(): Promise<void> {
  if (!isNativeShell() || typeof window === "undefined") return;
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        try {
          await reg.unregister();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

async function disableWebPushDevicesForUser(userId: string): Promise<void> {
  if (!userId || !isNativeShell()) return;
  try {
    const { data } = await supabase
      .from("push_devices")
      .select("id, user_agent, token")
      .eq("user_id", userId)
      .eq("enabled", true);
    const rows = (data || []) as { id: string; user_agent?: string | null }[];
    for (const row of rows) {
      const ua = row.user_agent || "";
      const isNative = /native=1/i.test(ua) || /platform=android/i.test(ua);
      if (!isNative) {
        await supabase
          .from("push_devices")
          .update({ enabled: false, updated_at: new Date().toISOString() } as never)
          .eq("id", row.id);
      }
    }
  } catch {
    /* ignore */
  }
}

function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  app = getApps().length ? getApps()[0]! : initializeApp(FIREBASE_WEB_CONFIG);
  return app;
}

export async function getFirebaseMessaging(): Promise<Messaging | null> {
  if (typeof window === "undefined") return null;
  if (isNativeShell()) return null;
  const supported = await isSupported().catch(() => false);
  if (!supported) return null;
  if (messaging) return messaging;
  messaging = getMessaging(getFirebaseApp());
  return messaging;
}

function absIcon(path: string): string {
  if (typeof window === "undefined") return path;
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
}

/** System-tray notification with D4EXAM icon (not Chrome default). */
function showLocalNotification(title: string, body: string, link?: string | null) {
  if (isNativeShell()) {
    void showD4ExamNativeNotification(title, body, link);
    return;
  }
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  const icon = absIcon("/icon-192.png");
  const badge = absIcon("/icon-192.png");
  const pathLink = (() => {
    let path = String(link || "/");
    if (path.startsWith("http")) {
      try {
        const u = new URL(path);
        path = u.pathname + (u.search || "");
      } catch {
        /* keep */
      }
    }
    if (!path.startsWith("/")) path = `/${path}`;
    return path;
  })();
  void (async () => {
    try {
      if ("serviceWorker" in navigator) {
        const reg =
          (await navigator.serviceWorker.getRegistration()) ||
          (await navigator.serviceWorker.ready.catch(() => null));
        if (reg?.showNotification) {
          await reg.showNotification(title, {
            body,
            icon,
            badge,
            data: { link: pathLink, title },
            tag: "d4exam-notification",
            renotify: true,
          });
          return;
        }
      }
    } catch {
      /* fall through */
    }
    try {
      const n = new Notification(title, { body, icon, badge });
      n.onclick = () => {
        window.focus();
        window.location.assign(`${window.location.origin || ""}${pathLink}`);
        n.close();
      };
    } catch {
      /* ignore */
    }
  })();
}

async function ensureAndroidChannel(): Promise<void> {
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    if (typeof (PushNotifications as unknown as { createChannel?: unknown }).createChannel === "function") {
      await (PushNotifications as unknown as { createChannel: (opts: unknown) => Promise<void> }).createChannel({
        id: "d4exam_default",
        name: "D4EXAM",
        description: "Exams, results and important updates",
        importance: 5,
        visibility: 1,
        sound: "default",
        vibration: true,
      });
    }
  } catch {
    /* ignore */
  }
}

async function bindNativePushListeners(userId: string, role?: string | null): Promise<void> {
  if (nativeListenersBound) return;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");

    await PushNotifications.addListener("registration", (token) => {
      void saveDeviceToken(userId, token.value, role);
    });

    await PushNotifications.addListener("registrationError", (err) => {
      console.warn("[D4EXAM] push registration error", err);
    });

    await PushNotifications.addListener("pushNotificationReceived", (notification) => {
      try {
        const data = notification.data as Record<string, string> | undefined;
        // High-priority incoming call wake — hand off to call session (UI + ring)
        if (data?.type === "incoming_call" && data.callId) {
          void import("@/lib/call-session").then(async ({ notifyIncomingCall, getCallSession }) => {
            const cur = getCallSession();
            if (cur && !["ended", "no_answer", "missed", "failed", "declined", "idle"].includes(cur.phase)) {
              return;
            }
            const { useSessionUser } = await import("@/lib/session");
            // Resolve peer profile best-effort
            let peerName = data.callerName || "Incoming call";
            let peerAvatar: string | null = null;
            let peerMatric = data.callerMatric || null;
            try {
              const { fetchPublicProfile } = await import("@/lib/user-profile");
              const { supabase } = await import("@/integrations/supabase/client");
              const { data: auth } = await supabase.auth.getUser();
              const myId = auth.user?.id || "";
              // fromUserId not always in FCM payload — use callerName for display
              const p = await fetchPublicProfile(data.fromUserId || data.callerId || "", myId).catch(() => null);
              if (p) {
                peerName = p.fullName || peerName;
                peerAvatar = p.avatarUrl;
                peerMatric = p.matricNumber || peerMatric;
              }
              await notifyIncomingCall({
                callId: data.callId!,
                callType: data.callType === "video" ? "video" : "voice",
                peerId: data.fromUserId || data.callerId || "unknown",
                peerName,
                peerAvatar,
                peerMatric,
                conversationId: data.conversationId || null,
                myUserId: myId,
              });
            } catch (e) {
              console.warn("[push] incoming_call handle", e);
            }
          });
          return;
        }
        const title = data?.title || notification.title || "D4EXAM";
        const body = data?.message || data?.body || notification.body || "";
        const actionLabel = data?.actionLabel || data?.action_label || undefined;
        void showD4ExamNativeNotification(title, body, data?.link || data?.actionLink, {
          actionLabel,
        });
        if (data?.examCountdown === "1" && data.examId && data.startIso) {
          void import("@/native/localNotify").then((m) => {
            m.startExamCountdownNotification({
              examId: data.examId!,
              studentName: data.studentName || "Student",
              courseCode: data.courseCode || data.examTitle || "Examination",
              startIso: data.startIso!,
              endIso: data.endIso || null,
              startLink: data.link || `/student/exam/${data.examId}`,
              viewLink: data.link || `/student/exam/${data.examId}`,
            });
          });
        }
      } catch {
        /* ignore */
      }
    });

    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      try {
        const data = action.notification?.data as Record<string, string> | undefined;
        if (data?.type === "incoming_call" && data.callId) {
          void import("@/lib/call-session").then(async ({ notifyIncomingCall, getCallSession }) => {
            const cur = getCallSession();
            if (!cur || ["ended", "no_answer", "missed", "failed", "declined", "idle"].includes(cur.phase)) {
              const { supabase } = await import("@/integrations/supabase/client");
              const { data: auth } = await supabase.auth.getUser();
              const myId = auth.user?.id || "";
              await notifyIncomingCall({
                callId: data.callId!,
                callType: data.callType === "video" ? "video" : "voice",
                peerId: data.fromUserId || data.callerId || "unknown",
                peerName: data.callerName || "Incoming call",
                peerAvatar: null,
                peerMatric: data.callerMatric || null,
                conversationId: data.conversationId || null,
                myUserId: myId,
              });
            }
            // Accept if user tapped Accept action
            const act = (action.actionId || "").toLowerCase();
            if (act === "answer" || act === "accept") {
              const { acceptIncomingCall, getCallSession: gs } = await import("@/lib/call-session");
              const s = gs();
              if (s && s.phase === "ringing") {
                await acceptIncomingCall({
                  callId: s.callId,
                  callType: s.callType,
                  peerId: s.peerId,
                  peerName: s.peerName,
                  peerAvatar: s.peerAvatar,
                  peerMatric: s.peerMatric,
                  conversationId: s.conversationId,
                  myUserId: s.myUserId,
                });
              }
            }
          });
          return;
        }
        let link = (data?.link || data?.actionLink || data?.url || "").trim();
        if (!link) link = "/student/notifications";
        if (link.startsWith("http")) {
          try {
            const u = new URL(link);
            link = u.pathname + (u.search || "");
          } catch {
            /* keep */
          }
        }
        if (!link.startsWith("/")) link = `/${link}`;
        if (typeof window !== "undefined") {
          window.location.assign(link);
        }
      } catch {
        /* ignore */
      }
    });

    nativeListenersBound = true;
    void bindLocalNotificationActions();
  } catch (e) {
    console.warn("[D4EXAM] bindNativePushListeners failed", e);
  }
}

async function enableNativePushNotifications(
  userId: string,
  role?: string | null,
  opts?: { requestPermission?: boolean },
): Promise<{ ok: boolean; token?: string; error?: string }> {
  try {
    await disableWebPushInNativeShell();
    await disableWebPushDevicesForUser(userId);

    // 1) D4NativeAuth — real Android POST_NOTIFICATIONS dialog
    try {
      if (opts?.requestPermission !== false) {
        const d4 = await d4NativeNotifPermission(true);
        if (d4 === "granted") nativePermissionCache = "granted";
        if (d4 === "denied") nativePermissionCache = "denied";
      } else {
        const d4 = await d4NativeNotifPermission(false);
        if (d4 === "granted") nativePermissionCache = "granted";
      }
    } catch { /* continue */ }

    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      let lp = await LocalNotifications.checkPermissions();
      const wasGranted = lp.display === "granted" || nativePermissionCache === "granted";
      if (!wasGranted && opts?.requestPermission !== false) {
        lp = await LocalNotifications.requestPermissions();
      }
      if (lp.display === "granted") {
        nativePermissionCache = "granted";
        if (!wasGranted) {
          try {
            const key = `d4_notif_enabled_once:${userId}`;
            if (typeof localStorage !== "undefined" && localStorage.getItem(key) !== "1") {
              localStorage.setItem(key, "1");
              const copy = notificationsEnabledConfirm();
              const settings =
                role === "student"
                  ? "/student/settings"
                  : role === "teacher"
                    ? "/teacher/settings"
                    : role === "examination_officer"
                      ? "/officer/settings"
                      : role === "school_admin"
                        ? "/admin/settings"
                        : role === "super_admin"
                          ? "/super-admin/settings"
                          : "/";
              await showD4ExamNativeNotification(copy.title, copy.message, settings);
            }
          } catch {
            /* ignore storage */
          }
        }
      }
    } catch {
      /* plugin may be missing until next APK */
    }

    try {
      const { PushNotifications } = await import("@capacitor/push-notifications");
      let permStatus = await PushNotifications.checkPermissions();
      if (permStatus.receive !== "granted" && opts?.requestPermission !== false) {
        permStatus = await PushNotifications.requestPermissions();
      }
      if (permStatus.receive === "granted") nativePermissionCache = "granted";

      if (permStatus.receive === "granted") {
        try {
          await ensureAndroidChannel();
          await bindNativePushListeners(userId, role);
        } catch {
          /* ignore */
        }
        // Only when google-services.json is in the APK. Without it, register() can kill the process after splash.
        if (ENABLE_NATIVE_FCM_REGISTER) {
          try {
            await PushNotifications.register();
          } catch (e) {
            console.warn("[D4EXAM] PushNotifications.register skipped/failed", e);
          }
        }
      }
    } catch {
      /* ignore */
    }

    // Real FCM token is saved by the "registration" listener after PushNotifications.register().
    // Only report success when the system permission is actually granted.
    const finalState = await refreshNativePushPermissionState();
    if (finalState === "granted") {
      try {
        await ensureAndroidChannel();
        const { showD4ExamNativeNotification } = await import("@/native/localNotify");
        await showD4ExamNativeNotification(
          "Notifications enabled",
          "You will receive exam and result alerts on this device.",
          role === "student"
            ? "/student/settings"
            : role === "teacher"
              ? "/teacher/settings"
              : role === "examination_officer"
                ? "/officer/settings"
                : role === "school_admin"
                  ? "/admin/settings"
                  : role === "super_admin"
                    ? "/super-admin/settings"
                    : "/",
        );
      } catch {
        /* still granted even if test notif fails */
      }
      return { ok: true };
    }
    if (finalState === "denied") {
      return {
        ok: false,
        error:
          "Notification permission blocked. Open phone Settings → Apps → D4EXAM → Notifications and allow them.",
      };
    }
    return {
      ok: false,
      error: "Notification permission was not granted. Tap Enable again and choose Allow.",
    };
  } catch (e) {
    console.warn("[D4EXAM] enableNativePushNotifications failed", e);
    return { ok: false, error: (e as Error).message || "Native push failed" };
  }
}

async function saveDeviceToken(
  userId: string,
  token: string,
  role?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!token || /^native-/i.test(token) || token.length < 32) {
    return { ok: false, error: "invalid fcm token" };
  }

  const ua =
    typeof navigator !== "undefined"
      ? `${navigator.userAgent} | platform=${getRuntimePlatform()} | native=${isNativeShell() ? "1" : "0"}`
      : `platform=${getRuntimePlatform()}`;

  const now = new Date().toISOString();
  const row = {
    user_id: userId,
    token,
    role: role || null,
    user_agent: ua.slice(0, 400),
    enabled: true,
    last_seen_at: now,
    updated_at: now,
  };

  try {
    const upd = await supabase
      .from("push_devices")
      .update({
        role: role || null,
        user_agent: ua.slice(0, 400),
        enabled: true,
        last_seen_at: now,
        updated_at: now,
      } as never)
      .eq("token", token)
      .eq("user_id", userId)
      .select("id");

    if (!upd.error && upd.data && (upd.data as { id: string }[]).length > 0) {
      return { ok: true };
    }

    const ins = await supabase.from("push_devices").insert(row as never).select("id");
    if (!ins.error) return { ok: true };

    const msg = ins.error.message || "";
    if (/duplicate|unique|push_devices_token/i.test(msg)) {
      const again = await supabase
        .from("push_devices")
        .update({
          user_id: userId,
          role: role || null,
          user_agent: ua.slice(0, 400),
          enabled: true,
          last_seen_at: now,
          updated_at: now,
        } as never)
        .eq("token", token);
      if (!again.error) return { ok: true };
    }
    return { ok: false, error: ins.error.message };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function enableWebPushNotifications(
  userId: string,
  role?: string | null,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  if (!userId) return { ok: false, error: "Sign in required" };
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ok: false, error: "Notifications are not supported in this browser" };
  }

  try {
    let permission = Notification.permission;
    if (permission !== "granted") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
      return {
        ok: false,
        error: permission === "denied" ? "Permission denied" : "Permission not granted",
      };
    }

    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      try {
        await reg.update();
      } catch {
        /* ignore */
      }
      await navigator.serviceWorker.ready;
    }

    const msg = await getFirebaseMessaging();
    if (!msg) return { ok: false, error: "Messaging not supported" };

    const reg = await navigator.serviceWorker.getRegistration();
    const token = await getToken(msg, {
      vapidKey: FIREBASE_VAPID_KEY,
      serviceWorkerRegistration: reg,
    });
    if (!token) return { ok: false, error: "Could not get push token" };

    const saved = await saveDeviceToken(userId, token, role);
    if (!saved.ok) return { ok: false, error: saved.error || "Could not save device" };

    if (!webOnMessageBound) {
      webOnMessageBound = true;
      onMessage(msg, (payload) => {
        try {
          const data = (payload.data || {}) as Record<string, string>;
          const title = payload.notification?.title || data.title || "D4EXAM";
          const body = data.message || data.body || payload.notification?.body || "";
          const link = data.link || data.actionLink || "/";
          showLocalNotification(title, body, link);
        } catch {
          /* ignore */
        }
      });
    }

    return { ok: true, token };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "Push registration failed" };
  }
}

export async function enablePushNotifications(
  userId: string,
  role?: string | null,
  opts?: { requestPermission?: boolean },
): Promise<{ ok: boolean; token?: string; error?: string }> {
  if (!userId) return { ok: false, error: "Sign in required" };
  // Capacitor bridge may inject late when APK loads remote server.url
  if (!isNativeShell()) {
    await waitForNativeShell(6_000);
  }
  if (isNativeShell()) {
    await disableWebPushInNativeShell();
    return enableNativePushNotifications(userId, role, {
      requestPermission: opts?.requestPermission !== false,
    });
  }
  if (opts?.requestPermission === false) {
    const st = typeof Notification !== "undefined" ? Notification.permission : "denied";
    if (st === "granted") return enableWebPushNotifications(userId, role);
    return { ok: true };
  }
  return enableWebPushNotifications(userId, role);
}

export async function refreshPushLastSeen(userId: string): Promise<void> {
  if (!userId) return;
  if (isNativeShell()) return;
  try {
    const msg = await getFirebaseMessaging();
    if (!msg) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const token = await getToken(msg, {
      vapidKey: FIREBASE_VAPID_KEY,
      serviceWorkerRegistration: reg || undefined,
    }).catch(() => null);
    if (!token) return;
    await supabase
      .from("push_devices")
      .update({ last_seen_at: new Date().toISOString(), enabled: true } as never)
      .eq("token", token)
      .eq("user_id", userId);
  } catch {
    /* ignore */
  }
}

export async function initNativePushIfNeeded(
  userId?: string | null,
  role?: string | null,
): Promise<void> {
  if (!isNativeShell()) return;
  try {
    await disableWebPushInNativeShell();
    if (userId) await disableWebPushDevicesForUser(userId);
    if (!userId) return;
    const state = await refreshNativePushPermissionState();
    if (state === "granted") {
      await enableNativePushNotifications(userId, role, { requestPermission: false });
    }
  } catch {
    /* ignore */
  }
}

/** Re-register web push when permission already granted (every session / tab focus). */
export async function initWebPushIfNeeded(
  userId?: string | null,
  role?: string | null,
): Promise<void> {
  if (isNativeShell()) return;
  if (!userId) return;
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    await enableWebPushNotifications(userId, role);
    await refreshPushLastSeen(userId);
  } catch {
    /* ignore */
  }
}
