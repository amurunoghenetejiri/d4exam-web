#!/usr/bin/env python3
"""Fix ConversationList: setSelectedChatIds is out of scope and crashes every click."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HUB = ROOT / "src" / "routes" / "student.messages.tsx"

def main() -> None:
    t = HUB.read_text(encoding="utf-8")
    orig = t

    # 1) Critical: remove out-of-scope selection so onOpen always runs
    t = t.replace(
        "if (selectedChatIds.length > 0) { setSelectedChatIds((prev) => prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]); return; } ",
        "",
    )
    t = t.replace(
        "setSelectedChatIds((prev) => prev.includes(c.id) ? prev : [...prev, c.id])",
        "void 0",
    )

    # 2) Always inject Me at top when returning filtered list
    if 'id: "__me__"' not in t and "id: '__me__'" not in t:
        old_empty = "if (!q) return list;"
        new_empty = (
            "if (!q) {\n"
            "      if (userId && !list.some((c) => c.title === \"You\" || c.title === \"Me\" || (c as { isSelf?: boolean }).isSelf)) {\n"
            "        return [{\n"
            "          id: \"__me__\",\n"
            "          type: \"direct\" as const,\n"
            "          title: \"You\",\n"
            "          subtitle: \"Message yourself\",\n"
            "          preview: \"\",\n"
            "          avatar_url: null,\n"
            "          time: null,\n"
            "          unread: 0,\n"
            "          isGroup: false,\n"
            "          peerUserId: userId,\n"
            "          hasMessage: false,\n"
            "          isSelf: true,\n"
            "        } as ConversationListItem & { isSelf?: boolean }, ...list];\n"
            "      }\n"
            "      return list;\n"
            "    }"
        )
        if old_empty in t:
            t = t.replace(old_empty, new_empty, 1)

    # 3) Resolve synthetic Me id on open
    if 'id === "__me__"' not in t:
        needle = "if (!id) return;"
        inject = (
            "if (!id) return;\n"
            "      if (id === \"__me__\") {\n"
            "        void (async () => {\n"
            "          try {\n"
            "            const realId = await getOrCreateSelfChat(userId, schoolId || schoolIdHint || null);\n"
            "            try { sessionStorage.setItem(`d4_chat_title_${realId}`, \"Me\"); } catch { /* */ }\n"
            "            setActiveChatId(realId);\n"
            "            try { appNavigate(`/student/messages/${realId}`); } catch { /* */ }\n"
            "            try {\n"
            "              void navigate({ to: \"/student/messages/$conversationId\", params: { conversationId: realId } });\n"
            "            } catch { /* */ }\n"
            "            void qc.invalidateQueries({ queryKey: [\"campus-conversations\", userId] });\n"
            "          } catch (e) {\n"
            "            toast.error(e instanceof Error ? e.message : \"Could not open Me chat\");\n"
            "          }\n"
            "        })();\n"
            "        return;\n"
            "      }"
        )
        # Only replace the first occurrence inside openConversation
        idx = t.find("const openConversation")
        if idx >= 0:
            sub = t[idx:]
            if needle in sub:
                sub2 = sub.replace(needle, inject, 1)
                t = t[:idx] + sub2

    # 4) Show label Me instead of You
    if '? "Me" : c.title' not in t and "? 'Me' : c.title" not in t:
        t = t.replace(
            "{c.title}\n                  {c.isGroup ? (",
            "{(c.title === \"You\" || (c as { isSelf?: boolean }).isSelf) ? \"Me\" : c.title}\n                  {c.isGroup ? (",
            1,
        )

    # 5) Fix openConversation deps if we added userId usage
    if "getOrCreateSelfChat(userId" in t and "[navigate, userId" not in t:
        t = t.replace(
            "    [navigate],\n  );\n\n  const startDirect",
            "    [navigate, userId, schoolId, schoolIdHint, qc],\n  );\n\n  const startDirect",
            1,
        )

    if t == orig:
        print("NO_CHANGE")
        return

    # Sanity: the crash pattern must be gone from ConversationList body
    start = t.find("function ConversationList")
    end = t.find("\nfunction ", start + 10) if start >= 0 else -1
    body = t[start:end] if start >= 0 and end > start else t
    if "setSelectedChatIds((prev) => prev.includes(c.id)" in body:
        raise SystemExit("FAILED: crash pattern still in ConversationList")

    HUB.write_text(t, encoding="utf-8")
    print("OK", len(t))

if __name__ == "__main__":
    main()
