#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MSG = ROOT / "src" / "lib" / "messaging.ts"
HUB = ROOT / "src" / "routes" / "student.messages.tsx"

def patch_messaging():
    t = MSG.read_text(encoding="utf-8")
    if 'rpc("get_or_create_self_chat"' in t:
        print("messaging already RPC")
        return
    old = (
        '  if (!resolvedSchool) throw new Error("No school linked");\n'
        '  const { data: conv, error } = await supabase.from("conversations").insert({ school_id: resolvedSchool, type: "direct", title: "You", description: "Message yourself", created_by: userId, updated_at: new Date().toISOString() } as never).select("id").single();\n'
        '  if (error || !conv?.id) throw new Error(error?.message || "Could not create self chat");\n'
        '  await supabase.from("conversation_members").insert({ conversation_id: conv.id, user_id: userId, role: "owner" } as never);\n'
        '  return conv.id as string;'
    )
    new = (
        '  // Prefer SECURITY DEFINER RPC (bypasses conversations RLS)\n'
        '  const { data: rpcId, error: rpcErr } = await supabase.rpc("get_or_create_self_chat", { p_school_id: resolvedSchool || null });\n'
        '  if (!rpcErr && rpcId) return rpcId as string;\n'
        '  throw new Error(rpcErr?.message || "Could not create self chat");'
    )
    if old not in t:
        raise SystemExit("messaging insert pattern missing")
    MSG.write_text(t.replace(old, new, 1), encoding="utf-8")
    print("messaging RPC OK")

def patch_hub():
    t = HUB.read_text(encoding="utf-8")
    orig = t

    if "function d4TwoNames" not in t and "function d4IsPinned" in t:
        t = t.replace(
            "function d4IsPinned",
            'function d4TwoNames(full: string) { const parts = (full || "").trim().split(/\\s+/).filter(Boolean); return parts.slice(0, 2).join(" ") || full || "You"; }\nfunction d4IsPinned',
            1,
        )

    t = t.replace(
        'title: myDisplayName ? `${myDisplayName} (You)` : "You",',
        'title: myDisplayName ? `${d4TwoNames(myDisplayName)} (You)` : "You",',
    )
    t = t.replace(
        'sessionStorage.setItem(`d4_chat_title_${realId}`, myDisplayName ? `${myDisplayName} (You)` : "You")',
        'sessionStorage.setItem(`d4_chat_title_${realId}`, myDisplayName ? `${d4TwoNames(myDisplayName)} (You)` : "You")',
    )

    old_all = 'const allChats = [...conversationsWithPending].filter((c) => showArchived ? archivedIds.includes(c.id) : !archivedIds.includes(c.id)).sort('
    new_all = (
        'const allChats = [...conversationsWithPending].filter((c) => {\n'
        '      const isMe = c.id === "__me__" || c.title === "You" || c.title === "Me" || (typeof c.title === "string" && c.title.includes("(You)")) || (c as { isSelf?: boolean }).isSelf;\n'
        '      if (isMe && showArchived) return false;\n'
        '      if (showArchived) return archivedIds.includes(c.id) && !isMe;\n'
        '      return !archivedIds.includes(c.id);\n'
        '    }).sort('
    )
    if old_all in t:
        t = t.replace(old_all, new_all, 1)

    t = t.replace(
        'const list = tab === "groups" ? groups : allChats;\n    if (!q) {\n      if (userId && !list.some((c) => c.title === "You" || c.title === "Me" || (c as { isSelf?: boolean }).isSelf)) {',
        'const list = tab === "groups" ? groups : allChats;\n    if (!q) {\n      if (tab !== "groups" && userId && !list.some((c) => c.title === "You" || c.title === "Me" || (typeof c.title === "string" && c.title.includes("(You)")) || (c as { isSelf?: boolean }).isSelf)) {',
    )

    t = t.replace(
        'className="absolute right-0 top-11 z-50 min-w-[200px] rounded-xl bg-[#1e293b] py-1 shadow-xl ring-1 ring-white/10"',
        'className="absolute right-0 top-11 z-[300] min-w-[210px] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-2xl"',
    )
    t = t.replace(
        'className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10"',
        'className="block w-full px-4 py-2.5 text-left text-sm font-medium text-slate-800 hover:bg-slate-100"',
    )
    t = t.replace(
        'className="block w-full px-4 py-2.5 text-left text-sm text-rose-300 hover:bg-white/10"',
        'className="block w-full px-4 py-2.5 text-left text-sm font-medium text-rose-600 hover:bg-rose-50"',
    )
    t = t.replace(
        'className="relative flex items-center gap-0.5 px-2 pb-3 pt-2.5" data-wa-select-header',
        'className="relative z-[120] flex items-center gap-0.5 px-2 pb-3 pt-2.5" data-wa-select-header',
    )
    t = t.replace(
        'className="relative z-10 shrink-0 bg-[#0b1b3a] text-white"',
        'className="relative z-[100] shrink-0 bg-[#0b1b3a] text-white"',
    )

    t = t.replace(
        'onClick={() => { const next=[...pinnedIds]; for (const id of selectedChatIds) { if (!next.includes(id)) next.unshift(id); } persistPins(next); toast.success("Pinned"); setSelectedChatIds([]); }}><Pin className="h-5 w-5" /></button>',
        'onClick={() => { const allPinned = selectedChatIds.length > 0 && selectedChatIds.every((id) => pinnedIds.includes(id)); let next = [...pinnedIds]; if (allPinned) { next = next.filter((id) => !selectedChatIds.includes(id)); toast.success("Unpinned"); } else { for (const id of selectedChatIds) { if (!next.includes(id)) next.unshift(id); } toast.success("Pinned"); } persistPins(next); setSelectedChatIds([]); }}><Pin className="h-5 w-5" /></button>',
    )

    t = t.replace(
        'onClick={() => { const next=[...new Set([...archivedIds, ...selectedChatIds.filter((id)=>id!=="__me__")])]; persistArchives(next); toast.success("Archived"); setSelectedChatIds([]); }}><Archive className="h-5 w-5" /></button>',
        'onClick={() => { if (showArchived) { const next = archivedIds.filter((id) => !selectedChatIds.includes(id)); persistArchives(next); toast.success("Unarchived"); } else { const next=[...new Set([...archivedIds, ...selectedChatIds.filter((id)=>id!=="__me__")])]; persistArchives(next); toast.success("Archived"); } setSelectedChatIds([]); }}><Archive className="h-5 w-5" /></button>',
    )

    m = re.search(
        r"\s*\{/\* Quick action cards[\s\S]*?</div>\n        </div>\n\n        \{/\* List body \*/\}",
        t,
    )
    if m and "data-filter-cards" not in t:
        new_cards = (
            "\n"
            "        {/* Filter cards - horizontal scroll */}\n"
            '        <div className="shrink-0 px-2.5 pt-2 sm:px-3" data-filter-cards>\n'
            '          <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">\n'
            "            {([\n"
            '              ["archived", "Archived", archivedIds.length],\n'
            '              ["unread", "Unread", conversationsWithPending.reduce((n, c) => n + (c.unread || 0), 0)],\n'
            '              ["starred", "Starred", 0],\n'
            '              ["favorites", "Favorites", 0],\n'
            '              ["blocked", "Blocked", 0],\n'
            '              ["deleted", "Deleted", 0],\n'
            "            ] as const).map(([key, label, count]) => {\n"
            '              const active = key === "archived" && showArchived;\n'
            "              return (\n"
            "                <button\n"
            "                  key={key}\n"
            '                  type="button"\n'
            "                  onClick={() => {\n"
            '                    if (key === "archived") setShowArchived((v) => !v);\n'
            '                    else if (key === "unread") {\n'
            "                      setShowArchived(false);\n"
            '                      toast.message("Showing unread chats");\n'
            "                    } else toast.message(`${label} - coming soon`);\n"
            "                  }}\n"
            "                  className={\n"
            '                    "flex h-12 min-w-[6.75rem] shrink-0 items-center gap-2 rounded-2xl border px-2.5 text-left shadow-sm transition active:scale-[0.98] " +\n'
            '                    (active ? "border-[#2563eb] bg-[#dbeafe]" : "border-blue-100 bg-white hover:border-[#2563eb]/40")\n'
            "                  }\n"
            "                >\n"
            '                  <span className="grid h-8 w-8 place-items-center rounded-full bg-[#eff6ff] text-[#2563eb]">\n'
            '                    {key === "archived" ? <Archive className="h-3.5 w-3.5" /> : key === "unread" ? <Bell className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}\n'
            "                  </span>\n"
            '                  <span className="min-w-0">\n'
            '                    <span className="block truncate text-[11px] font-bold text-slate-900">{label}</span>\n'
            '                    <span className="block text-[10px] font-semibold text-slate-500">{count}</span>\n'
            "                  </span>\n"
            "                </button>\n"
            "              );\n"
            "            })}\n"
            "          </div>\n"
            "        </div>\n"
            "\n"
            "        {/* List body */}\n"
        )
        t = t[: m.start()] + new_cards + t[m.end() :]
        print("filter cards OK")

    t2 = re.sub(
        r"\s*\{/\* Archived chats row \*/\}[\s\S]*?\) : null\}\n",
        "\n",
        t,
        count=1,
    )
    if t2 != t:
        t = t2
        print("removed archived row")

    t = t.replace(
        '"flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left shadow-sm transition active:scale-[0.99]"',
        '"flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left shadow-sm transition active:scale-[0.99]"',
    )

    if t != orig:
        HUB.write_text(t, encoding="utf-8")
        print("hub OK", len(t))
    else:
        print("hub NO_CHANGE")

def main():
    patch_messaging()
    patch_hub()

if __name__ == "__main__":
    main()
