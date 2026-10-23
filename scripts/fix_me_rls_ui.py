#!/usr/bin/env python3
"""Fix Me chat RLS path, display name, menu z-index, archive style, filter cards."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MSG = ROOT / "src" / "lib" / "messaging.ts"
HUB = ROOT / "src" / "routes" / "student.messages.tsx"

def fix_messaging() -> None:
    t = MSG.read_text(encoding="utf-8")
    if "get_or_create_self_chat" in t:
        print("messaging already uses RPC")
        return
    old = '''export async function getOrCreateSelfChat(userId: string, schoolId?: string | null): Promise<string> {
  if (!userId) throw new Error("Sign in required");
  const resolvedSchool = (await resolveMySchoolId(schoolId || null)) || schoolId || null;
  const { data: memberships } = await supabase.from("conversation_members").select("conversation_id").eq("user_id", userId).is("left_at", null).limit(120);
  const ids = (memberships || []).map((m) => m.conversation_id as string);
  if (ids.length) {
    const { data: convs } = await supabase.from("conversations").select("id, type, title").in("id", ids).eq("type", "direct");
    for (const c of convs || []) {
      const title = String((c as { title?: string }).title || "");
      if (title === "You" || title === "__self__") return c.id as string;
      const { count } = await supabase.from("conversation_members").select("user_id", { count: "exact", head: true }).eq("conversation_id", c.id).is("left_at", null);
      if ((count || 0) === 1) return c.id as string;
    }
  }
  if (!resolvedSchool) throw new Error("No school linked");
  const { data: conv, error } = await supabase.from("conversations").insert({ school_id: resolvedSchool, type: "direct", title: "You", description: "Message yourself", created_by: userId, updated_at: new Date().toISOString() } as never).select("id").single();
  if (error || !conv?.id) throw new Error(error?.message || "Could not create self chat");
  await supabase.from("conversation_members").insert({ conversation_id: conv.id, user_id: userId, role: "owner" } as never);
  return conv.id as string;
}'''
    new = '''export async function getOrCreateSelfChat(userId: string, schoolId?: string | null): Promise<string> {
  if (!userId) throw new Error("Sign in required");
  const resolvedSchool = (await resolveMySchoolId(schoolId || null)) || schoolId || null;

  // SECURITY DEFINER RPC — bypasses conversations RLS safely
  try {
    const { data: rpcId, error: rpcErr } = await supabase.rpc("get_or_create_self_chat", {
      p_school_id: resolvedSchool || null,
    });
    if (!rpcErr && rpcId) return rpcId as string;
    if (rpcErr) console.warn("[getOrCreateSelfChat] rpc", rpcErr.message);
  } catch (e) {
    console.warn("[getOrCreateSelfChat] rpc failed", e);
  }

  // Fallback: find existing sole-member direct chat
  const { data: memberships } = await supabase.from("conversation_members").select("conversation_id").eq("user_id", userId).is("left_at", null).limit(120);
  const ids = (memberships || []).map((m) => m.conversation_id as string);
  if (ids.length) {
    const { data: convs } = await supabase.from("conversations").select("id, type, title").in("id", ids).eq("type", "direct");
    for (const c of convs || []) {
      const title = String((c as { title?: string }).title || "");
      if (title === "You" || title === "__self__" || title.includes("(You)")) return c.id as string;
      const { count } = await supabase.from("conversation_members").select("user_id", { count: "exact", head: true }).eq("conversation_id", c.id).is("left_at", null);
      if ((count || 0) === 1) return c.id as string;
    }
  }
  throw new Error("Could not open Me chat — try again");
}'''
    if old in t:
        t = t.replace(old, new, 1)
        MSG.write_text(t, encoding="utf-8")
        print("messaging OK")
    else:
        # softer replace of insert block only
        if "from(\"conversations\").insert({ school_id: resolvedSchool, type: \"direct\", title: \"You\"" in t:
            t = t.replace(
                '''  if (!resolvedSchool) throw new Error("No school linked");
  const { data: conv, error } = await supabase.from("conversations").insert({ school_id: resolvedSchool, type: "direct", title: "You", description: "Message yourself", created_by: userId, updated_at: new Date().toISOString() } as never).select("id").single();
  if (error || !conv?.id) throw new Error(error?.message || "Could not create self chat");
  await supabase.from("conversation_members").insert({ conversation_id: conv.id, user_id: userId, role: "owner" } as never);
  return conv.id as string;''',
                '''  // Prefer SECURITY DEFINER RPC
  const { data: rpcId, error: rpcErr } = await supabase.rpc("get_or_create_self_chat", { p_school_id: resolvedSchool || null });
  if (!rpcErr && rpcId) return rpcId as string;
  throw new Error(rpcErr?.message || "Could not create self chat");''',
                1,
            )
            MSG.write_text(t, encoding="utf-8")
            print("messaging soft OK")
        else:
            print("messaging pattern not found")

def two_name(expr: str) -> str:
    return f"(({expr}).trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(\" \") || \"You\")"

def fix_hub() -> None:
    t = HUB.read_text(encoding="utf-8")
    orig = t

    # Display name helper used for Me label — first two names only
    if "function d4TwoNames" not in t:
        t = t.replace(
            "function d4IsPinned",
            'function d4TwoNames(full: string) { const parts = (full || "").trim().split(/\\s+/).filter(Boolean); return parts.slice(0, 2).join(" ") || full || "You"; }\nfunction d4IsPinned',
            1,
        )

    # Me row title: two names + (You)
    t = t.replace(
        'title: myDisplayName ? `${myDisplayName} (You)` : "You",',
        'title: myDisplayName ? `${d4TwoNames(myDisplayName)} (You)` : "You",',
    )
    t = t.replace(
        'sessionStorage.setItem(`d4_chat_title_${realId}`, myDisplayName ? `${myDisplayName} (You)` : "You")',
        'sessionStorage.setItem(`d4_chat_title_${realId}`, myDisplayName ? `${d4TwoNames(myDisplayName)} (You)` : "You")',
    )

    # Filter Me out of archived list; exclude __me__ from groups
    if "filterMeFromArchive" not in t:
        t = t.replace(
            'const allChats = [...conversationsWithPending].filter((c) => showArchived ? archivedIds.includes(c.id) : !archivedIds.includes(c.id))',
            'const allChats = [...conversationsWithPending].filter((c) => {
      const isMe = c.id === "__me__" || c.title === "You" || c.title.includes("(You)") || (c as { isSelf?: boolean }).isSelf;
      if (isMe && showArchived) return false;
      if (showArchived) return archivedIds.includes(c.id) && !isMe;
      return !archivedIds.includes(c.id);
    })',
            1,
        )

    # Menu: high z-index, light surface (not black)
    t = t.replace(
        'className="absolute right-0 top-11 z-50 min-w-[200px] rounded-xl bg-[#1e293b] py-1 shadow-xl ring-1 ring-white/10"',
        'className="absolute right-0 top-11 z-[200] min-w-[210px] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-2xl"',
    )
    t = t.replace(
        'className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10"',
        'className="block w-full px-4 py-2.5 text-left text-sm font-medium text-slate-800 hover:bg-slate-100"',
    )
    t = t.replace(
        'className="block w-full px-4 py-2.5 text-left text-sm text-rose-300 hover:bg-white/10"',
        'className="block w-full px-4 py-2.5 text-left text-sm font-medium text-rose-600 hover:bg-rose-50"',
    )
    # Raise selection header z
    t = t.replace(
        'className="relative flex items-center gap-0.5 px-2 pb-3 pt-2.5" data-wa-select-header',
        'className="relative z-[120] flex items-center gap-0.5 px-2 pb-3 pt-2.5" data-wa-select-header',
    )

    # Pin toggles unpin when selected chats are pinned
    t = t.replace(
        'onClick={() => { const next=[...pinnedIds]; for (const id of selectedChatIds) { if (!next.includes(id)) next.unshift(id); } persistPins(next); toast.success("Pinned"); setSelectedChatIds([]); }}><Pin className="h-5 w-5" /></button>',
        'onClick={() => { const allPinned = selectedChatIds.every((id) => pinnedIds.includes(id)); let next = [...pinnedIds]; if (allPinned) { next = next.filter((id) => !selectedChatIds.includes(id)); toast.success("Unpinned"); } else { for (const id of selectedChatIds) { if (!next.includes(id)) next.unshift(id); } toast.success("Pinned"); } persistPins(next); setSelectedChatIds([]); }}><Pin className="h-5 w-5" /></button>',
    )

    # Archive toggles unarchive when in archived view
    t = t.replace(
        'onClick={() => { const next=[...new Set([...archivedIds, ...selectedChatIds.filter((id)=>id!=="__me__")])]; persistArchives(next); toast.success("Archived"); setSelectedChatIds([]); }}><Archive className="h-5 w-5" /></button>',
        'onClick={() => { if (showArchived) { const next = archivedIds.filter((id) => !selectedChatIds.includes(id)); persistArchives(next); toast.success("Unarchived"); } else { const next=[...new Set([...archivedIds, ...selectedChatIds.filter((id)=>id!=="__me__")])]; persistArchives(next); toast.success("Archived"); } setSelectedChatIds([]); }}><Archive className="h-5 w-5" /></button>',
    )

    # Replace quick action cards block
    old_cards_start = '        {/* Quick action cards — slim on mobile */}'
    if old_cards_start in t and 'data-filter-cards' not in t:
        # find end of grid (next section Search already past - cards after search)
        # Locate Create Group QuickCard block
        m = re.search(
            r"\s*\{/\* Quick action cards[\s\S]*?</div>\n        </div>\n\n        \{/\* List body \*/\}",
            t,
        )
        if m:
            new_cards = '''
        {/* Filter cards — horizontal scroll */}
        <div className="shrink-0 px-2.5 pt-2 sm:px-3" data-filter-cards>
          <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {([
              ["archived", "Archived", archivedIds.length],
              ["unread", "Unread", conversationsWithPending.reduce((n, c) => n + (c.unread || 0), 0)],
              ["starred", "Starred", 0],
              ["favorites", "Favorites", 0],
              ["blocked", "Blocked", 0],
              ["deleted", "Deleted", 0],
            ] as const).map(([key, label, count]) => {
              const active = key === "archived" && showArchived;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (key === "archived") setShowArchived((v) => !v);
                    else if (key === "unread") toast.message("Unread filter");
                    else toast.message(`${label} — coming soon`);
                  }}
                  className={cn(
                    "flex h-14 min-w-[7.25rem] shrink-0 items-center gap-2 rounded-2xl border px-3 text-left shadow-sm transition active:scale-[0.98]",
                    active
                      ? "border-[#2563eb] bg-[#dbeafe]"
                      : "border-blue-100 bg-white hover:border-[#2563eb]/40",
                  )}
                >
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-[#eff6ff] text-[#2563eb]">
                    {key === "archived" ? <Archive className="h-4 w-4" /> : key === "unread" ? <Bell className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-bold text-slate-900">{label}</span>
                    <span className="block text-[10px] font-semibold text-slate-500">{count}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* List body */}
'''
            t = t[: m.start()] + new_cards + t[m.end() :]
            print("filter cards")

    # Remove standalone Archived row (now a card)
    t = re.sub(
        r"\s*\{/\* Archived chats row \*/\}[\s\S]*?\) : null\}\n",
        "\n",
        t,
        count=1,
    )

    # Slightly shorter chat rows
    t = t.replace(
        '"flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left shadow-sm transition active:scale-[0.99]"',
        '"flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left shadow-sm transition active:scale-[0.99]"',
    )

    if t != orig:
        HUB.write_text(t, encoding="utf-8")
        print("hub OK", len(t))
    else:
        print("hub NO_CHANGE")

def main() -> None:
    fix_messaging()
    fix_hub()

if __name__ == "__main__":
    main()
