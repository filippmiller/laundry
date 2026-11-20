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

export const LEGACY_DB_NAME = "laundry-courier";
const STORE = "scans";
export const LEGACY_DEVICE_KEY = "laundry.courier.device";
export const LEGACY_MIGRATION_MARKER_KEY = "laundry.courier.legacy_migration.v1";

export type LegacyMigrationMarker = {
  status: "in_progress" | "partial" | "completed";
  ownerScope: string;
  legacyDeviceId: string | null;
  migratedIds: string[];
  updatedAt: string;
};

export type LegacyQueueInspection = {
  legacyDeviceId: string | null;
  scans: QueuedScan[];
  distinctDeviceIds: string[];
};

export type LegacyMigrationResult = {
  status: "none" | "already_completed" | "migrated" | "partial" | "needs_confirmation";
  migratedCount: number;
  unverifiedCount: number;
  remainingLegacyCount: number;
  adoptedDeviceId: string | null;
};

function normalizeScope(scope?: string): string | undefined {
  const trimmed = scope?.trim();
  return trimmed ? trimmed : undefined;
}

function dbName(scope?: string): string {
  const normalized = normalizeScope(scope);
  return normalized ? `${LEGACY_DB_NAME}:${normalized}` : LEGACY_DB_NAME;
}

function deviceKey(scope?: string): string {
  const normalized = normalizeScope(scope);
  return normalized ? `${LEGACY_DEVICE_KEY}.${normalized}` : LEGACY_DEVICE_KEY;
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

export function peekLocalDeviceId(scope?: string): string | null {
  return localStorage.getItem(deviceKey(scope))?.trim() || null;
}

export function localDeviceId(scope?: string): string {
  const key = deviceKey(scope);
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

export function readLegacyMigrationMarker(): LegacyMigrationMarker | null {
  const raw = localStorage.getItem(LEGACY_MIGRATION_MARKER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LegacyMigrationMarker>;
    if (
      parsed
      && (parsed.status === "in_progress" || parsed.status === "partial" || parsed.status === "completed")
      && typeof parsed.ownerScope === "string"
      && Array.isArray(parsed.migratedIds)
    ) {
      return {
        status: parsed.status,
        ownerScope: parsed.ownerScope,
        legacyDeviceId: typeof parsed.legacyDeviceId === "string" ? parsed.legacyDeviceId : null,
        migratedIds: parsed.migratedIds.filter((id): id is string => typeof id === "string"),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function writeLegacyMigrationMarker(marker: LegacyMigrationMarker): void {
  localStorage.setItem(LEGACY_MIGRATION_MARKER_KEY, JSON.stringify(marker));
}

async function legacyDbExists(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  if (typeof indexedDB.databases === "function") {
    try {
      const list = await indexedDB.databases();
      return list.some(entry => entry.name === LEGACY_DB_NAME);
    } catch {
      // Fall through to opening the legacy DB directly if `databases()` is unavailable.
    }
  }
  return true;
}

/**
 * Inspects the legacy unscoped `laundry-courier` IndexedDB and `laundry.courier.device` key
 * without mutating or deleting any records.
 */
export async function inspectLegacyQueue(): Promise<LegacyQueueInspection> {
  const legacyDeviceId = localStorage.getItem(LEGACY_DEVICE_KEY)?.trim() || null;
  const exists = await legacyDbExists();
  const scans = exists ? await queuedScans(undefined) : [];
  const distinctDeviceIds = [...new Set([
    ...(legacyDeviceId ? [legacyDeviceId] : []),
    ...scans.map(scan => scan.deviceId).filter(Boolean),
  ])];
  return { legacyDeviceId, scans, distinctDeviceIds };
}

/**
 * Interrupt-safe, owner-verified migration from legacy unscoped `laundry-courier` IndexedDB and
 * `laundry.courier.device` key into the per-actor `org:user` namespace.
 *
 * Security & durability invariants:
 * - Never auto-claims unknown legacy events for a newly logged-in user: every legacy `deviceId`
 *   must be positively verified by `verifyDeviceOwner` (read-only server check), unless the user
 *   explicitly triggers manual recovery (`forceClaimUnverified: true`).
 * - Preserves `clientEventId`, `deviceId`, `scannedType`, `scannedId`, `capturedAt`, `context`,
 *   and `payloadHash` verbatim so server canonical hash and deduplication stay intact.
 * - Writes an `in_progress` marker before copying, writes to the scoped DB via idempotent `.put()`
 *   FIRST, and only removes migrated IDs from the legacy DB AFTER the scoped write commits.
 *   Re-running after an interruption loses zero rows and creates zero duplicates.
 * - Never silently deletes unverified legacy rows.
 */
export async function migrateLegacyQueueForActor(
  scope: string,
  options: {
    verifyDeviceOwner: (deviceId: string) => Promise<boolean>;
    forceClaimUnverified?: boolean;
    beforeLegacyCleanup?: () => void;
  },
): Promise<LegacyMigrationResult> {
  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope) {
    return { status: "none", migratedCount: 0, unverifiedCount: 0, remainingLegacyCount: 0, adoptedDeviceId: null };
  }

  const inspection = await inspectLegacyQueue();
  const existingMarker = readLegacyMigrationMarker();

  if (inspection.scans.length === 0 && !inspection.legacyDeviceId) {
    return {
      status: existingMarker?.status === "completed" ? "already_completed" : "none",
      migratedCount: 0,
      unverifiedCount: 0,
      remainingLegacyCount: 0,
      adoptedDeviceId: null,
    };
  }

  // Verify ownership of each distinct legacy deviceId via read-only server check.
  const ownershipByDevice = new Map<string, boolean>();
  for (const devId of inspection.distinctDeviceIds) {
    let owned = false;
    try {
      owned = await options.verifyDeviceOwner(devId);
    } catch {
      owned = false;
    }
    ownershipByDevice.set(devId, owned);
  }

  const verifiedScans = inspection.scans.filter(
    scan => ownershipByDevice.get(scan.deviceId) === true,
  );
  const eligibleScans = options.forceClaimUnverified ? inspection.scans : verifiedScans;
  const unverifiedScans = inspection.scans.filter(
    scan => ownershipByDevice.get(scan.deviceId) !== true && !options.forceClaimUnverified,
  );

  // Adopt legacy device key ONLY when positively verified as owned by this actor (never auto-claim).
  let adoptedDeviceId: string | null = null;
  const scopedKey = deviceKey(normalizedScope);
  if (
    inspection.legacyDeviceId
    && ownershipByDevice.get(inspection.legacyDeviceId) === true
    && !localStorage.getItem(scopedKey)
  ) {
    localStorage.setItem(scopedKey, inspection.legacyDeviceId);
    adoptedDeviceId = inspection.legacyDeviceId;
  }

  if (eligibleScans.length === 0) {
    if (adoptedDeviceId && inspection.scans.length === 0) {
      writeLegacyMigrationMarker({
        status: "completed",
        ownerScope: normalizedScope,
        legacyDeviceId: inspection.legacyDeviceId,
        migratedIds: [],
        updatedAt: new Date().toISOString(),
      });
      localStorage.removeItem(LEGACY_DEVICE_KEY);
      return {
        status: "migrated",
        migratedCount: 0,
        unverifiedCount: 0,
        remainingLegacyCount: 0,
        adoptedDeviceId,
      };
    }
    if (unverifiedScans.length > 0) {
      return {
        status: "needs_confirmation",
        migratedCount: 0,
        unverifiedCount: unverifiedScans.length,
        remainingLegacyCount: inspection.scans.length,
        adoptedDeviceId,
      };
    }
    return {
      status: existingMarker?.status === "completed" ? "already_completed" : "none",
      migratedCount: 0,
      unverifiedCount: 0,
      remainingLegacyCount: 0,
      adoptedDeviceId,
    };
  }

  const migratedIds = eligibleScans.map(scan => scan.clientEventId);

  // Step 1: persist interrupt-safe in_progress marker before mutating IndexedDB.
  writeLegacyMigrationMarker({
    status: "in_progress",
    ownerScope: normalizedScope,
    legacyDeviceId: inspection.legacyDeviceId,
    migratedIds,
    updatedAt: new Date().toISOString(),
  });

  // Step 2: copy eligible scans verbatim into the actor-scoped DB (idempotent by clientEventId).
  const targetDb = await openDb(normalizedScope);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = targetDb.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const scan of eligibleScans) {
        store.put({
          clientEventId: scan.clientEventId,
          deviceId: scan.deviceId,
          scannedType: scan.scannedType,
          scannedId: scan.scannedId,
          capturedAt: scan.capturedAt,
          context: scan.context,
          payloadHash: scan.payloadHash,
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    targetDb.close();
  }

  // Deterministic crash/interruption hook for tests.
  options.beforeLegacyCleanup?.();

  // Step 3: remove ONLY ownership-verified migrated IDs from the legacy DB after scoped write has committed.
  // Unverified scans copied via explicit `forceClaimUnverified` recovery remain intact in legacy IndexedDB
  // so another courier's scans on a shared device can never be stranded.
  const verifiedMigratedIds = verifiedScans.map(scan => scan.clientEventId);
  if (verifiedMigratedIds.length > 0) {
    await removeScans(verifiedMigratedIds, undefined);
  }

  const remainingLegacy = await queuedScans(undefined);
  const finalStatus = remainingLegacy.length === 0 ? "completed" : "partial";
  writeLegacyMigrationMarker({
    status: finalStatus,
    ownerScope: normalizedScope,
    legacyDeviceId: inspection.legacyDeviceId,
    migratedIds,
    updatedAt: new Date().toISOString(),
  });
  if (finalStatus === "completed") {
    localStorage.removeItem(LEGACY_DEVICE_KEY);
  }

  return {
    status: remainingLegacy.length === 0 ? "migrated" : "partial",
    migratedCount: eligibleScans.length,
    unverifiedCount: unverifiedScans.length,
    remainingLegacyCount: remainingLegacy.length,
    adoptedDeviceId,
  };
}
