/**
 * The offline queue for photo evidence.
 *
 * The courier photographs a garment in a stairwell, where there is no network. The scans of the
 * route were already queued offline (`apps/web/src/offline.ts`), but a photo used to be lost: the
 * uploader only knew how to talk to the server. A queued photo keeps the bytes in IndexedDB and
 * uploads them as soon as the connection is back, so the intake proof survives the walk home.
 */

const DB_NAME = "laundry_evidence_queue";
const STORE = "evidence";
const DB_VERSION = 1;

export type QueuedEvidence = {
  /** Client-side id; the key of the record. */
  id: string;
  ownerType: string;
  ownerId: string;
  purpose: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** The bytes themselves. */
  blob: Blob;
  createdAt: string;
  attempts: number;
  lastError?: string | null;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("EVIDENCE_QUEUE_BLOCKED"));
  });
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Is the browser able to keep a queue at all? Private modes may refuse IndexedDB. */
export function evidenceQueueAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function enqueueEvidence(entry: Omit<QueuedEvidence, "id" | "createdAt" | "attempts">): Promise<QueuedEvidence> {
  const record: QueuedEvidence = {
    ...entry,
    id: newId(),
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
  return record;
}

export async function queuedEvidence(ownerType?: string, ownerId?: string): Promise<QueuedEvidence[]> {
  if (!evidenceQueueAvailable()) return [];
  const db = await openDb();
  const rows = await new Promise<QueuedEvidence[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as QueuedEvidence[]) ?? []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  const filtered = rows
    .filter(row => (ownerType ? row.ownerType === ownerType : true))
    .filter(row => (ownerId ? row.ownerId === ownerId : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return filtered;
}

export async function removeQueuedEvidence(ids: string[]): Promise<void> {
  if (!ids.length || !evidenceQueueAvailable()) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const id of ids) tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function markEvidenceAttempt(id: string, error: string | null): Promise<void> {
  if (!evidenceQueueAvailable()) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as QueuedEvidence | undefined;
      if (record) {
        store.put({ ...record, attempts: record.attempts + 1, lastError: error });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Test helper: drops every queued photo. */
export async function resetEvidenceQueue(): Promise<void> {
  if (!evidenceQueueAvailable()) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
