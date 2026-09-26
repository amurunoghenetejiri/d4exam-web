export type OutboxItem = {
  clientId: string;
  kind: string;
  text: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
  blobDataUrl?: string | null;
  replyToId?: string | null;
  createdAt: number;
  retries: number;
  status: "queued" | "uploading" | "failed";
  role: "student" | "officer";
  schoolId?: string | null;
  studentId?: string | null;
  userId?: string | null;
  error?: string | null;
};

const KEY = "d4exam.msg.outbox.v1";
const MAX_BLOB = 900000;
const MAX_RETRIES = 8;
const listeners = new Set<() => void>();

function readAll(): OutboxItem[] {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function writeAll(items: OutboxItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(-80)));
  } catch { /* quota */ }
  listeners.forEach((cb) => { try { cb(); } catch { } });
}

export function subscribeOutbox(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function notifyOutbox() {
  listeners.forEach((cb) => { try { cb(); } catch { } });
}

export function listOutbox(role?: "student" | "officer") {
  const all = readAll();
  return role ? all.filter((x) => x.role === role) : all;
}

export function enqueueOutbox(
  item: Omit<OutboxItem, "retries" | "status" | "createdAt"> & { createdAt?: number },
): OutboxItem {
  const full: OutboxItem = { ...item, createdAt: item.createdAt ?? Date.now(), retries: 0, status: "queued" };
  writeAll(readAll().filter((x) => x.clientId !== full.clientId).concat([full]));
  return full;
}

export function removeOutbox(clientId: string) {
  writeAll(readAll().filter((x) => x.clientId !== clientId));
}

export function markOutboxFailed(clientId: string, error?: string) {
  writeAll(readAll().map((x) => x.clientId === clientId ? { ...x, status: "failed" as const, retries: x.retries + 1, error: error || x.error } : x));
}

export function markOutboxUploading(clientId: string) {
  writeAll(readAll().map((x) => (x.clientId === clientId ? { ...x, status: "uploading" as const } : x)));
}

export function canRetry(item: OutboxItem) { return item.retries < MAX_RETRIES; }

export async function blobToDataUrlIfSmall(blob: Blob): Promise<string | null> {
  if (blob.size > MAX_BLOB) return null;
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || "") || null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const [meta, b64] = dataUrl.split(",");
    const mime = /data:([^;]+)/.exec(meta)?.[1] || "application/octet-stream";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch { return null; }
}
