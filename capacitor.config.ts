import type { CapacitorConfig } from "@capacitor/cli";

/**
 * D4EXAM Capacitor Android — standalone APK (local bundled assets).
 *
 * Production runtime:
 *   APK → native splash → dist/ (webDir) → Capacitor bridge → native plugins → Supabase online
 *
 * Offline-first: bundled dist/ in the APK (no server.url by default).
 * Website (Vercel) unchanged. Optional hybrid: D4EXAM_LIVE_UI=1 force-local-capacitor-assets.py
 * Native plugins: fingerprint, notifications, camera, screen share.
 */
const config: CapacitorConfig = {
  appId: "com.d4exam.app",
  appName: "D4EXAM",
  webDir: "dist",
  server: {
    androidScheme: "https",
    cleartext: false,
    hostname: "localhost",
    // SPA fallback for deep paths when offline / local shell
    errorPath: "index.html",
    allowNavigation: [
      "*.supabase.co",
      "*.googleapis.com",
      "*.gstatic.com",
      "*.firebaseio.com",
      "*.firebasestorage.app",
      "*.firebaseapp.com",
      "localhost",
    ],
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#0b1b3a",
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      // Keep native splash until JS hides after app shell is ready
      launchShowDuration: 0,
      launchAutoHide: false,
      backgroundColor: "#0b1b3a",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
      launchFadeOutDuration: 250,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0b1b3a",
      overlaysWebView: false,
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    LocalNotifications: {
      smallIcon: "ic_stat_d4exam",
      iconColor: "#0b1b3a",
      sound: "default",
    },
  },
};

export default config;
