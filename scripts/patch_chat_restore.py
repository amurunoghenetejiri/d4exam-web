import urllib.request, pathlib
url = "https://raw.githubusercontent.com/amurunoghenetejiri/d4exam-web/ffaf36c0109c29a9c0807728d1a3f022005eb780/src/routes/student.messages.%24conversationId.tsx"
text = urllib.request.urlopen(url, timeout=60).read().decode("utf-8")
assert "ConversationChat" in text

replacements = []

replacements.append((
"""            await sendCampusMessage({
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
          }""",
"""            const sent = await sendCampusMessage({
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
                replyToId: replyId || undefined,
              });
            } catch { /* ignore */ }
            toast.error(friendlySendErr(e) || \"Voice note could not send — will retry\");
          }"""
))

print("use local script file")
