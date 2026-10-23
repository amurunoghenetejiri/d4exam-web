#!/usr/bin/env python3
"""WhatsApp-style Me row, selection header, pin icon, archive row."""
from pathlib import Path

HUB = Path(__file__).resolve().parents[1] / "src" / "routes" / "student.messages.tsx"

def main() -> None:
    t = HUB.read_text(encoding="utf-8")
    orig = t

    # --- Imports for Pin, Archive, VolumeX, PinOff ---
    if "Pin," not in t and "Pin " not in t:
        t = t.replace(
            "  Clock,\n} from \"lucide-react\";",
            "  Clock,\n  Pin,\n  Archive,\n  VolumeX,\n  Trash2,\n} from \"lucide-react\";",
            1,
        )

    # --- myDisplayName state ---
    if "myDisplayName" not in t:
        t = t.replace(
            "const [myNavPhoto, setMyNavPhoto] = useState<string | null>(session?.avatarUrl || null);",
            "const [myNavPhoto, setMyNavPhoto] = useState<string | null>(session?.avatarUrl || null);\n  const [myDisplayName, setMyDisplayName] = useState<string>(\"\");",
            1,
        )
        t = t.replace(
            '.select("profile_photo_url")\n          .eq("auth_user_id", uid)\n          .maybeSingle();\n        const url = (data as { profile_photo_url?: string | null } | null)?.profile_photo_url || null;\n        if (!cancelled && url) setMyNavPhoto(url);',
            '.select("full_name, profile_photo_url")\n          .eq("auth_user_id", uid)\n          .maybeSingle();\n        const row = data as { full_name?: string | null; profile_photo_url?: string | null } | null;\n        const url = row?.profile_photo_url || null;\n        const nm = (row?.full_name || "").trim();\n        if (!cancelled && url) setMyNavPhoto(url);\n        if (!cancelled && nm) setMyDisplayName(nm);',
            1,
        )

    # --- archivedIds state ---
    if "archivedIds" not in t:
        t = t.replace(
            "const persistPins = (ids: string[]) => { setPinnedIds(ids); try { localStorage.setItem(\"d4_pinned_chats\", JSON.stringify(ids)); } catch {} };",
            """const persistPins = (ids: string[]) => { setPinnedIds(ids); try { localStorage.setItem("d4_pinned_chats", JSON.stringify(ids)); } catch {} };
  const [archivedIds, setArchivedIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("d4_archived_chats") || "[]"); } catch { return []; } });
  const persistArchives = (ids: string[]) => { setArchivedIds(ids); try { localStorage.setItem("d4_archived_chats", JSON.stringify(ids)); } catch {} };
  const [showArchived, setShowArchived] = useState(false);
  const [selectMenuOpen, setSelectMenuOpen] = useState(false);""",
            1,
        )

    # --- Me row: Name (You) with photo ---
    old_me = '''          id: "__me__",
          type: "direct" as const,
          title: "You",
          subtitle: "Message yourself",
          preview: "",
          avatar_url: null,'''
    new_me = '''          id: "__me__",
          type: "direct" as const,
          title: myDisplayName ? `${myDisplayName} (You)` : "You",
          subtitle: "Message yourself",
          preview: "",
          avatar_url: myNavPhoto,'''
    if old_me in t:
        t = t.replace(old_me, new_me, 1)
        # deps for useMemo of filtered chats - need myDisplayName, myNavPhoto
        t = t.replace(
            "  }, [allChats, groups, search, tab]);",
            "  }, [allChats, groups, search, tab, userId, myDisplayName, myNavPhoto]);",
            1,
        )

    # Also update isSelf check for Name (You)
    t = t.replace(
        'c.title === "You" || c.title === "Me" || (c as { isSelf?: boolean }).isSelf',
        'c.title === "You" || c.title === "Me" || c.title.includes("(You)") || (c as { isSelf?: boolean }).isSelf',
    )

    # Open Me with proper title
    t = t.replace(
        'sessionStorage.setItem(`d4_chat_title_${realId}`, "Me")',
        'sessionStorage.setItem(`d4_chat_title_${realId}`, myDisplayName ? `${myDisplayName} (You)` : "You")',
    )

    # Label in list: Name (You) not just Me
    t = t.replace(
        '{(c.title === "You" || (c as { isSelf?: boolean }).isSelf) ? "Me" : c.title}',
        '{(c as { isSelf?: boolean }).isSelf || c.title === "You" || c.title.includes("(You)") ? (c.title.includes("(You)") ? c.title : (myDisplayName ? `${myDisplayName} (You)` : "You")) : c.title}',
    )

    # Filter out archived from main list unless showArchived
    if "archivedIds.includes" not in t[t.find("const allChats"):t.find("const allChats")+400]:
        t = t.replace(
            "const allChats = [...conversationsWithPending].sort((a, b) => { const ap = pinnedIds.includes(a.id) ? 1 : 0; const bp = pinnedIds.includes(b.id) ? 1 : 0; if (ap !== bp) return bp - ap; const ay = a.title === \"You\" ? 1 : 0; const by = b.title === \"You\" ? 1 : 0; return by - ay; });",
            """const allChats = [...conversationsWithPending]
    .filter((c) => showArchived ? archivedIds.includes(c.id) : !archivedIds.includes(c.id))
    .sort((a, b) => {
      const ap = pinnedIds.includes(a.id) ? 1 : 0;
      const bp = pinnedIds.includes(b.id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const ay = a.title === "You" || a.title.includes("(You)") || (a as { isSelf?: boolean }).isSelf ? 1 : 0;
      const by = b.title === "You" || b.title.includes("(You)") || (b as { isSelf?: boolean }).isSelf ? 1 : 0;
      if (ay !== by) return by - ay;
      return 0;
    });""",
            1,
        )

    # --- Replace selection sticky bar with nothing (header handles it) ---
    old_bar = '''          {selectionMode ? (
            <div className="sticky top-0 z-30 flex items-center gap-2 bg-[#0b1b3a] px-3 py-2.5 text-white">
              <button type="button" className="px-2 font-bold" onClick={() => setSelectedChatIds([])}>✕</button>
              <span className="flex-1 text-sm font-bold">{selectedChatIds.length} selected</span>
              {selectedChatIds.length === 1 ? (
                <button type="button" className="rounded-lg bg-white/15 px-2 py-1 text-xs font-semibold" onClick={() => { const id = selectedChatIds[0]; const next = pinnedIds.includes(id) ? pinnedIds.filter((x) => x !== id) : [id, ...pinnedIds]; persistPins(next); toast.success(pinnedIds.includes(id) ? "Unpinned" : "Pinned"); setSelectedChatIds([]); }}>Pin</button>
              ) : null}
              <button type="button" className="rounded-lg bg-white/15 px-2 py-1 text-xs font-semibold" onClick={() => { toast.message("Archived"); setSelectedChatIds([]); }}>Archive</button>
              <button type="button" className="rounded-lg bg-rose-500 px-2 py-1 text-xs font-semibold" onClick={async () => { try { for (const id of selectedChatIds) { await supabase.from("conversation_members").update({ left_at: new Date().toISOString() } as never).eq("conversation_id", id).eq("user_id", userId); } toast.success("Deleted"); setSelectedChatIds([]); void qc.invalidateQueries({ queryKey: ["campus-conversations"] }); } catch (e) { toast.error(e instanceof Error ? e.message : "Fail"); } }}>Delete</button>
            </div>
          ) : null}'''
    if old_bar in t:
        t = t.replace(old_bar, "", 1)

    # --- WhatsApp-style selection header (replace normal header content when selecting) ---
    if "selectionMode ? (" not in t[t.find("Navy header"):t.find("Navy header")+1200] if "Navy header" in t else "":
        old_header_inner = '''        <div className="flex items-center gap-2.5 px-3 pb-3 pt-2.5 sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={() => navigate({ to: "/student" })}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/10 active:bg-white/15"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>'''
        # We'll replace a larger block - the whole header flex row
        pass

    # Inject selection header by replacing the header's children block more carefully
    marker = '{/* Navy header */}'
    if marker in t and "WA-select-header" not in t:
        # Find header opening and replace its inner content start with conditional
        hdr = '''{/* Navy header */}
      <header
        className="relative z-10 shrink-0 bg-[#0b1b3a] text-white"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        {selectionMode ? (
          <div className="relative flex items-center gap-1 px-2 pb-3 pt-2.5 sm:px-3" data-wa-select-header>
            <button type="button" onClick={() => { setSelectedChatIds([]); setSelectMenuOpen(false); }} className="grid h-10 w-10 place-items-center rounded-full text-white/90 hover:bg-white/10" aria-label="Cancel selection">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <span className="min-w-[1.5rem] flex-1 text-lg font-bold tabular-nums">{selectedChatIds.length}</span>
            <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Pin" onClick={() => {
              const next = [...pinnedIds];
              for (const id of selectedChatIds) {
                if (!next.includes(id)) next.unshift(id);
              }
              persistPins(next);
              toast.success(selectedChatIds.length === 1 ? "Chat pinned" : "Chats pinned");
              setSelectedChatIds([]);
            }}><Pin className="h-5 w-5" /></button>
            <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Delete" onClick={async () => {
              try {
                for (const id of selectedChatIds) {
                  if (id === "__me__") continue;
                  await supabase.from("conversation_members").update({ left_at: new Date().toISOString() } as never).eq("conversation_id", id).eq("user_id", userId);
                }
                toast.success("Deleted");
                setSelectedChatIds([]);
                void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
              } catch (e) { toast.error(e instanceof Error ? e.message : "Delete failed"); }
            }}><Trash2 className="h-5 w-5" /></button>
            <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Mute" onClick={() => { toast.message("Muted"); setSelectedChatIds([]); }}><VolumeX className="h-5 w-5" /></button>
            <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Archive" onClick={() => {
              const next = [...new Set([...archivedIds, ...selectedChatIds.filter((id) => id !== "__me__")])];
              persistArchives(next);
              toast.success("Archived");
              setSelectedChatIds([]);
            }}><Archive className="h-5 w-5" /></button>
            <div className="relative">
              <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="More" onClick={() => setSelectMenuOpen((v) => !v)}>
                <MoreVertical className="h-5 w-5" />
              </button>
              {selectMenuOpen ? (
                <div className="absolute right-0 top-11 z-50 min-w-[200px] overflow-hidden rounded-xl bg-[#1e293b] py-1 shadow-xl ring-1 ring-white/10">
                  <button type="button" className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10" onClick={async () => {
                    try {
                      const now = new Date().toISOString();
                      for (const id of selectedChatIds) {
                        if (id === "__me__") continue;
                        await supabase.from("conversation_members").update({ last_read_at: now } as never).eq("conversation_id", id).eq("user_id", userId);
                      }
                      toast.success("Marked as read");
                      setSelectedChatIds([]);
                      setSelectMenuOpen(false);
                      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
                    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                  }}>Mark as read</button>
                  <button type="button" className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10" onClick={() => {
                    const ids = (showArchived ? conversationsWithPending.filter((c) => archivedIds.includes(c.id)) : conversationsWithPending.filter((c) => !archivedIds.includes(c.id))).map((c) => c.id);
                    setSelectedChatIds(ids);
                    setSelectMenuOpen(false);
                  }}>Select all</button>
                  <button type="button" className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10" onClick={() => { toast.message("Added to favorites"); setSelectMenuOpen(false); setSelectedChatIds([]); }}>Add to Favorites</button>
                  <button type="button" className="block w-full px-4 py-2.5 text-left text-sm text-rose-300 hover:bg-white/10" onClick={async () => {
                    try {
                      for (const id of selectedChatIds) {
                        if (id === "__me__") continue;
                        await supabase.from("campus_messages").update({ deleted_at: new Date().toISOString() } as never).eq("conversation_id", id);
                      }
                      toast.success("Chats cleared");
                      setSelectedChatIds([]);
                      setSelectMenuOpen(false);
                      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
                    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                  }}>Clear chats</button>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
        <div className="flex items-center gap-2.5 px-3 pb-3 pt-2.5 sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={() => showArchived ? setShowArchived(false) : navigate({ to: "/student" })}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/10 active:bg-white/15"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>'''
        old_hdr_start = '''{/* Navy header */}
      <header
        className="relative z-10 shrink-0 bg-[#0b1b3a] text-white"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="flex items-center gap-2.5 px-3 pb-3 pt-2.5 sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={() => navigate({ to: "/student" })}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/10 active:bg-white/15"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>'''
        if old_hdr_start in t:
            t = t.replace(old_hdr_start, hdr, 1)
            # Close the selectionMode ternary before </header>
            t = t.replace(
                "        </div>\n      </header>\n\n      <div className=\"relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden\">",
                "        </div>\n        )}\n      </header>\n\n      <div className=\"relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden\">",
                1,
            )
            print("selection header")
        else:
            print("WARN header start not found")

    # --- Archived row above list ---
    if "Archived chats row" not in t:
        archived_row = '''
              {!showArchived && archivedIds.length > 0 && tab === "chats" ? (
                <button type="button" onClick={() => setShowArchived(true)} className="mx-3 mb-1 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-2xl border border-blue-100 bg-white/90 px-3 py-3 text-left shadow-sm active:scale-[0.99]">
                  <span className="grid h-11 w-11 place-items-center rounded-full bg-slate-100 text-slate-600"><Archive className="h-5 w-5" /></span>
                  <span className="flex-1 text-[15px] font-semibold text-slate-900">Archived</span>
                  <span className="text-xs font-bold text-slate-400">{archivedIds.length}</span>
                </button>
              ) : null}
              {showArchived ? (
                <div className="mx-3 mb-2 flex items-center gap-2">
                  <p className="text-sm font-bold text-slate-700">Archived chats</p>
                  <button type="button" className="ml-auto text-xs font-semibold text-[#2563eb]" onClick={() => setShowArchived(false)}>Back to chats</button>
                </div>
              ) : null}
'''
        # Insert before ConversationList usage
        if "<ConversationList" in t:
            t = t.replace("<ConversationList", archived_row + "              <ConversationList", 1)
            print("archived row")

    # Pin icon in list title area - after title text
    if "pinnedIds.includes(c.id)" not in t[t.find("function ConversationList"):] if "function ConversationList" in t else True:
        # ConversationList doesn't have pinnedIds - show via title prefix from parent
        # Parent already can pass - add pin in title from list mapping
        pass

    # Add pin emoji in title when rendering - use pinnedIds from parent via data attribute on items
    # Simpler: in ConversationList title line, check pinnedIds from window
    if "d4IsPinned" not in t:
        t = t.replace(
            "function d4SelectBridge() {",
            """function d4IsPinned(id: string) {
  try {
    const raw = localStorage.getItem("d4_pinned_chats");
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    return ids.includes(id);
  } catch { return false; }
}
function d4SelectBridge() {
""",
            1,
        )
        t = t.replace(
            '{(c as { isSelf?: boolean }).isSelf || c.title === "You" || c.title.includes("(You)") ? (c.title.includes("(You)") ? c.title : (myDisplayName ? `${myDisplayName} (You)` : "You")) : c.title}',
            '{(c as { isSelf?: boolean }).isSelf || c.title === "You" || c.title.includes("(You)") ? (c.title.includes("(You)") ? c.title : "You") : c.title}',
            1,
        )
        # Add pin icon next to time
        if "d4IsPinned(c.id)" not in t:
            t = t.replace(
                '<span className="shrink-0 text-[11px] text-slate-400">\n                  {formatListTime(c.time)}\n                </span>',
                '<span className="flex shrink-0 items-center gap-1 text-[11px] text-slate-400">\n                  {d4IsPinned(c.id) ? <Pin className="h-3 w-3 text-slate-500" /> : null}\n                  {formatListTime(c.time)}\n                </span>',
                1,
            )

    # Title h1 when showArchived
    t = t.replace(
        ">\n              D4Chat\n            </h1>",
        ">\n              {showArchived ? "Archived" : "D4Chat"}\n            </h1>",
        1,
    )

    if t == orig:
        print("NO_CHANGE")
        return
    HUB.write_text(t, encoding="utf-8")
    print("OK", len(t))

if __name__ == "__main__":
    main()
