# D4EXAM Android offline-first app

## Website vs App

| | Website | Android app |
|--|---------|-------------|
| UI | Unchanged (Vercel) | Same UI bundled in APK |
| Network | Always online | Offline shell + local SQLite; sync when online |
| Data | Supabase | local-db + outbox → Supabase when online |

## Code Assist "no modules"

Open **`android/`** after `cap sync`, not only the web root.

## Build offline APK

```bash
npm install
npm run build:app
npx cap sync android
python3 scripts/force-local-capacitor-assets.py   # offline-first (default)
cd android && ./gradlew assembleDebug
```

Hybrid live UI (needs network):

```bash
D4EXAM_LIVE_UI=1 python3 scripts/force-local-capacitor-assets.py
```

## Offline stack (already in repo)

- `src/lib/local-db` — SQLite session, entities, outbox
- `src/lib/sync` — push/pull engine
- `src/components/OfflineBootstrap.tsx` — mounts sync (no UI change)
- `public/offline.html` — fallback page

## Website

Vercel / Supabase website stays as-is.
