#!/usr/bin/env python3
from pathlib import Path
HUB = Path(__file__).resolve().parents[1] / "src" / "routes" / "student.messages.tsx"
t = HUB.read_text(encoding="utf-8")
orig = t
t = t.replace(
    "onContextMenu={(e) => { e.preventDefault(); void 0; }}",
    "onContextMenu={(e) => { e.preventDefault(); d4SelectBridge()?.enter(c.id); }}",
)
t = t.replace(
    "setTimeout(() => void 0, 480)",
    "setTimeout(() => { d4SelectBridge()?.enter(c.id); try { navigator.vibrate?.(10); } catch {} }, 450)",
)
t = t.replace(
    "onClick={() => { onOpen(c.id, { title: c.title, peerUserId: c.peerUserId || undefined }); }}",
    "onClick={() => { const b = d4SelectBridge(); if (b && (b.mode || (b.ids && b.ids.length > 0))) { b.toggle(c.id); return; } onOpen(c.id, { title: (c.title === \"You\" || (c as { isSelf?: boolean }).isSelf) ? \"Me\" : c.title, peerUserId: c.peerUserId || undefined }); }}",
)
if t == orig:
    print("NO_CHANGE")
else:
    HUB.write_text(t, encoding="utf-8")
    print("OK")
