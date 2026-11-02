#!/usr/bin/env python3
"""Offline-first Capacitor Android assets. Set D4EXAM_LIVE_UI=1 for hybrid live UI."""
from __future__ import annotations
import json, os, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
CFG = ROOT / "android" / "app" / "src" / "main" / "assets" / "capacitor.config.json"
LIVE_URL = os.environ.get("D4EXAM_LIVE_URL", "https://d4exam-platform.vercel.app")
USE_LIVE = os.environ.get("D4EXAM_LIVE_UI", "").strip() in ("1", "true", "yes")

def main() -> int:
    if not CFG.exists():
        print("WARN: no assets capacitor.config.json yet (run cap sync first)")
        return 0
    d = json.loads(CFG.read_text(encoding="utf-8"))
    server = dict(d.get("server") or {})
    if USE_LIVE:
        server["url"] = LIVE_URL
        print("MODE: hybrid live UI", LIVE_URL)
    else:
        server.pop("url", None)
        print("MODE: offline-first (bundled dist)")
    server["androidScheme"] = "https"
    server["cleartext"] = False
    server["errorPath"] = "offline.html"
    server["hostname"] = "localhost"
    server["allowNavigation"] = [
        "d4exam.name.ng", "*.d4exam.name.ng", "d4exam-platform.vercel.app",
        "*.vercel.app", "*.supabase.co", "*.googleapis.com", "*.gstatic.com",
        "*.firebaseio.com", "*.firebasestorage.app", "*.firebaseapp.com", "localhost",
    ]
    d["server"] = server
    plugins = dict(d.get("plugins") or {})
    plugins["SplashScreen"] = {
        "launchShowDuration": 0, "launchAutoHide": False, "backgroundColor": "#0b1b3a",
        "androidSplashResourceName": "splash", "androidScaleType": "CENTER",
        "showSpinner": False, "splashFullScreen": True, "splashImmersive": True,
        "launchFadeOutDuration": 250,
    }
    d["plugins"] = plugins
    d["webDir"] = "dist"
    d["appId"] = d.get("appId") or "com.d4exam.app"
    d["appName"] = d.get("appName") or "D4EXAM"
    CFG.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
    print("OK")
    return 0
if __name__ == "__main__":
    sys.exit(main())
