# Make the offline APK match main

## Goal
Use the latest `main` app as the single source for every page, layout, design, button, setting, record view, and normal action, while retaining the local-first APK’s offline startup and cached-page access.

## Changes
- Restore all user-facing app files changed on the offline branch from the latest `main`: shared layouts, public shell, login, root shell, router behavior, student/teacher data adapters, and normal authentication/session behavior.
- Keep only the APK-specific offline layer: bundled local startup, no remote `server.url`, offline page fallback, Capacitor entry/build path, cached session/data fallback, and native platform handling.
- Replace blanket server-function stubbing in the APK build with targeted handling so online actions use the same real behavior as main; offline reads continue to use existing caches, while genuinely online-only actions remain blocked offline.
- Keep the backend project, keys, schema, authentication, and existing offline database/cache unchanged.
- Validate the web app, generate the bundled APK web assets, compare the resulting route/page coverage with main, and check the latest build diagnostics.

## Expected result
The APK presents and behaves like the current main app whenever online. When offline, it still starts locally and allows previously cached pages; login, live exam work, latest results, calls, and other server-dependent actions continue to require internet.
