#!/usr/bin/env python3
"""
Configure Capacitor Android assets for 100% local-first offline APK.

  UI / SPA shell  → bundled dist/ via https://localhost (NO remote server.url)
  Permissions / biometrics / notifications / screen share → native Capacitor plugins
  Data             → IndexedDB offline-cache; Supabase only when online

Removing server.url ensures:
  - App boots from local assets even in Airplane Mode
  - window.Capacitor bridge stays intact (no remote HTTP redirects)
  - Fingerprint, ScreenShare, LocalNotifications remain available offline
"""
from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
CFG = ROOT / "android" / "app" / "src" / "main" / "assets" / "capacitor.config.json"


def main() -> int:
    if not CFG.exists():
        print("WARN: no assets capacitor.config.json yet (run cap sync first)")
        return 0

    d = json.loads(CFG.read_text(encoding="utf-8"))
    server = dict(d.get("server") or {})

    # CRITICAL: remove any remote URL so WebView never fetches remote HTML
    server.pop("url", None)
    server.pop("originalUrl", None)

    server["androidScheme"] = "https"
    server["cleartext"] = False
    server["hostname"] = "localhost"
    # SPA fallback for deep paths when offline / local shell
    server["errorPath"] = "index.html"
    server["allowNavigation"] = [
        "*.supabase.co",
        "*.googleapis.com",
        "*.gstatic.com",
        "*.firebaseio.com",
        "*.firebasestorage.app",
        "*.firebaseapp.com",
        "localhost",
    ]

    d["server"] = server

    plugins = dict(d.get("plugins") or {})
    plugins["SplashScreen"] = {
        "launchShowDuration": 15000,
        "launchAutoHide": False,
        "backgroundColor": "#0b1b3a",
        "androidSplashResourceName": "splash",
        "androidScaleType": "CENTER",
        "showSpinner": False,
        "splashFullScreen": True,
        "splashImmersive": True,
        "launchFadeOutDuration": 300,
    }
    plugins["LocalNotifications"] = {
        "smallIcon": "ic_stat_d4exam",
        "iconColor": "#0b1b3a",
        "sound": "default",
    }
    d["plugins"] = plugins
    d["webDir"] = "dist"
    d["appId"] = d.get("appId") or "com.d4exam.app"
    d["appName"] = d.get("appName") or "D4EXAM"

    CFG.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
    print("OK: local-first APK — NO server.url, webDir=dist, hostname=localhost")
    return 0


if __name__ == "__main__":
    sys.exit(main())
