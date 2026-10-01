/**
 * Push dispatch that works on both website and Capacitor APK.
 *
 * APK stubs TanStack server functions (push-send.functions.ts) → no FCM.
 * This module prefers the Supabase Edge Function `send-fcm`, then falls back
 * to the server function on the website.
 */
import { supabase } from "@/integrations/supabase/client";

export type PushDispatchInput = {
  recipientUserId: string;
  title: string;
  message: string;
  link?: string | null;
  actionLabel?: string | null;
  type?: string | null;
  callId?: string | null;
  callType?: string | null;
  callerName?: string | null;
  callerMatric?: string | null;
  fromUserId?: string | null;
  callerId?: string | null;
  conversationId?: string | null;
  senderName?: string | null;
  senderMatric?: string | null;
  preview?: string | null;
};

function isCapSpa(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if ((window as unknown as { __D4_CAP_SPA?: boolean }).__D4_CAP_SPA) return true;
    const host = (window.location.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
  } catch {
    /* ignore */
  }
  return false;
}

async function viaEdgeFunction(
  input: PushDispatchInput,
): Promise<{ sent: number; failed: number; skipped?: boolean; reason?: string } | null> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return null;

    const { data, error } = await supabase.functions.invoke("send-fcm", {
      body: input,
    });
    if (error) {
      console.warn("[push-dispatch] edge", error.message);
      return null;
    }
    if (data && typeof data === "object") {
      return data as { sent: number; failed: number; skipped?: boolean; reason?: string };
    }
    return null;
  } catch (e) {
    console.warn("[push-dispatch] edge failed", e);
    return null;
  }
}

async function viaServerFn(
  input: PushDispatchInput,
): Promise<{ sent: number; failed: number; skipped?: boolean; reason?: string } | null> {
  if (isCapSpa()) return null; // stubs on APK
  try {
    const { dispatchPushToUser } = await import("@/lib/push-send.functions");
    const result = await dispatchPushToUser({ data: input } as never);
    if (result && typeof result === "object") {
      return result as { sent: number; failed: number; skipped?: boolean; reason?: string };
    }
    return null;
  } catch (e) {
    console.warn("[push-dispatch] server fn failed", e);
    return null;
  }
}

/** Best-effort FCM to recipient devices. Safe to call from APK or web. */
export async function dispatchPushToUserClient(
  input: PushDispatchInput,
): Promise<{ sent: number; failed: number; skipped?: boolean; reason?: string }> {
  if (!input.recipientUserId || !input.title) {
    return { sent: 0, failed: 0, skipped: true, reason: "missing fields" };
  }

  // Prefer edge (works on APK); then website server fn
  const edge = await viaEdgeFunction(input);
  if (edge && (edge.sent > 0 || edge.skipped === false || edge.reason)) {
    return edge;
  }

  const server = await viaServerFn(input);
  if (server) return server;

  return edge || { sent: 0, failed: 0, skipped: true, reason: "no push path available" };
}
