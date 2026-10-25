#!/usr/bin/env python3
from pathlib import Path
root = Path(__file__).parent
a = "".join((root / f"AppShell.part{i}").read_text() for i in range(5) if (root / f"AppShell.part{i}").exists())
d = "".join((root / f"student.part{i}").read_text() for i in range(4) if (root / f"student.part{i}").exists())
(root / "AppShell.tsx.b64").write_text(a)
(root / "student.d4ai.tsx.b64").write_text(d)
print("assembled", len(a), len(d))
