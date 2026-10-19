import pathlib, urllib.request
url = "https://raw.githubusercontent.com/amurunoghenetejiri/d4exam-web/main/src/routes/student.messages.%24conversationId.tsx"
text = urllib.request.urlopen(url, timeout=90).read().decode("utf-8")
if "PLACEHOLDER" in text and len(text) < 100:
    url = "https://raw.githubusercontent.com/amurunoghenetejiri/d4exam-web/ffaf36c0109c29a9c0807728d1a3f022005eb780/src/routes/student.messages.%24conversationId.tsx"
    text = urllib.request.urlopen(url, timeout=90).read().decode("utf-8")
assert "ConversationChat" in text and len(text) > 50000

def rep(old, new, label):
    global text
    if old not in text:
        print("skip", label)
        return False
    text = text.replace(old, new, 1)
    print("ok", label)
    return True

rep(
"""            const up = await uploadMessageMedia(
              blob,
              "audio/webm",
              `campus/${conversationId}`,
            );
            await sendCampusMessage({
              conversationId,
              senderId: userId,
              attachmentUrl: up.url,
              attachmentType: "audio",
              clientId,
              durationSec,
              replyToId: replyId,
            });
            void qc.invalidateQueries({
              queryKey: ["campus-messages", conversationId],
            });
          } catch (e) {
            toast.error("Voice note could not send — try again");
          }""",
"""            const up = await uploadMessageMedia(
              blob,
              blob.type || "audio/webm",
              `campus/${conversationId}`,
            );
            const sent = await sendCampusMessage({
              conversationId,
              senderId: userId,
              attachmentUrl: up.url,
              attachmentType: "audio",
              clientId,
              durationSec,
              replyToId: replyId,
            });
            setOptimistic((prev) => prev.filter((m) => m.client_id !== clientId && m.id !== clientId));
            if (sent?.id) {
              qc.setQueryData(["campus-messages", conversationId], (old) => {
                const list = Array.isArray(old) ? old.slice() : [];
                const idx = list.findIndex(
                  (m) => m.id === sent.id || m.client_id === clientId || m.id === clientId,
                );
                if (idx >= 0) list[idx] = sent;
                else list.push(sent);
                return list.sort(
                  (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
                );
              });
            }
            void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
          } catch (e) {
            try {
              const { blobToDataUrlIfSmall } = await import("@/lib/message-outbox");
              const dataUrl = await blobToDataUrlIfSmall(blob);
              enqueueOutbox({
                clientId,
                kind: "campus_audio",
                text: "",
                mediaType: "audio",
                blobDataUrl: dataUrl,
                role: "student",
                userId,
                conversationId,
                durationSec,
                replyToId: replyId || undefined,
              });
            } catch { /* ignore */ }
            toast.error(friendlySendErr(e) || "Voice note could not send — will retry");
          }""",
"voice",
)

rep(
"""      const up = await uploadMessageMedia(file, kind, `campus/${conversationId}`);
      await sendCampusMessage({
        conversationId,
        senderId: userId,
        attachmentUrl: up.url,
        attachmentType:
          up.type === "image" ? "image" : up.type === "audio" ? "audio" : attType,
        clientId,
        replyToId: replyId,
      });
      void qc.invalidateQueries({ queryKey: ["campus-messages", conversationId] });
    } catch (e) {
      toast.error("Upload failed — try a smaller file");
    }""",
"""      const up = await uploadMessageMedia(file, kind, `campus/${conversationId}`);
      const sent = await sendCampusMessage({
        conversationId,
        senderId: userId,
        attachmentUrl: up.url,
        attachmentType:
          up.type === "image" ? "image" : up.type === "audio" ? "audio" : attType,
        clientId,
        replyToId: replyId,
      });
      setOptimistic((prev) => prev.filter((m) => m.client_id !== clientId && m.id !== clientId));
      if (sent?.id) {
        qc.setQueryData(["campus-messages", conversationId], (old) => {
          const list = Array.isArray(old) ? old.slice() : [];
          const idx = list.findIndex(
            (m) => m.id === sent.id || m.client_id === clientId || m.id === clientId,
          );
          if (idx >= 0) list[idx] = sent;
          else list.push(sent);
          return list.sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
          );
        });
      }
      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });
    } catch (e) {
      try {
        const { blobToDataUrlIfSmall } = await import("@/lib/message-outbox");
        const dataUrl = await blobToDataUrlIfSmall(file);
        enqueueOutbox({
          clientId,
          kind: "campus_media",
          text: "",
          mediaType: attType,
          blobDataUrl: dataUrl,
          role: "student",
          userId,
          conversationId,
          replyToId: replyId || undefined,
        });
      } catch { /* ignore */ }
      toast.error(friendlySendErr(e) || "Upload failed — will retry");
    }""",
"file",
)

rep(
"""          await sendCampusMessage({
            conversationId,
            senderId: userId,
            body: item.text || null,
            attachmentUrl: mediaUrl,
            attachmentType: item.mediaType || null,
            clientId: item.clientId,
            durationSec: item.durationSec ?? null,
            forwardedFromId: item.forwardedFromId || null,
            replyToId: item.replyToId || null,
          });
          removeOutbox(item.clientId);
        } catch (e) {
          markOutboxFailed(item.clientId, e instanceof Error ? e.message : "fail");
        }
      }
      void qc.invalidateQueries({ queryKey: ["campus-messages", conversationId] });""",
"""          const sent = await sendCampusMessage({
            conversationId,
            senderId: userId,
            body: item.text || null,
            attachmentUrl: mediaUrl,
            attachmentType: item.mediaType || null,
            clientId: item.clientId,
            durationSec: item.durationSec ?? null,
            forwardedFromId: item.forwardedFromId || null,
            replyToId: item.replyToId || null,
          });
          removeOutbox(item.clientId);
          setOptimistic((prev) =>
            prev.filter((m) => m.client_id !== item.clientId && m.id !== item.clientId),
          );
          if (sent?.id) {
            qc.setQueryData(["campus-messages", conversationId], (old) => {
              const list = Array.isArray(old) ? old.slice() : [];
              const idx = list.findIndex(
                (m) => m.id === sent.id || m.client_id === item.clientId || m.id === item.clientId,
              );
              if (idx >= 0) list[idx] = sent;
              else list.push(sent);
              return list.sort(
                (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
              );
            });
          }
        } catch (e) {
          markOutboxFailed(item.clientId, e instanceof Error ? e.message : "fail");
        }
      }
      void qc.invalidateQueries({ queryKey: ["campus-conversations"] });""",
"flush",
)

rep(
"""                        tick === "pending" ? (
                          <Clock className="h-3 w-3 shrink-0 animate-spin text-[#2563eb] opacity-90" style={{ animationDuration: "1.1s" }} />
                        ) : tick === "sent" ? (
                          <Check className="h-3 w-3 shrink-0 opacity-70" />
                        ) : tick === "delivered" ? (
                          <CheckCheck className="h-3 w-3 shrink-0 opacity-70" />
                        ) : tick === "read" ? (
                          <CheckCheck className="h-3 w-3 shrink-0 text-[#53bdeb]" />
                        ) : null""",
"""                        tick === "pending" ? (
                          <Clock
                            className="h-3.5 w-3.5 shrink-0 animate-spin text-[#2563eb]"
                            style={{
                              animationDuration: "0.9s",
                              filter: "drop-shadow(0 0 3px rgba(37,99,235,0.95))",
                            }}
                          />
                        ) : tick === "sent" ? (
                          <Check className="h-3 w-3 shrink-0 opacity-80 transition-opacity duration-300" />
                        ) : tick === "delivered" ? (
                          <CheckCheck className="h-3 w-3 shrink-0 opacity-80 transition-opacity duration-300" />
                        ) : tick === "read" ? (
                          <CheckCheck className="h-3 w-3 shrink-0 text-[#53bdeb] transition-colors duration-300" />
                        ) : null""",
"clock",
)

needle = """  }, [serverMsgs, optimistic]);

  const scrollToEnd = useCallback((smooth = true) => {"""
inject = """  }, [serverMsgs, optimistic]);

  // Clear optimistic + outbox when server has matching client_id (stops infinite clock)
  useEffect(() => {
    const clients = new Set(
      (serverMsgs || []).map((m) => m.client_id).filter(Boolean) as string[],
    );
    if (!clients.size) return;
    setOptimistic((prev) => {
      const next = prev.filter((o) => !o.client_id || !clients.has(o.client_id));
      return next.length === prev.length ? prev : next;
    });
    try {
      for (const cid of clients) removeOutbox(cid);
    } catch { /* ignore */ }
  }, [serverMsgs]);

  const scrollToEnd = useCallback((smooth = true) => {"""
if "Clear optimistic + outbox when server" not in text:
    if needle in text:
        text = text.replace(needle, inject, 1)
        print("ok inject-clear")
    else:
        print("skip inject-clear")
else:
    print("skip inject-clear already")

out = pathlib.Path("src/routes/student.messages.$conversationId.tsx")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text)
print("wrote", out, len(text))
