package com.d4exam.app;

import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * D4EXAM MainActivity — Capacitor WebView application (not Chrome).
 *
 * Online: loads https://d4exam.name.ng inside this WebView so login and all
 * routes work. Offline: errorPath offline.html still inside the WebView.
 *
 * BridgeWebViewClient keeps D4EXAM / Supabase / Firebase in-app (never Chrome).
 * Plugins: ExamImmersive, ScreenShare (MediaProjection), Capgo biometric, push.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(ExamImmersivePlugin.class);
    registerPlugin(ScreenSharePlugin.class);
    registerPlugin(D4NativeAuthPlugin.class);
    registerPlugin(D4CallPlugin.class);
    // Loads local bundled D4EXAM (webDir=dist); never hand off internal routes to Chrome.
    super.onCreate(savedInstanceState);
    applyChromeColors();
    installInAppNavigationClient();
    enableBackgroundMedia();
    deliverCallIntent(getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    deliverCallIntent(intent);
  }

  /** Forward full-screen / notification call intents into the WebView. */
  private void deliverCallIntent(Intent intent) {
    if (intent == null) return;
    String action = intent.getStringExtra("d4_call_action");
    if (action == null || action.isEmpty()) return;
    String callId = intent.getStringExtra("d4_call_id");
    String callType = intent.getStringExtra("d4_call_type");
    if (callId == null) callId = "";
    if (callType == null) callType = "voice";
    final String js =
        "window.dispatchEvent(new CustomEvent('d4-native-call',{detail:{"
            + "action:" + jsonStr(action) + ","
            + "callId:" + jsonStr(callId) + ","
            + "callType:" + jsonStr(callType)
            + "}}));";
    try {
      Bridge bridge = getBridge();
      if (bridge != null && bridge.getWebView() != null) {
        bridge.getWebView().post(() -> {
          try {
            bridge.getWebView().evaluateJavascript(js, null);
          } catch (Throwable ignored) {}
        });
      }
    } catch (Throwable ignored) {}
  }

  private static String jsonStr(String s) {
    if (s == null) return "null";
    return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  /** Allow voice notes / call audio without an extra user gesture after first interaction. */
  private void enableBackgroundMedia() {
    try {
      Bridge bridge = getBridge();
      if (bridge != null && bridge.getWebView() != null) {
        bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
      }
    } catch (Throwable ignored) {}
  }

  @Override
  public void onResume() {
    super.onResume();
    applyChromeColors();
    installInAppNavigationClient();
  }

  /**
   * Keep D4EXAM + auth/API hosts inside the WebView. Only unknown external
   * hosts use Capacitor's default handling (may open browser).
   */
  private void installInAppNavigationClient() {
    try {
      Bridge bridge = getBridge();
      if (bridge == null) return;
      WebView webView = bridge.getWebView();
      if (webView == null) return;
      webView.setWebViewClient(
          new BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
              if (request == null || request.getUrl() == null) {
                return super.shouldOverrideUrlLoading(view, request);
              }
              if (shouldStayInApp(request.getUrl())) {
                // false = load in this WebView (never Chrome)
                return false;
              }
              return super.shouldOverrideUrlLoading(view, request);
            }
          });
    } catch (Throwable ignored) {
      // Never block launch
    }
  }

  private static boolean shouldStayInApp(Uri uri) {
    try {
      String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase() : "";
      if ("file".equals(scheme) || "about".equals(scheme) || "data".equals(scheme)
          || "capacitor".equals(scheme) || "http".equals(scheme) || "https".equals(scheme)) {
        // continue host checks for http(s)
      } else {
        return false;
      }
      if ("file".equals(scheme) || "about".equals(scheme) || "data".equals(scheme)
          || "capacitor".equals(scheme)) {
        return true;
      }
      String host = uri.getHost();
      if (host == null) return true;
      host = host.toLowerCase();
      if (host.equals("localhost") || host.equals("127.0.0.1")) return true;
      if (host.contains("d4exam.name.ng")) return true;
      if (host.contains("d4exam-platform.vercel.app")) return true;
      if (host.endsWith("vercel.app") && host.contains("d4exam")) return true;
      if (host.contains("supabase.co")) return true;
      if (host.contains("googleapis.com") || host.contains("gstatic.com")) return true;
      if (host.contains("firebaseio.com")
          || host.contains("firebasestorage.app")
          || host.contains("firebaseapp.com")) {
        return true;
      }
      return false;
    } catch (Throwable t) {
      return true;
    }
  }

  private void applyChromeColors() {
    try {
      Window w = getWindow();
      if (w == null) return;
      int navy = Color.parseColor("#0b1b3a");
      w.setStatusBarColor(navy);
      w.setNavigationBarColor(navy);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        w.setNavigationBarContrastEnforced(false);
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        View decor = w.getDecorView();
        int flags = decor.getSystemUiVisibility();
        flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        decor.setSystemUiVisibility(flags);
      }
    } catch (Exception ignored) {
    }
  }
}
