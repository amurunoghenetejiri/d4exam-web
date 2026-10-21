from pathlib import Path

def rep(path, old, new, label):
    p = Path(path)
    t = p.read_text()
    if old not in t:
        print("MISS", label)
        return False
    p.write_text(t.replace(old, new, 1))
    print("OK", label)
    return True

# 1 messaging touchConversation on RPC
rep(
"src/lib/messaging.ts",
"""    if (!rpcErr && rpcMsg) {
      const msg = (Array.isArray(rpcMsg) ? rpcMsg[0] : rpcMsg) as CampusMessage;
      if (!msg?.id) {
        console.warn("[sendCampusMessage] rpc returned no id", rpcMsg);
      } else {
      const preview = previewFromMessage(row);
      void notifyMessageRecipients({
        conversationId: opts.conversationId,
        senderId: opts.senderId,
        preview,
        attachmentType: opts.attachmentType || null,
        messageId: msg.id,
      });
      return msg;
      }
    }""",
"""    if (!rpcErr && rpcMsg) {
      const msg = (Array.isArray(rpcMsg) ? rpcMsg[0] : rpcMsg) as CampusMessage;
      if (!msg?.id) {
        console.warn("[sendCampusMessage] rpc returned no id", rpcMsg);
      } else {
      const preview = previewFromMessage(row);
      // Always update conversation preview so direct chats appear in Recent
      void touchConversation(opts.conversationId, opts.senderId, preview);
      void notifyMessageRecipients({
        conversationId: opts.conversationId,
        senderId: opts.senderId,
        preview,
        attachmentType: opts.attachmentType || null,
        messageId: msg.id,
      });
      return msg;
      }
    }""",
"touch-rpc",
)

rep(
"src/lib/messaging.ts",
"""  // Chats list: hide empty direct threads (opened but never messaged).
  // Groups still appear so members can open and start chatting.
  return mapped.filter((c) => c.isGroup || c.hasMessage);
}""",
"""  // Show groups always; direct chats when they have a message, unread, or preview.
  return mapped.filter(
    (c) => c.isGroup || c.hasMessage || c.unread > 0 || Boolean(c.lastSenderId),
  );
}""",
"list-filter",
)

# 2 list UI ticks
rep(
"src/routes/student.messages.tsx",
"""              <div className=\"mt-0.5 flex items-center gap-1.5\">
                {(c as { pendingSend?: boolean }).pendingSend ? (
                  <Clock className=\"h-3.5 w-3.5 shrink-0 text-slate-400\" aria-label=\"Pending\" />
                ) : null}
                {(() => {
                  const p = c.preview || \"\";
""",
"""              <div className=\"mt-0.5 flex items-center gap-1.5\">
                {(() => {
                  const p = c.preview || \"\";
""",
"left-clock",
)

rep(
"src/routes/student.messages.tsx",
"""                {c.unread > 0 ? (
                  <span className=\"ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[#2563eb] px-1.5 text-[11px] font-bold text-white\">
                    {c.unread > 99 ? \"99+\" : c.unread}
                  </span>
                ) : c.preview ? (
                  <CheckCheck className=\"ml-auto h-3.5 w-3.5 shrink-0 text-[#2563eb]/70\" />
                ) : null}
""",
"""                {c.unread > 0 ? (
                  <span className=\"ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[#2563eb] px-1.5 text-[11px] font-bold text-white\">
                    {c.unread > 99 ? \"99+\" : c.unread}
                  </span>
                ) : (c as { pendingSend?: boolean }).pendingSend ? (
                  <Clock className=\"ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-[#2563eb]\" aria-label=\"Sending\" style={{ animationDuration: \"1.1s\" }} />
                ) : c.preview && c.lastSenderId && myId && c.lastSenderId === myId ? (
                  <CheckCheck className=\"ml-auto h-3.5 w-3.5 shrink-0 text-[#2563eb]/70\" aria-label=\"Sent\" />
                ) : null}
""",
"right-ticks",
)

print("partial - use full script file")
