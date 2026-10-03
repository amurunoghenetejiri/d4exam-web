package com.d4exam.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class D4FirebaseMessagingService extends FirebaseMessagingService {
  private static final String TAG = "D4FCMService";
  public static final String CALL_CHANNEL_ID = "d4_incoming_calls_v2";
  public static final String MSG_CHANNEL_ID = "d4_messages_channel";
  public static final int CALL_NOTIF_ID = 9001;

  @Override
  public void onNewToken(@NonNull String token) {
    super.onNewToken(token);
    Log.d(TAG, "New FCM Token: " + token);
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

    NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CALL_CHANNEL_ID)
        .setSmallIcon(appIcon())
        .setContentTitle(callerName)
        .setContentText(body)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setAutoCancel(true)
        .setOngoing(true)
        .setContentIntent(fullScreenPending)
        .setFullScreenIntent(fullScreenPending, true)
        .addAction(0, "Decline", declinePending)
        .addAction(0, "Accept", acceptPending);

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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel ch = new NotificationChannel(
          MSG_CHANNEL_ID, "D4EXAM Messages", NotificationManager.IMPORTANCE_HIGH);
      ch.enableVibration(true);
      nm.createNotificationChannel(ch);
    }

    String callerName = data.get("callerName");
    String callerMatric = data.get("callerMatric");
    if (callerName == null || callerName.isEmpty()) callerName = "Someone";
    String body = "Missed call from " + callerName;
    if (callerMatric != null && !callerMatric.isEmpty()) body = body + " · " + callerMatric;

    Intent intent = new Intent(this, MainActivity.class);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    intent.putExtra("d4_call_action", "missed");
    PendingIntent pi = PendingIntent.getActivity(
        this, 200, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
        .setSmallIcon(appIcon())
        .setContentTitle("Missed call")
        .setContentText(body)
        .setAutoCancel(true)
        .setContentIntent(pi)
        .setPriority(NotificationCompat.PRIORITY_HIGH);

    try {
      nm.cancel(CALL_NOTIF_ID);
      nm.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), b.build());
    } catch (SecurityException ignored) {}
  }

  private void handleNormalNotification(RemoteMessage remoteMessage) {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel ch = new NotificationChannel(
          MSG_CHANNEL_ID, "D4EXAM Messages", NotificationManager.IMPORTANCE_HIGH);
      ch.enableVibration(true);
      nm.createNotificationChannel(ch);
    }

    String title = "D4EXAM";
    String body = "New notification";
    if (remoteMessage.getNotification() != null) {
      if (remoteMessage.getNotification().getTitle() != null) title = remoteMessage.getNotification().getTitle();
      if (remoteMessage.getNotification().getBody() != null) body = remoteMessage.getNotification().getBody();
    } else if (remoteMessage.getData() != null) {
      if (remoteMessage.getData().get("title") != null) title = remoteMessage.getData().get("title");
      if (remoteMessage.getData().get("message") != null) body = remoteMessage.getData().get("message");
      else if (remoteMessage.getData().get("body") != null) body = remoteMessage.getData().get("body");
    }

    Intent intent = new Intent(this, MainActivity.class);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pi = PendingIntent.getActivity(
        this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    NotificationCompat.Builder b = new NotificationCompat.Builder(this, MSG_CHANNEL_ID)
        .setSmallIcon(appIcon())
        .setContentTitle(title)
        .setContentText(body)
        .setAutoCancel(true)
        .setContentIntent(pi)
        .setPriority(NotificationCompat.PRIORITY_HIGH);

    try {
      nm.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), b.build());
    } catch (SecurityException ignored) {}
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
