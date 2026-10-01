/**
 * send-fcm — delivers FCM to a user's registered devices.
 * Secrets (set in Supabase Dashboard → Edge Functions → Secrets):
 *   FIREBASE_SERVICE_ACCOUNT_JSON  (full service account JSON)
 *   SUPABASE_SERVICE_ROLE_KEY      (optional; falls back to auto env)
 *
 * Auth: requires Authorization: Bearer <user JWT>
 * Body: { recipientUserId, title, message, link?, type?, callId?, ... }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Body = {
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

type ServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

function b64url(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    }),
  );
  const unsigned = `${header}.${claim}`;
  const key = await importPrivateKey(sa.private_key!);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`oauth: ${await res.text()}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("oauth missing token");
  return json.access_token;
}

function isValidFcmToken(token: string | null | undefined): boolean {
  if (!token) return false;
  if (/^native-/i.test(token)) return false;
  return token.length >= 32;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_KEY") || "";

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json()) as Body;
    if (!body.recipientUserId || !body.title) {
      return new Response(JSON.stringify({ error: "missing fields" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Caller may only notify themselves (test) or peers via messaging/calls (RLS on devices is service-role)
    const admin = serviceKey
      ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
      : userClient;

    const { data: devices } = await admin
      .from("push_devices")
      .select("id, token")
      .eq("user_id", body.recipientUserId)
      .eq("enabled", true)
      .limit(40);

    const tokens = [...new Set(
      ((devices || []) as { token: string }[])
        .map((d) => d.token)
        .filter(isValidFcmToken),
    )];

    if (!tokens.length) {
      return new Response(
        JSON.stringify({ sent: 0, failed: 0, skipped: true, reason: "no devices" }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const saRaw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON") || "";
    if (!saRaw.trim()) {
      return new Response(
        JSON.stringify({
          sent: 0,
          failed: 0,
          skipped: true,
          reason: "FIREBASE_SERVICE_ACCOUNT_JSON not set",
        }),
        { headers: { ...cors, "Content-Type": "application/json" } },
      );
    }
    const sa = JSON.parse(saRaw) as ServiceAccount;
    const accessToken = await getAccessToken(sa);
    const projectId = sa.project_id || Deno.env.get("FIREBASE_PROJECT_ID") || "d4exam-6506a";

    const isCall = body.type === "incoming_call";
    const isMsg = body.type === "chat_message" || body.type === "message";
    let sent = 0;
    let failed = 0;

    for (const token of tokens) {
      const data: Record<string, string> = {
        title: String(body.title || "D4EXAM"),
        body: String(body.message || ""),
        message: String(body.message || ""),
        link: String(body.link || "/"),
        type: String(body.type || ""),
        callId: String(body.callId || ""),
        callType: String(body.callType || ""),
        callerName: String(body.callerName || body.senderName || body.title || ""),
        callerMatric: String(body.callerMatric || body.senderMatric || ""),
        fromUserId: String(body.fromUserId || body.callerId || userData.user.id),
        callerId: String(body.callerId || body.fromUserId || userData.user.id),
        conversationId: String(body.conversationId || ""),
        senderName: String(body.senderName || ""),
        senderMatric: String(body.senderMatric || ""),
        preview: String(body.preview || body.message || ""),
        actionLabel: String(body.actionLabel || ""),
      };

      const message: Record<string, unknown> = {
        token,
        data,
        android: {
          priority: "HIGH",
          ttl: isCall ? "60s" : "86400s",
          ...(isCall
            ? {}
            : {
                notification: {
                  channel_id: isMsg ? "d4_messages_channel" : "d4exam_default",
                  sound: "default",
                  default_sound: true,
                  default_vibrate_timings: true,
                  notification_priority: "PRIORITY_HIGH",
                  visibility: "PUBLIC",
                  tag: body.conversationId
                    ? `d4-msg-${body.conversationId}`
                    : "d4exam-notification",
                },
              }),
        },
      };

      // Data-only for incoming_call so D4FirebaseMessagingService always runs in background
      if (!isCall) {
        message.notification = {
          title: data.title,
          body: data.body,
        };
      }

      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message }),
        },
      );
      if (res.ok) sent += 1;
      else {
        failed += 1;
        const errText = await res.text();
        if (/NOT_FOUND|UNREGISTERED|INVALID_ARGUMENT/i.test(errText)) {
          try {
            await admin
              .from("push_devices")
              .update({ enabled: false })
              .eq("token", token);
          } catch {
            /* ignore */
          }
        }
      }
    }

    return new Response(JSON.stringify({ sent, failed, skipped: false }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
