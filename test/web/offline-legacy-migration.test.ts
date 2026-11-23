import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_DB_NAME,
  LEGACY_DEVICE_KEY,
  LEGACY_MIGRATION_MARKER_KEY,
  enqueueScan,
  inspectLegacyQueue,
  localDeviceId,
  migrateLegacyQueueForActor,
  peekLocalDeviceId,
  queuedScans,
  readLegacyMigrationMarker,
  scanHash,
  type QueuedScan,
} from "../../apps/web/src/offline.js";

/**
 * Minimal deterministic in-memory IndexedDB + localStorage harness for testing
 * `apps/web/src/offline.ts` legacy migration, interruption recovery, and per-actor isolation.
 */
function installStorageStubs() {
  const lsStore = new Map<string, string>();
  const localStorageStub = {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => { lsStore.set(k, String(v)); },
    removeItem: (k: string) => { lsStore.delete(k); },
    clear: () => { lsStore.clear(); },
  };

  // Map<dbName, Map<storeName, Map<key, value>>>
  const databases = new Map<string, Map<string, Map<string, unknown>>>();

  const indexedDBStub = {
    async databases() {
      return [...databases.keys()].map(name => ({ name, version: 1 }));
    },
    open(name: string) {
      const req: Record<string, unknown> = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        const existed = databases.has(name);
        if (!existed) databases.set(name, new Map());
        const stores = databases.get(name)!;
        const dbObj = {
          objectStoreNames: {
            contains: (storeName: string) => stores.has(storeName),
          },
          createObjectStore: (storeName: string) => {
            if (!stores.has(storeName)) stores.set(storeName, new Map());
            return {};
          },
          transaction: (storeName: string) => {
            const storeMap = stores.get(storeName) ?? new Map<string, unknown>();
            stores.set(storeName, storeMap);
            const tx: Record<string, unknown> = {
              oncomplete: null,
              onerror: null,
              objectStore: () => ({
                put: (value: { clientEventId: string }) => {
                  storeMap.set(value.clientEventId, structuredClone(value));
                },
                delete: (key: string) => {
                  storeMap.delete(key);
                },
                getAll: () => {
                  const getAllReq: Record<string, unknown> = { result: null, onsuccess: null, onerror: null };
                  queueMicrotask(() => {
                    getAllReq.result = [...storeMap.values()].map(v => structuredClone(v));
                    (getAllReq.onsuccess as (() => void) | null)?.();
                  });
                  return getAllReq;
                },
              }),
            };
            queueMicrotask(() => {
              (tx.oncomplete as (() => void) | null)?.();
            });
            return tx;
          },
          close: () => undefined,
        };
        req.result = dbObj;
        if (!existed) {
          (req.onupgradeneeded as (() => void) | null)?.();
        }
        (req.onsuccess as (() => void) | null)?.();
      });
      return req;
    },
  };

  Object.defineProperty(globalThis, "localStorage", { value: localStorageStub, configurable: true, writable: true });
  Object.defineProperty(globalThis, "indexedDB", { value: indexedDBStub, configurable: true, writable: true });
  return { lsStore, databases };
}

async function makeScan(overrides: Partial<Omit<QueuedScan, "payloadHash">> = {}): Promise<QueuedScan> {
  const base: Omit<QueuedScan, "payloadHash"> = {
    clientEventId: overrides.clientEventId ?? crypto.randomUUID(),
    deviceId: overrides.deviceId ?? crypto.randomUUID(),
    scannedType: overrides.scannedType ?? "order",
    scannedId: overrides.scannedId ?? crypto.randomUUID(),
    capturedAt: overrides.capturedAt ?? "2026-11-20T10:00:00.000Z",
    context: overrides.context ?? { stopId: "stop-1" },
  };
  return { ...base, payloadHash: await scanHash(base) };
}

describe("W3-CD-01 / N-CD-03: legacy courier IndexedDB migration & per-actor namespace isolation", () => {
  beforeEach(() => {
    installStorageStubs();
  });

  it("migrates verified legacy queue for courier A once, preserves IDs/capturedAt/hash, and blocks courier B from seeing or claiming it", async () => {
    const scopeA = "org-1:courier-A";
    const scopeB = "org-1:courier-B";
    const legacyDeviceA = "11111111-1111-4111-8111-111111111111";

    // Seed legacy unscoped storage (as produced by the previous app version under courier A).
    localStorage.setItem(LEGACY_DEVICE_KEY, legacyDeviceA);
    const scan1 = await makeScan({ deviceId: legacyDeviceA, capturedAt: "2026-11-20T09:15:00.000Z" });
    const scan2 = await makeScan({ deviceId: legacyDeviceA, capturedAt: "2026-11-20T09:16:00.000Z" });
    await enqueueScan(scan1, undefined);
    await enqueueScan(scan2, undefined);

    // Courier B signs in first: server says legacyDeviceA is NOT owned by B.
    const resB = await migrateLegacyQueueForActor(scopeB, {
      verifyDeviceOwner: async () => false,
    });
    expect(resB).toMatchObject({
      status: "needs_confirmation",
      migratedCount: 0,
      unverifiedCount: 2,
      remainingLegacyCount: 2,
      adoptedDeviceId: null,
    });
    // B's queue is completely empty and legacy rows were NOT deleted!
    expect(await queuedScans(scopeB)).toEqual([]);
    expect((await inspectLegacyQueue()).scans).toHaveLength(2);
    expect(localDeviceId(scopeB)).not.toBe(legacyDeviceA);

    // Courier A signs in: server verifies legacyDeviceA IS owned by A.
    const resA = await migrateLegacyQueueForActor(scopeA, {
      verifyDeviceOwner: async devId => devId === legacyDeviceA,
    });
    expect(resA).toMatchObject({
      status: "migrated",
      migratedCount: 2,
      unverifiedCount: 0,
      remainingLegacyCount: 0,
      adoptedDeviceId: legacyDeviceA,
    });
    expect(localDeviceId(scopeA)).toBe(legacyDeviceA);

    const migratedA = await queuedScans(scopeA);
    expect(migratedA).toHaveLength(2);
    expect(migratedA.find(s => s.clientEventId === scan1.clientEventId)).toEqual(scan1);
    expect(migratedA.find(s => s.clientEventId === scan2.clientEventId)).toEqual(scan2);

    // Legacy queue is now empty, LEGACY_DEVICE_KEY is cleaned up, and migration marker is completed.
    expect((await inspectLegacyQueue()).scans).toHaveLength(0);
    expect(localStorage.getItem(LEGACY_DEVICE_KEY)).toBeNull();
    expect(readLegacyMigrationMarker()?.status).toBe("completed");

    // Re-running migration for A (or another login) is a safe no-op and does NOT invoke verifyDeviceOwner.
    let staleChecks = 0;
    const resA2 = await migrateLegacyQueueForActor(scopeA, {
      verifyDeviceOwner: async () => {
        staleChecks += 1;
        return true;
      },
    });
    expect(resA2.status).toBe("already_completed");
    expect(resA2.migratedCount).toBe(0);
    expect(staleChecks).toBe(0);
    expect(await queuedScans(scopeA)).toHaveLength(2);
  });

  it("defers scoped UUID generation via peekLocalDeviceId so verified legacy device is adopted, then removes LEGACY_DEVICE_KEY", async () => {
    const scopeA = "org-1:courier-A";
    const scopeC = "org-1:courier-C";
    const legacyDeviceA = "44444444-4444-4444-8444-444444444444";
    localStorage.setItem(LEGACY_DEVICE_KEY, legacyDeviceA);

    // Before migration, peekLocalDeviceId does NOT eagerly persist a fresh scoped UUID.
    expect(peekLocalDeviceId(scopeA)).toBeNull();
    expect(localStorage.getItem(`${LEGACY_DEVICE_KEY}.${scopeA}`)).toBeNull();

    // Migration adopts legacyDeviceA directly into scopeA and removes LEGACY_DEVICE_KEY.
    const resA = await migrateLegacyQueueForActor(scopeA, {
      verifyDeviceOwner: async devId => devId === legacyDeviceA,
    });
    expect(resA).toMatchObject({
      status: "migrated",
      migratedCount: 0,
      unverifiedCount: 0,
      remainingLegacyCount: 0,
      adoptedDeviceId: legacyDeviceA,
    });
    expect(peekLocalDeviceId(scopeA)).toBe(legacyDeviceA);
    expect(localDeviceId(scopeA)).toBe(legacyDeviceA);
    expect(localStorage.getItem(LEGACY_DEVICE_KEY)).toBeNull();
    expect(readLegacyMigrationMarker()?.status).toBe("completed");

    // Future login by another courier C does not trigger any stale device ownership check
    // and generates its own fresh scoped device ID after migration finishes.
    let verifyCallsForC = 0;
    const resC = await migrateLegacyQueueForActor(scopeC, {
      verifyDeviceOwner: async () => {
        verifyCallsForC += 1;
        return false;
      },
    });
    expect(resC.status).toBe("already_completed");
    expect(resC.adoptedDeviceId).toBeNull();
    expect(verifyCallsForC).toBe(0);
    expect(peekLocalDeviceId(scopeC)).toBeNull();
    const freshC = localDeviceId(scopeC);
    expect(freshC).not.toBe(legacyDeviceA);
    expect(peekLocalDeviceId(scopeC)).toBe(freshC);
  });

  it("recovers cleanly from an interrupted migration with zero lost rows and zero duplicates", async () => {
    const scopeA = "org-1:courier-A";
    const legacyDeviceA = "22222222-2222-4222-8222-222222222222";
    localStorage.setItem(LEGACY_DEVICE_KEY, legacyDeviceA);
    const scan1 = await makeScan({ deviceId: legacyDeviceA });
    const scan2 = await makeScan({ deviceId: legacyDeviceA });
    await enqueueScan(scan1, undefined);
    await enqueueScan(scan2, undefined);

    // Simulate a crash right after writing to scoped DB, BEFORE removing from legacy DB.
    await expect(
      migrateLegacyQueueForActor(scopeA, {
        verifyDeviceOwner: async devId => devId === legacyDeviceA,
        beforeLegacyCleanup: () => {
          throw new Error("SIMULATED_TAB_CRASH");
        },
      }),
    ).rejects.toThrow("SIMULATED_TAB_CRASH");

    // Marker is in_progress, scoped DB has both rows, legacy DB still has both rows (no data loss!).
    expect(readLegacyMigrationMarker()?.status).toBe("in_progress");
    expect(await queuedScans(scopeA)).toHaveLength(2);
    expect((await inspectLegacyQueue()).scans).toHaveLength(2);

    // Retry migration after reload: finishes cleanly with 0 duplicates and 0 lost rows.
    const retryRes = await migrateLegacyQueueForActor(scopeA, {
      verifyDeviceOwner: async devId => devId === legacyDeviceA,
    });
    expect(retryRes).toMatchObject({
      status: "migrated",
      migratedCount: 2,
      remainingLegacyCount: 0,
    });
    expect(await queuedScans(scopeA)).toHaveLength(2);
    expect((await inspectLegacyQueue()).scans).toHaveLength(0);
    expect(readLegacyMigrationMarker()?.status).toBe("completed");
    expect(localStorage.getItem(LEGACY_MIGRATION_MARKER_KEY)).toBeTruthy();
  });

  it("never auto-claims unverified legacy scans, preserves them without silent deletion, and supports explicit recovery", async () => {
    const scopeA = "org-1:courier-A";
    const unknownDevice = "33333333-3333-4333-8333-333333333333";
    localStorage.setItem(LEGACY_DEVICE_KEY, unknownDevice);
    const scan = await makeScan({ deviceId: unknownDevice });
    await enqueueScan(scan, undefined);

    // Automatic pass: server does not recognize unknownDevice -> NOT claimed, NOT deleted.
    const auto = await migrateLegacyQueueForActor(scopeA, {
      verifyDeviceOwner: async () => false,
    });
    expect(auto.status).toBe("needs_confirmation");
    expect(auto.unverifiedCount).toBe(1);
    expect(await queuedScans(scopeA)).toEqual([]);
    expect((await inspectLegacyQueue()).scans).toHaveLength(1);

    // Explicit user-confirmed recovery copies the unverified scan to scopeA WITHOUT deleting
    // the unverified row from legacy IndexedDB, so another courier's scans can never be stranded.
    const recovered = await migrateLegacyQueueForActor(scopeA, {
      verifyDeviceOwner: async () => false,
      forceClaimUnverified: true,
    });
    expect(recovered.status).toBe("partial");
    expect(recovered.migratedCount).toBe(1);
    expect(recovered.unverifiedCount).toBe(0);
    expect(recovered.remainingLegacyCount).toBe(1);
    expect(await queuedScans(scopeA)).toEqual([scan]);
    expect((await inspectLegacyQueue()).scans).toEqual([scan]);

    // When the rightful owner (scopeB) later signs in and verifies device ownership,
    // they can still migrate the preserved legacy scan and only then is it removed from legacy DB.
    const scopeB = "org-1:courier-B";
    const ownerMigrated = await migrateLegacyQueueForActor(scopeB, {
      verifyDeviceOwner: async devId => devId === unknownDevice,
    });
    expect(ownerMigrated.status).toBe("migrated");
    expect(ownerMigrated.migratedCount).toBe(1);
    expect(ownerMigrated.remainingLegacyCount).toBe(0);
    expect(await queuedScans(scopeB)).toEqual([scan]);
    expect((await inspectLegacyQueue()).scans).toEqual([]);
  });

  it("keeps fresh A -> logout -> B -> A namespaces strictly isolated", async () => {
    const scopeA = "org-1:courier-A";
    const scopeB = "org-1:courier-B";
    const devA = localDeviceId(scopeA);
    const devB = localDeviceId(scopeB);
    expect(devA).not.toBe(devB);

    const scanA = await makeScan({ deviceId: devA });
    const scanB = await makeScan({ deviceId: devB });
    await enqueueScan(scanA, scopeA);
    await enqueueScan(scanB, scopeB);

    expect(await queuedScans(scopeA)).toEqual([scanA]);
    expect(await queuedScans(scopeB)).toEqual([scanB]);
    expect(LEGACY_DB_NAME).toBe("laundry-courier");
  });
});
