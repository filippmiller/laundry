/**
 * Durable courier scan queue. Scans are written to IndexedDB before any network call, so a
 * reload or a dead zone cannot lose a custody event. The server remains the source of truth:
 * an accepted event is removed, a rejected one stays visible with its reason.
 */
export type QueuedScan = {
  clientEventId: string;
  deviceId: string;
  scannedType: "order" | "container" | "seal";
  scannedId: string;
  capturedAt: string;
  context: Record<string, unknown>;
  payloadHash: string;
};

const DB_NAME = "laundry-courier";
const STORE = "scans";
const DEVICE_KEY = "laundry.courier.device";

function normalizeScope(scope?: string): string | undefined {
  const trimmed = scope?.trim();
  return trimmed ? trimmed : undefined;
}

function dbName(scope?: string): string {
  const normalized = normalizeScope(scope);
  return normalized ? `${DB_NAME}:${normalized}` : DB_NAME;
}

function openDb(scope?: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName(scope), 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "clientEventId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort()
      .map(key => [key, sorted((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * Must stay byte-identical to the server's canonical hash:
 * sha256(JSON.stringify([clientEventId, deviceId, scannedType, scannedId, capturedAt, sortedContext]))
 */
export async function scanHash(scan: Omit<QueuedScan, "payloadHash">): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    // The server recomputes this hash with SHA-256 and rejects a mismatch as a tampered
    // payload, so without SubtleCrypto the scan cannot be authenticated at all.
    throw new Error("SECURE_CONTEXT_REQUIRED");
  }
  const canonical = JSON.stringify([
    scan.clientEventId, scan.deviceId, scan.scannedType, scan.scannedId, scan.capturedAt, sorted(scan.context),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function localDeviceId(scope?: string): string {
  const normalized = normalizeScope(scope);
  const key = normalized ? `${DEVICE_KEY}.${normalized}` : DEVICE_KEY;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  // `crypto.randomUUID` only exists in a secure context. Without a fallback the whole courier
  // workspace failed to mount outside one, so this mirrors the guard in `api.ts`.
  const created =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(key, created);
  return created;
}

export async function enqueueScan(scan: QueuedScan, scope?: string): Promise<void> {
  const db = await openDb(scope);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(scan);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function queuedScans(scope?: string): Promise<QueuedScan[]> {
  const db = await openDb(scope);
  const rows = await new Promise<QueuedScan[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as QueuedScan[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return rows;
}

export async function removeScans(ids: string[], scope?: string): Promise<void> {
  if (!ids.length) return;
  const db = await openDb(scope);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const id of ids) tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function queuedCount(scope?: string): Promise<number> {
  return (await queuedScans(scope)).length;
}
