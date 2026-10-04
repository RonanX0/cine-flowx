import type { QueueItem } from "./types";

const DB_NAME = "cineclip_scheduler_db";
const DB_VERSION = 1;
const STORE = "reels_queue";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadQueue(): Promise<QueueItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => {
      const items = (req.result || []) as QueueItem[];
      items.forEach((p) => {
        p.accountId = p.accountId || "acc_default";
      });
      items.sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveQueueItem(item: QueueItem): Promise<void> {
  const db = await openDb();
  const ts = item.scheduledAt ? new Date(item.scheduledAt).getTime() : NaN;
  const record = {
    ...item,
    accountId: item.accountId || "acc_default",
    scheduledTimestamp: Number.isFinite(ts) ? ts : item.scheduledTimestamp,
    updatedAt: item.updatedAt || Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteQueueItem(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Próximo horário livre (YYYY-MM-DDTHH:MM) a partir dos horários diários da conta. */
export function nextFreeSlot(
  queue: QueueItem[],
  dailySlots: string[],
  accountId?: string
): string {
  const slots = dailySlots.length > 0 ? [...dailySlots].sort() : ["12:00", "18:00", "21:30"];
  const taken = new Set(
    queue
      .filter(
        (p) =>
          (!accountId || (p.accountId || "acc_default") === accountId) &&
          (p.status === "scheduled" || p.status === "queued" || p.status === "device_scheduled")
      )
      .map((p) => (p.scheduledAt || "").slice(0, 16))
  );
  const now = new Date();
  const min = new Date(now.getTime() + 10 * 60 * 1000);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  for (let day = 0; day < 60; day++) {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day);
    for (const slot of slots) {
      const [h, m] = slot.split(":").map((k) => Number(k) || 0);
      const when = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0);
      if (when <= min) continue;
      const key = fmt(when);
      if (!taken.has(key)) return key;
    }
  }
  return fmt(new Date(now.getTime() + 3600 * 1000));
}

/** Reorganiza a fila: redistribui os agendados pelos próximos horários livres. */
export function redistributeSlots(queue: QueueItem[], dailySlots: string[]): QueueItem[] {
  const pend = queue
    .filter((p) => p.status === "scheduled" || p.status === "queued" || p.status === "device_scheduled")
    .sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
  const done = queue.filter((p) => !pend.includes(p));
  const out: QueueItem[] = [...done];
  const taken: string[] = [];
  for (const item of pend) {
    let slot = nextFreeSlot(
      [...out, ...taken.map((s) => ({ scheduledAt: s, status: "scheduled" } as QueueItem))],
      dailySlots,
      item.accountId
    );
    // garante que não colide com os já atribuídos nesta passada
    while (taken.includes(slot)) {
      const d = new Date(slot);
      d.setMinutes(d.getMinutes() + 1);
      slot = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    taken.push(slot);
    out.push({ ...item, scheduledAt: slot, updatedAt: Date.now() });
  }
  out.sort((a, b) => (a.scheduledAt || "").localeCompare(b.scheduledAt || ""));
  return out;
}
