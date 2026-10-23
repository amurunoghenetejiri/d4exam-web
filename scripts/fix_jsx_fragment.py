#!/usr/bin/env python3
"""Fix SyntaxError: adjacent JSX needs a fragment wrapper."""
from pathlib import Path

HUB = Path(__file__).resolve().parents[1] / "src" / "routes" / "student.messages.tsx"

def main() -> None:
    t = HUB.read_text(encoding="utf-8")
    orig = t

    broken = (
        "{(tab === \"chats\" || tab === \"groups\") && (\n"
        "            \n"
        "              {/* Archived chats row */}\n"
    )
    fixed = (
        "{(tab === \"chats\" || tab === \"groups\") && (\n"
        "            <>\n"
        "              {/* Archived chats row */}\n"
    )
    if broken in t:
        t = t.replace(broken, fixed, 1)
        # Close fragment before the closing of the && (
        close_broken = (
            "              selectedId={activeChatId}\n"
            "            />\n"
            "          )}\n"
            "\n"
            "          {tab === \"students\""
        )
        close_fixed = (
            "              selectedId={activeChatId}\n"
            "            />\n"
            "            </>\n"
            "          )}\n"
            "\n"
            "          {tab === \"students\""
        )
        if close_broken in t:
            t = t.replace(close_broken, close_fixed, 1)
            print("closed fragment")
        else:
            print("WARN close not found")
        print("opened fragment")
    else:
        # alternate whitespace
        import re
        t2, n = re.subn(
            r'(\{\(tab === "chats" \|\| tab === "groups"\) && \(\n\s*)(\{/\* Archived chats row \*/\})',
            r'\1<>\n              \2',
            t,
            count=1,
        )
        if n:
            t = t2
            t3, n2 = re.subn(
                r'(selectedId=\{activeChatId\}\n\s*/>)\n(\s*\)\})',
                r'\1\n            </>\n\2',
                t,
                count=1,
            )
            if n2:
                t = t3
                print("regex fixed")
            else:
                print("WARN regex close failed")
        else:
            print("pattern not found")

    if t == orig:
        print("NO_CHANGE")
        return
    HUB.write_text(t, encoding="utf-8")
    print("OK", len(t))

if __name__ == "__main__":
    main()
