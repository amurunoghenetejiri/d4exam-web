#!/usr/bin/env python3
"""Wire long-press multi-select without scope bugs; show Me label."""
from pathlib import Path

HUB = Path(__file__).resolve().parents[1] / "src" / "routes" / "student.messages.tsx"

def main() -> None:
    t = HUB.read_text(encoding="utf-8")
    orig = t

    # Bridge selection state for ConversationList
    if "__d4ChatSelectBridge" not in t:
        bridge = '''
  useEffect(() => {
    const w = window as unknown as {
      __d4ChatSelectBridge?: {
        ids: string[];
        mode: boolean;
        toggle: (id: string) => void;
        enter: (id: string) => void;
      };
    };
    w.__d4ChatSelectBridge = {
      ids: selectedChatIds,
      mode: selectionMode,
      toggle: (id: string) =>
        setSelectedChatIds((prev) =>
          prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        ),
      enter: (id: string) =>
        setSelectedChatIds((prev) => (prev.includes(id) ? prev : [...prev, id])),
    };
    return () => {
      try {
        delete w.__d4ChatSelectBridge;
      } catch {
        /* */
      }
    };
  }, [selectedChatIds, selectionMode]);
'''
        needle = "const selectionMode = selectedChatIds.length > 0;"
        if needle in t:
            t = t.replace(needle, needle + bridge, 1)

    if "function d4SelectBridge" not in t:
        helper = '''
function d4SelectBridge() {
  try {
    return (
      window as unknown as {
        __d4ChatSelectBridge?: {
          ids: string[];
          mode: boolean;
          toggle: (id: string) => void;
          enter: (id: string) => void;
        };
      }
    ).__d4ChatSelectBridge;
  } catch {
    return undefined;
  }
}
'''
        t = t.replace("function ConversationList(", helper + "\nfunction ConversationList(", 1)

    # Click: if selection mode, toggle; else open
    t = t.replace(
        "onClick={() => { onOpen(c.id, { title: c.title, peerUserId: c.peerUserId || undefined }); }}",
        "onClick={() => { const b = d4SelectBridge(); if (b && (b.mode || (b.ids && b.ids.length > 0))) { b.toggle(c.id); return; } onOpen(c.id, { title: (c.title === \"You\" || (c as { isSelf?: boolean }).isSelf) ? \"Me\" : c.title, peerUserId: c.peerUserId || undefined }); }}",
        1,
    )

    # Context menu / long-press enter selection
    t = t.replace(
        "onContextMenu={(e) => { e.preventDefault(); void 0; }}",
        "onContextMenu={(e) => { e.preventDefault(); d4SelectBridge()?.enter(c.id); }}",
        1,
    )
    # if still has setSelectedChatIds or void 0 variants
    t = t.replace(
        "onContextMenu={(e) => { e.preventDefault(); setSelectedChatIds((prev) => prev.includes(c.id) ? prev : [...prev, c.id]); }}",
        "onContextMenu={(e) => { e.preventDefault(); d4SelectBridge()?.enter(c.id); }}",
        1,
    )

    old_touch = 'onTouchStart={() => { const timer = window.setTimeout(() => void 0, 480); const clear = () => clearTimeout(timer); window.addEventListener("touchend", clear, { once: true }); window.addEventListener("touchmove", clear, { once: true }); }}'
    new_touch = 'onTouchStart={() => { const timer = window.setTimeout(() => { d4SelectBridge()?.enter(c.id); try { navigator.vibrate?.(10); } catch {} }, 450); const clear = () => window.clearTimeout(timer); window.addEventListener("touchend", clear, { once: true }); window.addEventListener("touchmove", clear, { once: true }); }}'
    if old_touch in t:
        t = t.replace(old_touch, new_touch, 1)
    else:
        t = t.replace(
            "setTimeout(() => void 0, 480)",
            "setTimeout(() => { d4SelectBridge()?.enter(c.id); try { navigator.vibrate?.(10); } catch {} }, 450)",
            1,
        )

    # Highlight selected rows
    t = t.replace(
        "selectedId && selectedId === c.id\n                ? \"border-[#2563eb] bg-[#dbeafe] ring-1 ring-[#2563eb]/30\"",
        "((d4SelectBridge()?.ids || []).includes(c.id) || (selectedId && selectedId === c.id))\n                ? \"border-[#2563eb] bg-[#dbeafe] ring-1 ring-[#2563eb]/30\"",
        1,
    )

    # Me label on list
    if '? "Me" : c.title' not in t:
        t = t.replace(
            "{c.title}\n                  {c.isGroup ? (",
            "{(c.title === \"You\" || (c as { isSelf?: boolean }).isSelf) ? \"Me\" : c.title}\n                  {c.isGroup ? (",
            1,
        )

    if t == orig:
        print("NO_CHANGE")
        return
    HUB.write_text(t, encoding="utf-8")
    print("OK", len(t))

if __name__ == "__main__":
    main()
