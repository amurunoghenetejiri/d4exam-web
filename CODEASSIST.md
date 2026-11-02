# How to run D4EXAM in Code Assist

## STOP opening the website root
If you open `d4exam-web` (full repo), Code Assist shows:
**"No build system recognized / Nothing to run"**

That folder is mostly a **website**, not a pure Android app.

## DO THIS instead

1. **Pull** latest `d4exam-web` from GitHub.
2. **Close** the current project in Code Assist.
3. Open **only** this folder:

```text
d4exam-web/D4EXAMApp
```

4. Wait for Gradle sync.
5. Press **Run** (green play) on the **app** module.

You should install **D4EXAM** and see the same login/UI as the website.

## Folder layout (what Code Assist needs)

```text
D4EXAMApp/
  settings.gradle      ← include :app
  build.gradle         ← Android Gradle plugin
  app/
    build.gradle       ← com.android.application
    src/main/...
```

Same style as your working **D4AI** project.

## Do not open
- `d4exam-web` (website root)
- `android/capacitor-cordova-android-plugins` (library only)
