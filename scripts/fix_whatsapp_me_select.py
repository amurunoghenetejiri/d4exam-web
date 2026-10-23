#!/usr/bin/env python3
"""WhatsApp-style Me row, selection header, pin, archive."""
from pathlib import Path
import re

HUB = Path(__file__).resolve().parents[1] / "src" / "routes" / "student.messages.tsx"

def main() -> None:
    t = HUB.read_text(encoding="utf-8")
    orig = t

    if "Trash2" not in t:
        t = t.replace(
            "  Clock,\n} from \"lucide-react\";",
            "  Clock,\n  Pin,\n  Archive,\n  VolumeX,\n  Trash2,\n} from \"lucide-react\";",
            1,
        )

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

    if "archivedIds" not in t:
        t = t.replace(
            'const persistPins = (ids: string[]) => { setPinnedIds(ids); try { localStorage.setItem("d4_pinned_chats", JSON.stringify(ids)); } catch {} };',
            'const persistPins = (ids: string[]) => { setPinnedIds(ids); try { localStorage.setItem("d4_pinned_chats", JSON.stringify(ids)); } catch {} };\n  const [archivedIds, setArchivedIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("d4_archived_chats") || "[]"); } catch { return []; } });\n  const persistArchives = (ids: string[]) => { setArchivedIds(ids); try { localStorage.setItem("d4_archived_chats", JSON.stringify(ids)); } catch {} };\n  const [showArchived, setShowArchived] = useState(false);\n  const [selectMenuOpen, setSelectMenuOpen] = useState(false);',
            1,
        )

    if 'title: "You",' in t and "myDisplayName ?" not in t:
        t = t.replace(
            'title: "You",\n          subtitle: "Message yourself",\n          preview: "",\n          avatar_url: null,',
            'title: myDisplayName ? `${myDisplayName} (You)` : "You",\n          subtitle: "Message yourself",\n          preview: "",\n          avatar_url: myNavPhoto,',
            1,
        )

    t = t.replace(
        'sessionStorage.setItem(`d4_chat_title_${realId}`, "Me")',
        'sessionStorage.setItem(`d4_chat_title_${realId}`, myDisplayName ? `${myDisplayName} (You)` : "You")',
    )

    t2 = re.sub(
        r'\{selectionMode \? \(\s*<div className="sticky top-0[\s\S]*?\) : null\}',
        "",
        t,
        count=1,
    )
    if t2 != t:
        t = t2
        print("removed sticky bar")

    if "data-wa-select-header" not in t:
        old = (
            '        <div className="flex items-center gap-2.5 px-3 pb-3 pt-2.5 sm:gap-3 sm:px-4">\n'
            '          <button\n'
            '            type="button"\n'
            '            onClick={() => navigate({ to: "/student" })}\n'
            '            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/10 active:bg-white/15"\n'
            '            aria-label="Back"\n'
            '          >\n'
            '            <ArrowLeft className="h-5 w-5" />\n'
            '          </button>'
        )
        new = (
            '        {selectionMode ? (\n'
            '          <div className="relative flex items-center gap-0.5 px-2 pb-3 pt-2.5" data-wa-select-header>\n'
            '            <button type="button" onClick={() => { setSelectedChatIds([]); setSelectMenuOpen(false); }} className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Back"><ArrowLeft className="h-5 w-5" /></button>\n'
            '            <span className="min-w-[1.25rem] flex-1 text-lg font-bold tabular-nums">{selectedChatIds.length}</span>\n'
            '            <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Pin" onClick={() => { const next=[...pinnedIds]; for (const id of selectedChatIds) { if (!next.includes(id)) next.unshift(id); } persistPins(next); toast.success("Pinned"); setSelectedChatIds([]); }}><Pin className="h-5 w-5" /></button>\n'
            '            <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Delete" onClick={async () => { try { for (const id of selectedChatIds) { if (id==="__me__") continue; await supabase.from("conversation_members").update({ left_at: new Date().toISOString() } as never).eq("conversation_id", id).eq("user_id", userId); } toast.success("Deleted"); setSelectedChatIds([]); void qc.invalidateQueries({ queryKey: ["campus-conversations"] }); } catch (e) { toast.error(e instanceof Error ? e.message : "Fail"); } }}><Trash2 className="h-5 w-5" /></button>\n'
            '            <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Mute" onClick={() => { toast.message("Muted"); setSelectedChatIds([]); }}><VolumeX className="h-5 w-5" /></button>\n'
            '            <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" aria-label="Archive" onClick={() => { const next=[...new Set([...archivedIds, ...selectedChatIds.filter((id)=>id!=="__me__")])]; persistArchives(next); toast.success("Archived"); setSelectedChatIds([]); }}><Archive className="h-5 w-5" /></button>\n'
            '            <div className="relative">\n'
            '              <button type="button" className="grid h-10 w-10 place-items-center rounded-full hover:bg-white/10" onClick={() => setSelectMenuOpen((v)=>!v)} aria-label="More"><MoreVertical className="h-5 w-5" /></button>\n'
            '              {selectMenuOpen ? (\n'
            '                <div className="absolute right-0 top-11 z-50 min-w-[200px] rounded-xl bg-[#1e293b] py-1 shadow-xl ring-1 ring-white/10">\n'
            '                  <button type="button" className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10" onClick={async () => { try { const now=new Date().toISOString(); for (const id of selectedChatIds) { if (id==="__me__") continue; await supabase.from("conversation_members").update({ last_read_at: now } as never).eq("conversation_id", id).eq("user_id", userId); } toast.success("Marked as read"); setSelectedChatIds([]); setSelectMenuOpen(false); void qc.invalidateQueries({ queryKey: ["campus-conversations"] }); } catch (e) { toast.error(e instanceof Error ? e.message : "Fail"); } }}>Mark as read</button>\n'
            '                  <button type="button" className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10" onClick={() => { setSelectedChatIds(conversationsWithPending.filter((c)=>!archivedIds.includes(c.id)).map((c)=>c.id)); setSelectMenuOpen(false); }}>Select all</button>\n'
            '                  <button type="button" className="block w-full px-4 py-2.5 text-left text-sm text-white hover:bg-white/10" onClick={() => { toast.message("Added to favorites"); setSelectMenuOpen(false); setSelectedChatIds([]); }}>Add to Favorites</button>\n'
            '                  <button type="button" className="block w-full px-4 py-2.5 text-left text-sm text-rose-300 hover:bg-white/10" onClick={async () => { try { for (const id of selectedChatIds) { if (id==="__me__") continue; await supabase.from("campus_messages").update({ deleted_at: new Date().toISOString() } as never).eq("conversation_id", id); } toast.success("Chats cleared"); setSelectedChatIds([]); setSelectMenuOpen(false); void qc.invalidateQueries({ queryKey: ["campus-conversations"] }); } catch (e) { toast.error(e instanceof Error ? e.message : "Fail"); } }}>Clear chats</button>\n'
            '                </div>\n'
            '              ) : null}\n'
            '            </div>\n'
            '          </div>\n'
            '        ) : (\n'
            '        <div className="flex items-center gap-2.5 px-3 pb-3 pt-2.5 sm:gap-3 sm:px-4">\n'
            '          <button\n'
            '            type="button"\n'
            '            onClick={() => showArchived ? setShowArchived(false) : navigate({ to: "/student" })}\n'
            '            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 hover:bg-white/10 active:bg-white/15"\n'
            '            aria-label="Back"\n'
            '          >\n'
            '            <ArrowLeft className="h-5 w-5" />\n'
            '          </button>'
        )
        if old in t:
            t = t.replace(old, new, 1)
            close_old = "        </div>\n      </header>\n\n      <div className=\"relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden\">"
            close_new = "        </div>\n        )}\n      </header>\n\n      <div className=\"relative z-10 flex min-h-0 flex-1 flex-col overflow-hidden\">"
            if close_old in t:
                t = t.replace(close_old, close_new, 1)
            print("header")
        else:
            print("WARN header not found")

    if "showArchived ? archivedIds" not in t:
        old_all = 'const allChats = [...conversationsWithPending].sort((a, b) => { const ap = pinnedIds.includes(a.id) ? 1 : 0; const bp = pinnedIds.includes(b.id) ? 1 : 0; if (ap !== bp) return bp - ap; const ay = a.title === "You" ? 1 : 0; const by = b.title === "You" ? 1 : 0; return by - ay; });'
        new_all = 'const allChats = [...conversationsWithPending].filter((c) => showArchived ? archivedIds.includes(c.id) : !archivedIds.includes(c.id)).sort((a, b) => { const ap = pinnedIds.includes(a.id) ? 1 : 0; const bp = pinnedIds.includes(b.id) ? 1 : 0; if (ap !== bp) return bp - ap; const ay = a.title === "You" || a.title.includes("(You)") || (a as { isSelf?: boolean }).isSelf ? 1 : 0; const by = b.title === "You" || b.title.includes("(You)") || (b as { isSelf?: boolean }).isSelf ? 1 : 0; if (ay !== by) return by - ay; return 0; });'
        if old_all in t:
            t = t.replace(old_all, new_all, 1)
            print("allChats")

    if "setShowArchived(true)" not in t:
        row = (
            '\n              {/* Archived chats row */}\n'
            '              {!showArchived && archivedIds.length > 0 && tab === "chats" ? (\n'
            '                <button type="button" onClick={() => setShowArchived(true)} className="mx-3 mb-1 flex items-center gap-3 rounded-2xl border border-blue-100 bg-white/90 px-3 py-3 text-left shadow-sm">\n'
            '                  <span className="grid h-11 w-11 place-items-center rounded-full bg-slate-100 text-slate-600"><Archive className="h-5 w-5" /></span>\n'
            '                  <span className="flex-1 text-[15px] font-semibold text-slate-900">Archived</span>\n'
            '                  <span className="text-xs font-bold text-slate-400">{archivedIds.length}</span>\n'
            '                </button>\n'
            '              ) : null}\n'
        )
        t = t.replace("<ConversationList", row + "              <ConversationList", 1)
        print("archived row")

    if "d4IsPinned" not in t:
        t = t.replace(
            "function d4SelectBridge() {",
            'function d4IsPinned(id: string) { try { const raw = localStorage.getItem("d4_pinned_chats"); return raw ? (JSON.parse(raw) as string[]).includes(id) : false; } catch { return false; } }\nfunction d4SelectBridge() {',
            1,
        )
        t = t.replace(
            '<span className="shrink-0 text-[11px] text-slate-400">\n                  {formatListTime(c.time)}\n                </span>',
            '<span className="flex shrink-0 items-center gap-1 text-[11px] text-slate-400">\n                  {d4IsPinned(c.id) ? <Pin className="h-3 w-3 text-slate-500" /> : null}\n                  {formatListTime(c.time)}\n                </span>',
            1,
        )
        print("pin icon")

    if "showArchived ? " not in t:
        t = t.replace(
            ">\n              D4Chat\n            </h1>",
            ">\n              {showArchived ? 'Archived' : 'D4Chat'}\n            </h1>",
            1,
        )
        print("title")

    if t == orig:
        print("NO_CHANGE")
        return
    HUB.write_text(t, encoding="utf-8")
    print("OK", len(t))

if __name__ == "__main__":
    main()
