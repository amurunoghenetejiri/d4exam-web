
from pathlib import Path
p = Path("src/routes/student.messages.$conversationId.tsx")
t = p.read_text()
changed = 0

old_voice = """            const up = await uploadMessageMedia(
              blob,
              \"audio/webm\",
              `campus/${conversationId}`,
            );
            await sendCampusMessage({
              conversationId,
              senderId: userId,
              attachmentUrl: up.url,
              attachmentType: \"audio\",
              clientId,
              durationSec,
              replyToId: replyId,
            });
            void qc.invalidateQueries({
              queryKey: [\"campus-messages\", conversationId],
            });
          } catch (e) {
            toast.error(\"Voice note could not send — try again\");
          }"""

new_voice = """            const up = await uploadMessageMedia(
              blob,
              blob.type || \"audio/webm\",
              `campus/${conversationId}`,
            );
            const sent = await sendCampusMessage({
              conversationId,
              senderId: userId,
              attachmentUrl: up.url,
              attachmentType: \"audio\",
              clientId,
              durationSec,
              replyToId: replyId,
            });
            setOptimistic((prev) => prev.filter((m) => m.client_id !== clientId && m.id !== clientId));
            if (sent?.id) {
              qc.setQueryData(
                [\"campus-messages\", conversationId],
                (old) => {
                  const list = Array.isArray(old) ? old.slice() : [];
                  const idx = list.findIndex(
                    (m) => m.id === sent.id || m.client_id === clientId || m.id === clientId,
                  );
                  if (idx >= 0) list[idx] = sent;
                  else list.push(sent);
                  return list.sort(
                    (a, b) =>
                      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
                  );
                },
              );
            }
            void qc.invalidateQueries({ queryKey: [\"campus-conversations\"] });
          } catch (e) {
            try {
              const { blobToDataUrlIfSmall } = await import(\"@/lib/message-outbox\");
              const dataUrl = await blobToDataUrlIfSmall(blob);
              if (dataUrl) {
                enqueueOutbox({
                  clientId,
                  kind: \"campus_audio\",
                  text: \"\",
                  mediaType: \"audio\",
                  blobDataUrl: dataUrl,
                  role: \"student\",
                  userId,
                  conversationId,
                  durationSec,
                });
                toast.message(\"Voice queued — will retry\");
              } else {
                toast.error(\"Voice note could not send — try again\");
              }
            } catch {
              toast.error(\"Voice note could not send — try again\");
            }
          }"""

if old_voice in t:
    t = t.replace(old_voice, new_voice, 1)
    changed += 1
    print("voice ok")
else:
    print("voice miss")

old_file = """      const up = await uploadMessageMedia(file, kind, `campus/${conversationId}`);
      await sendCampusMessage({
        conversationId,
        senderId: userId,
        attachmentUrl: up.url,
        attachmentType:
          up.type === \"image\" ? \"image\" : up.type === \"audio\" ? \"audio\" : attType,
        clientId,
        replyToId: replyId,
      });
      void qc.invalidateQueries({ queryKey: [\"campus-messages\", conversationId] });
    } catch (e) {
      toast.error(\"Upload failed — try a smaller file\");
    }"""

new_file = """      const up = await uploadMessageMedia(file, kind, `campus/${conversationId}`);
      const sent = await sendCampusMessage({
        conversationId,
        senderId: userId,
        attachmentUrl: up.url,
        attachmentType:
          up.type === \"image\" ? \"image\" : up.type === \"audio\" ? \"audio\" : attType,
        clientId,
        replyToId: replyId,
      });
      setOptimistic((prev) => prev.filter((m) => m.client_id !== clientId && m.id !== clientId));
      if (sent?.id) {
        qc.setQueryData(
          [\"campus-messages\", conversationId],
          (old) => {
            const list = Array.isArray(old) ? old.slice() : [];
            const idx = list.findIndex(
              (m) => m.id === sent.id || m.client_id === clientId || m.id === clientId,
            );
            if (idx >= 0) list[idx] = sent;
            else list.push(sent);
            return list.sort(
              (a, b) =>
                new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
            );
          },
        );
      }
      void qc.invalidateQueries({ queryKey: [\"campus-conversations\"] });
    } catch (e) {
      try {
        const { blobToDataUrlIfSmall } = await import(\"@/lib/message-outbox\");
        const dataUrl = await blobToDataUrlIfSmall(file);
        if (dataUrl) {
          enqueueOutbox({
            clientId,
            kind: \"campus_media\",
            text: \"\",
            mediaType: attType,
            blobDataUrl: dataUrl,
            role: \"student\",
            userId: userId,
            conversationId,
          });
          toast.message(\"Attachment queued — will retry\");
        } else {
          toast.error(\"Upload failed — try a smaller file\");
        }
      } catch {
        toast.error(\"Upload failed — try a smaller file\");
      }
    }"""

if old_file in t:
    t = t.replace(old_file, new_file, 1)
    changed += 1
    print("file ok")
else:
    print("file miss")

old_flush = """          await sendCampusMessage({
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
          markOutboxFailed(item.clientId, e instanceof Error ? e.message : \"fail\");
        }
      }
      void qc.invalidateQueries({ queryKey: [\"campus-messages\", conversationId] });"""

new_flush = """          const sent = await sendCampusMessage({
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
            qc.setQueryData(
              [\"campus-messages\", conversationId],
              (old) => {
                const list = Array.isArray(old) ? old.slice() : [];
                const idx = list.findIndex(
                  (m) =>
                    m.id === sent.id ||
                    m.client_id === item.clientId ||
                    m.id === item.clientId,
                );
                if (idx >= 0) list[idx] = sent;
                else list.push(sent);
                return list.sort(
                  (a, b) =>
                    new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
                );
              },
            );
          }
        } catch (e) {
          markOutboxFailed(item.clientId, e instanceof Error ? e.message : \"fail\");
        }
      }
      void qc.invalidateQueries({ queryKey: [\"campus-conversations\"] });"""

if old_flush in t:
    t = t.replace(old_flush, new_flush, 1)
    changed += 1
    print("flush ok")
else:
    print("flush miss")

old_merged = """    const merged = useMemo(() => {
    const byClient = new Set(
      serverMsgs.map((m) => m.client_id).filter(Boolean) as string[],
    );
    const pending = optimistic.filter(
      (o) => o.client_id && !byClient.has(o.client_id),
    );
    return [...serverMsgs, ...pending].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }, [serverMsgs, optimistic]);"""

new_merged = """    const merged = useMemo(() => {
    const byClient = new Set(
      serverMsgs.map((m) => m.client_id).filter(Boolean) as string[],
    );
    const byId = new Set(serverMsgs.map((m) => m.id).filter(Boolean));
    const pending = optimistic.filter((o) => {
      if (!o.client_id) return false;
      if (byClient.has(o.client_id)) return false;
      if (byId.has(o.client_id)) return false;
      return true;
    });
    return [...serverMsgs, ...pending].sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }, [serverMsgs, optimistic]);"""

if old_merged in t:
    t = t.replace(old_merged, new_merged, 1)
    changed += 1
    print("merged ok")
else:
    print("merged miss")

p.write_text(t)
print("changed", changed)
