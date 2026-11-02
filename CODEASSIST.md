# Open D4EXAM in Code Assist / Android Studio

## Why you see "No build system" / "Nothing to run"

You opened the **website** folder (`d4exam-web` root = Vite/React).
That is **not** an Android Gradle project by itself.

## Fix (pick one)

### Option A — Open the Android folder (recommended)
1. In Code Assist: close this project
2. Clone or open: `d4exam-web/android`
3. Wait for Gradle sync
4. Run the **app** module

### Option B — Stay at repo root
1. Pull latest (includes root `settings.gradle` pointing at `android/app`)
2. Sync Gradle
3. Run **:app**

## Before first APK build (on a machine with Node)
```bash
npm install
npm run cap:offline
```
Then open `android/` and Run.

## Website
Login and pages are fixed in the same repo — deploy/pull for web + rebuild APK for app.
