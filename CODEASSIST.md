# Run D4EXAM in Code Assist

## Why it failed before
1. Repo root is a **website** (Vite) — not Gradle.
2. Capacitor needed `node_modules` (not on phone).
3. Opening `capacitor-cordova-android-plugins` is a **library**, not the app.

## What works now
Android project is **self-contained** (WebView shell, no npm required).

## Steps on your phone
1. **Pull** latest `d4exam-web` from GitHub.
2. In Code Assist **close** the project.
3. Open project folder: **`d4exam-web/android`**  
   (or open `d4exam-web` root — root `settings.gradle` points at `android/app`).
4. Wait for Gradle sync.
5. Select module **app** → press **Run**.

You should see D4EXAM load inside the app (same website UI).

## Note
This runnable build uses an in-app WebView to the live site so it works offline of npm.
Full Capacitor plugins (fingerprint native, etc.) still need `npm run cap:sync` on a PC later.
