#!/usr/bin/env python3
from pathlib import Path
import base64
root = Path(__file__).resolve().parents[1]
parts = (root / "scripts/appshell.b64.1").read_text() + (root / "scripts/appshell.b64.2").read_text()
data = base64.b64decode(parts)
out = root / "src/components/layout/AppShell.tsx"
out.write_bytes(data)
print("OK", out, len(data))
assert b"LiteDrawer" in data
