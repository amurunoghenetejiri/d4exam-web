package com.d4exam.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Native FCM entry — wakes device for incoming calls and shows rich message notifications
 * even when the WebView / React UI is not running.
 */
public class D4FirebaseMessagingService extends FirebaseMessagingService {
  private static final String TAG = "D4FCMService";
  public static final String CALL_CHANNEL_ID = "d4_incoming_calls_v2";
  public static final String MSG_CHANNEL_ID = "d4_messages_channel";
  public static final int CALL_NOTIF_ID = 9001;
  public static final String KEY_TEXT_REPLY = "d4_reply_text";

  @Override
  public void onNewToken(@NonNull String token) {
    super.onNewToken(token);
    Log.d(TAG, "New FCM Token: " + token);
    // Token is also registered from JS (push.ts). Log only here.
  }

  @Override
  public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
    super.onMessageReceived(remoteMessage);
    Map<String, String> data = remoteMessage.getData();
    if (data == null) data = java.util.Collections.emptyMap();
    String type = data.get("type");

    if ("incoming_call".equalsIgnoreCase(type)) {
      handleIncomingCall(data);
    } else if ("missed_call".equalsIgnoreCase(type)) {
      handleMissedCall(data);
    } else if ("chat_message".equalsIgnoreCase(type) || "message".equalsIgnoreCase(type)) {
      handleChatMessage(data);
    } else {
      handleNormalNotification(remoteMessage);
    }
  }

  private int appIcon() {
    int icon = getResources().getIdentifier("ic_stat_d4exam", "drawable", getPackageName());
    if (icon == 0) icon = android.R.drawable.sym_call_incoming;
    return icon;
  }

  private void handleIncomingCall(Map<String, String> data) {
    String callId = data.get("callId");
    String callerName = data.get("callerName");
    String callType = data.get("callType");
    String callerMatric = data.get("callerMatric");
    if (callerName == null || callerName.isEmpty()) callerName = "D4EXAM Call";
    if (callType == null) callType = "voice";

    try {
      PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
      if (pm != null) {
        @SuppressWarnings("deprecation")
        PowerManager.WakeLock wakeLock = pm.newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "d4exam:call_wake");
        wakeLock.acquire(15000L);
      }
    } catch (Throwable ignored) {}

    try {
      D4CallPlugin.startIncomingRing(getApplicationContext());
    } catch (Throwable t) {
      Log.w(TAG, "startIncomingRing failed", t);
    }

    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    createCallChannel(nm);

    Intent fullScreenIntent = new Intent(this, MainActivity.class);
    fullScreenIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    fullScreenIntent.putExtra("d4_call_action", "incoming");
    fullScreenIntent.putExtra("d4_call_id", callId);
    fullScreenIntent.putExtra("d4_call_type", callType);

    PendingIntent fullScreenPending = PendingIntent.getActivity(
        this, 100, fullScreenIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Intent acceptIntent = new Intent(this, MainActivity.class);
    acceptIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    acceptIntent.putExtra("d4_call_action", "answer");
    acceptIntent.putExtra("d4_call_id", callId);
    acceptIntent.putExtra("d4_call_type", callType);
    PendingIntent acceptPending = PendingIntent.getActivity(
        this, 101, acceptIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Intent declineIntent = new Intent(this, MainActivity.class);
    declineIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    declineIntent.putExtra("d4_call_action", "decline");
    declineIntent.putExtra("d4_call_id", callId);
    PendingIntent declinePending = PendingIntent.getActivity(
        this, 102, declineIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    String body = "Incoming " + ("video".equals(callType) ? "video" : "voice") + " call";
    if (callerMatric != null && !callerMatric.isEmpty()) body = body + " · " + callerMatric;

    Person caller = new Person.Builder()
        .setName(callerName)
        .setImportant(true)
        .build();

    NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CALL_CHANNEL_ID)
        .setSmallIcon(appIcon())
        .setContentTitle(callerName)
        .setContentText(body)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setAutoCancel(false)
        .setOngoing(true)
        .setContentIntent(fullScreenPending)
        .setFullScreenIntent(fullScreenPending, true)
        .setTimeoutAfter(45000)
        .addAction(0, "Decline", declinePending)
        .addAction(0, "Accept", acceptPending);

    // CallStyle when available (Android 12+ / androidx)
    try {
      builder.setStyle(
          NotificationCompat.CallStyle.forIncomingCall(caller, declinePending, acceptPending));
    } catch (Throwable t) {
      Log.d(TAG, "CallStyle not applied: " + t.getMessage());
    }

    try {
      nm.notify(CALL_NOTIF_ID, builder.build());
    } catch (SecurityException se) {
      Log.w(TAG, "notify failed", se);
    }
  }

  private void handleMissedCall(Map<String, String> data) {
    try {
      D4CallPlugin.stopIncomingRingStatic(getApplicationContext());
    } catch (Throwable ignored) {}

    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    ensureMsgChannel(nm);

    String callerName = data.get("callerName");
    String callerMatric = data.get("callerMatric");
    String conversationId = data.get("conversationId");
    if (callerName == null || callerName.isEmpty()) callerName = "Someone";
    String body = "Missed call from " + callerName;
    if (callerMatric != null && !callerMatric.isEmpty()) body = body + " · " + callerMatric;

    Intent intent = new Intent(this, MainActivity.class);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    intent.putExtra("d4_open_path", conversationId != null && !conversationId.isEmpty()
        ? "/student/messages?chat=" + conversationId
        : "/student/messages");
    PendingIntent pi = PendingIntent.getActivity(
        this, 200, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
        .setSmallIcon(appIcon())
        .setContentTitle("Missed call")
        .setContentText(body)
        .setAutoCancel(true)
        .setContentIntent(pi)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_MISSED_CALL);

    try {
      nm.cancel(CALL_NOTIF_ID);
      nm.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), b.build());
    } catch (SecurityException ignored) {}
  }

  private void handleChatMessage(Map<String, String> data) {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    ensureMsgChannel(nm);

    String title = data.get("title");
    String body = data.get("message");
    if (body == null || body.isEmpty()) body = data.get("body");
    String conversationId = data.get("conversationId");
    if (conversationId == null) conversationId = "";
    String link = data.get("link");
    String senderName = data.get("senderName");
    if (senderName == null || senderName.isEmpty()) senderName = data.get("callerName");
    if (senderName == null || senderName.isEmpty()) senderName = title;
    if (senderName == null || senderName.isEmpty()) senderName = "D4EXAM";
    String senderMatric = data.get("senderMatric");
    if (senderMatric == null) senderMatric = data.get("callerMatric");
    if (senderMatric == null) senderMatric = "";
    String attachmentType = data.get("attachmentType");
    if (attachmentType == null) attachmentType = "";

    // Pretty media previews
    body = formatMessagePreview(body, attachmentType);
    if (title == null || title.isEmpty()) {
      title = senderMatric.isEmpty() ? senderName : (senderName + " · " + senderMatric);
    }
    if (body == null || body.isEmpty()) body = "New message";

    String openPath = link;
    if (openPath == null || openPath.isEmpty()) {
      openPath = !conversationId.isEmpty()
          ? "/student/messages?chat=" + conversationId
          : "/student/messages";
    }
    if (openPath.startsWith("http")) {
      try {
        Uri u = Uri.parse(openPath);
        openPath = u.getPath();
        if (u.getQuery() != null) openPath = openPath + "?" + u.getQuery();
      } catch (Throwable ignored) {}
    }

    // Persist recent lines for MessagingStyle history
    appendChatHistory(conversationId, senderName, body);

    Intent openIntent = new Intent(this, MainActivity.class);
    openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    openIntent.putExtra("d4_open_path", openPath);
    openIntent.putExtra("d4_conversation_id", conversationId);
    PendingIntent openPending = PendingIntent.getActivity(
        this,
        Math.abs(("open_" + conversationId).hashCode()) & 0xffff,
        openIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    Intent markIntent = new Intent(this, MainActivity.class);
    markIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    markIntent.putExtra("d4_open_path", openPath);
    markIntent.putExtra("d4_conversation_id", conversationId);
    markIntent.putExtra("d4_mark_read", true);
    PendingIntent markPending = PendingIntent.getActivity(
        this,
        Math.abs(("mark_" + conversationId).hashCode()) & 0xffff,
        markIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    RemoteInput remoteInput = new RemoteInput.Builder(KEY_TEXT_REPLY)
        .setLabel("Reply")
        .build();
    Intent replyIntent = new Intent(this, MainActivity.class);
    replyIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    replyIntent.putExtra("d4_open_path", openPath);
    replyIntent.putExtra("d4_conversation_id", conversationId);
    replyIntent.putExtra("d4_reply_action", true);
    PendingIntent replyPending = PendingIntent.getActivity(
        this,
        Math.abs(("reply_" + conversationId).hashCode()) & 0xffff,
        replyIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);

    NotificationCompat.Action replyAction = new NotificationCompat.Action.Builder(
        0, "Reply", replyPending)
        .addRemoteInput(remoteInput)
        .setAllowGeneratedReplies(true)
        .build();

    // MessagingStyle (WhatsApp-like conversation)
    Person sender = new Person.Builder()
        .setName(senderName)
        .setKey(conversationId.isEmpty() ? senderName : conversationId)
        .setImportant(true)
        .build();

    NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(
        new Person.Builder().setName("Me").build())
        .setConversationTitle(null)
        .setGroupConversation(false);

    JSONArray hist = loadChatHistory(conversationId);
    long now = System.currentTimeMillis();
    try {
      for (int i = 0; i < hist.length(); i++) {
        JSONObject row = hist.getJSONObject(i);
        String n = row.optString("name", senderName);
        String m = row.optString("text", "");
        long ts = row.optLong("ts", now);
        Person p = new Person.Builder().setName(n).build();
        style.addMessage(m, ts, p);
      }
    } catch (Throwable ignored) {
      style.addMessage(body, now, sender);
    }

    String groupKey = "d4exam_all_messages";
    int notifId = Math.abs(("chat_" + (conversationId.isEmpty() ? title : conversationId)).hashCode());

    NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
        .setSmallIcon(appIcon())
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(style)
        .setAutoCancel(true)
        .setContentIntent(openPending)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setGroup(groupKey)
        .setNumber(hist.length() > 0 ? hist.length() : 1)
        .addAction(replyAction)
        .addAction(0, "Mark as read", markPending)
        .setShortcutId(conversationId.isEmpty() ? null : conversationId);

    try {
      nm.notify(notifId, b.build());
      // App-level summary: "D4EXAM · N messages from M chats"
      postMessagesSummary(nm, openPending);
    } catch (SecurityException ignored) {}
  }

  private String formatMessagePreview(String body, String attachmentType) {
    String at = attachmentType == null ? "" : attachmentType.toLowerCase();
    if (at.contains("audio") || at.equals("voice")) {
      return "🎙 Voice message";
    }
    if (at.contains("image") || at.equals("photo")) {
      return "📷 Photo";
    }
    if (at.contains("video")) {
      return "🎥 Video";
    }
    if (at.contains("file") || at.contains("document") || at.contains("pdf")) {
      return "📎 Document";
    }
    if (at.equals("call") || (body != null && body.toLowerCase().contains("missed"))) {
      if (body != null && body.toLowerCase().contains("video")) return "📹 Missed video call";
      return "📞 Missed voice call";
    }
    return body;
  }

  private SharedPreferences chatPrefs() {
    return getSharedPreferences("d4_chat_notif_hist", MODE_PRIVATE);
  }

  private void appendChatHistory(String conversationId, String name, String text) {
    try {
      String key = "c_" + (conversationId == null || conversationId.isEmpty() ? "general" : conversationId);
      JSONArray arr = loadChatHistory(conversationId);
      JSONObject row = new JSONObject();
      row.put("name", name);
      row.put("text", text);
      row.put("ts", System.currentTimeMillis());
      arr.put(row);
      // keep last 6
      JSONArray trimmed = new JSONArray();
      int start = Math.max(0, arr.length() - 6);
      for (int i = start; i < arr.length(); i++) trimmed.put(arr.get(i));
      chatPrefs().edit().putString(key, trimmed.toString()).apply();
      // track active conversations for summary
      String active = chatPrefs().getString("active_convs", "[]");
      JSONArray act = new JSONArray(active);
      boolean found = false;
      for (int i = 0; i < act.length(); i++) {
        if (key.equals(act.optString(i))) { found = true; break; }
      }
      if (!found) act.put(key);
      chatPrefs().edit().putString("active_convs", act.toString()).apply();
    } catch (Throwable ignored) {}
  }

  private JSONArray loadChatHistory(String conversationId) {
    try {
      String key = "c_" + (conversationId == null || conversationId.isEmpty() ? "general" : conversationId);
      String raw = chatPrefs().getString(key, "[]");
      return new JSONArray(raw);
    } catch (Throwable t) {
      return new JSONArray();
    }
  }

  private void postMessagesSummary(NotificationManager nm, PendingIntent openPending) {
    try {
      String active = chatPrefs().getString("active_convs", "[]");
      JSONArray act = new JSONArray(active);
      int chats = 0;
      int messages = 0;
      NotificationCompat.InboxStyle inbox = new NotificationCompat.InboxStyle();
      inbox.setBigContentTitle("D4EXAM");
      for (int i = 0; i < act.length(); i++) {
        String key = act.optString(i);
        if (key.isEmpty()) continue;
        String raw = chatPrefs().getString(key, "[]");
        JSONArray hist = new JSONArray(raw);
        if (hist.length() == 0) continue;
        chats++;
        messages += hist.length();
        JSONObject last = hist.getJSONObject(hist.length() - 1);
        String line = last.optString("name", "Chat") + ": " + last.optString("text", "");
        if (line.length() > 80) line = line.substring(0, 77) + "…";
        inbox.addLine(line);
      }
      if (chats == 0) return;
      String summaryText = messages + (messages == 1 ? " message" : " messages")
          + " from " + chats + (chats == 1 ? " chat" : " chats");
      inbox.setSummaryText(summaryText);
      NotificationCompat.Builder summary = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
          .setSmallIcon(appIcon())
          .setContentTitle("D4EXAM")
          .setContentText(summaryText)
          .setStyle(inbox)
          .setGroup("d4exam_all_messages")
          .setGroupSummary(true)
          .setAutoCancel(true)
          .setContentIntent(openPending)
          .setPriority(NotificationCompat.PRIORITY_HIGH);
      nm.notify(88001, summary.build());
    } catch (Throwable ignored) {}
  }

  private void handleNormalNotification(RemoteMessage remoteMessage) {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;
    ensureMsgChannel(nm);

    String title = "D4EXAM";
    String body = "New notification";
    String link = null;
    if (remoteMessage.getNotification() != null) {
      if (remoteMessage.getNotification().getTitle() != null) title = remoteMessage.getNotification().getTitle();
      if (remoteMessage.getNotification().getBody() != null) body = remoteMessage.getNotification().getBody();
    }
    Map<String, String> data = remoteMessage.getData();
    if (data != null) {
      if (data.get("title") != null) title = data.get("title");
      if (data.get("message") != null) body = data.get("message");
      else if (data.get("body") != null) body = data.get("body");
      link = data.get("link");
      if (link == null) link = data.get("url");
    }

    Intent intent = new Intent(this, MainActivity.class);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    if (link != null && !link.isEmpty()) {
      intent.putExtra("d4_open_path", link);
    }
    PendingIntent pi = PendingIntent.getActivity(
        this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
        .setSmallIcon(appIcon())
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
        .setAutoCancel(true)
        .setContentIntent(pi)
        .setPriority(NotificationCompat.PRIORITY_HIGH);

    try {
      nm.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), b.build());
    } catch (SecurityException ignored) {}
  }

  private void ensureMsgChannel(NotificationManager nm) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel ch = new NotificationChannel(
          MSG_CHANNEL_ID, "D4EXAM Messages", NotificationManager.IMPORTANCE_HIGH);
      ch.enableVibration(true);
      ch.setDescription("Chat and system notifications");
      nm.createNotificationChannel(ch);
    }
  }

  private void createCallChannel(NotificationManager nm) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
          CALL_CHANNEL_ID, "Incoming Calls", NotificationManager.IMPORTANCE_HIGH);
      channel.setDescription("High-priority incoming voice and video calls");
      channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
      Uri ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
      AudioAttributes audioAttributes = new AudioAttributes.Builder()
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .build();
      channel.setSound(ringtoneUri, audioAttributes);
      channel.enableVibration(true);
      channel.setVibrationPattern(new long[]{0, 500, 300, 500, 300, 500});
      nm.createNotificationChannel(channel);
    }
  }
}
