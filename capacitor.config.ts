import type { CapacitorConfig } from "@capacitor/cli";

/**
 * D4EXAM Capacitor Android — 100% local-first standalone APK.
 *
 * Production runtime:
 *   APK → native splash → dist/ (webDir) via https://localhost
 *   → Capacitor bridge intact → native plugins → Supabase only when online
 *
 * NO server.url — remote URL breaks offline boot and can sever the Capacitor
 * bridge via HTTP redirects. scripts/force-local-capacitor-assets.py enforces this.
 * Web (Vercel) deploy is unchanged; this config only affects the APK shell.
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
      launchShowDuration: 15000,
      launchAutoHide: false,
      backgroundColor: "#0b1b3a",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
      launchFadeOutDuration: 300,
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
