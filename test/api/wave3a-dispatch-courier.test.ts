import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { courierShifts, scanEvents } from "../../src/db/schema.js";
import { canonicalScanHash } from "../../src/core/scan-hash.js";
import { syncScanEvents, type ScanEventInput } from "../../src/services/intake.js";
import { seedFullOrder } from "../operations-fixtures.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 3A dispatch & courier scan retry hardening", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  function buildEvent(
    f: { deviceId: string; orderId: string; stopId: string },
    overrides: Partial<Omit<ScanEventInput, "payloadHash">> = {},
  ): ScanEventInput {
    const base: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: randomUUID(),
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: f.orderId,
      capturedAt: new Date().toISOString(),
      context: { stopId: f.stopId },
      ...overrides,
    };
    return { ...base, payloadHash: canonicalScanHash(base) };
  }

  it("promotes a rejected scan to accepted when shift opens and payloadHash/context match", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    await db.update(courierShifts).set({ state: "completed" }).where(eq(courierShifts.id, f.shiftId));

    const event = buildEvent(f);
    const first = await syncScanEvents(db, f.courier, [event]);
    expect(first.rejected).toEqual([{ clientEventId: event.clientEventId, reason: "NO_ACTIVE_SHIFT" }]);

    await db.update(courierShifts).set({ state: "active" }).where(eq(courierShifts.id, f.shiftId));
    const retry = await syncScanEvents(db, f.courier, [event]);
    expect(retry.accepted).toEqual([event.clientEventId]);
    expect(retry.rejected).toHaveLength(0);
    expect(retry.duplicate).toHaveLength(0);

    const [row] = await db.select().from(scanEvents).where(eq(scanEvents.clientEventId, event.clientEventId)).limit(1);
    expect(row.syncStatus).toBe("accepted");
    expect(row.payloadHash).toBe(event.payloadHash);
    expect(row.contextJson).toEqual(event.context);
  });

  it("rejects retry with HASH_MISMATCH when payloadHash, context, or scannedId is altered", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const other = await seedFullOrder(db, { state: "pickup_assigned" });
    await db.update(courierShifts).set({ state: "completed" }).where(eq(courierShifts.id, f.shiftId));

    const original = buildEvent(f);
    const initial = await syncScanEvents(db, f.courier, [original]);
    expect(initial.rejected).toEqual([{ clientEventId: original.clientEventId, reason: "NO_ACTIVE_SHIFT" }]);

    // Re-open shift before attempting tampered retries.
    await db.update(courierShifts).set({ state: "active" }).where(eq(courierShifts.id, f.shiftId));

    // 1) Mismatched payloadHash
    const badHashRetry = await syncScanEvents(db, f.courier, [
      { ...original, payloadHash: "f".repeat(64) },
    ]);
    expect(badHashRetry.rejected).toEqual([{ clientEventId: original.clientEventId, reason: "HASH_MISMATCH" }]);
    expect(badHashRetry.accepted).toHaveLength(0);

    // 2) Altered context (with matching hash for the altered context AND with original hash)
    const alteredContextBase: Omit<ScanEventInput, "payloadHash"> = {
      ...original,
      context: { stopId: f.stopId, note: "tampered" },
    };
    const alteredContextRehashed = await syncScanEvents(db, f.courier, [
      { ...alteredContextBase, payloadHash: canonicalScanHash(alteredContextBase) },
    ]);
    expect(alteredContextRehashed.rejected).toEqual([{ clientEventId: original.clientEventId, reason: "HASH_MISMATCH" }]);

    const alteredContextOldHash = await syncScanEvents(db, f.courier, [
      { ...alteredContextBase, payloadHash: original.payloadHash },
    ]);
    expect(alteredContextOldHash.rejected).toEqual([{ clientEventId: original.clientEventId, reason: "HASH_MISMATCH" }]);

    // 3) Altered scannedId (with matching hash for the altered scannedId AND with original hash)
    const alteredScannedIdBase: Omit<ScanEventInput, "payloadHash"> = {
      ...original,
      scannedId: other.orderId,
    };
    const alteredScannedIdRehashed = await syncScanEvents(db, f.courier, [
      { ...alteredScannedIdBase, payloadHash: canonicalScanHash(alteredScannedIdBase) },
    ]);
    expect(alteredScannedIdRehashed.rejected).toEqual([{ clientEventId: original.clientEventId, reason: "HASH_MISMATCH" }]);

    const alteredScannedIdOldHash = await syncScanEvents(db, f.courier, [
      { ...alteredScannedIdBase, payloadHash: original.payloadHash },
    ]);
    expect(alteredScannedIdOldHash.rejected).toEqual([{ clientEventId: original.clientEventId, reason: "HASH_MISMATCH" }]);

    const [row] = await db.select().from(scanEvents).where(eq(scanEvents.clientEventId, original.clientEventId)).limit(1);
    expect(row.syncStatus).toBe("rejected");
  });

  it("never promotes an inconsistent stored rejected row whose contextJson disagrees with payloadHash", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const consistentBase: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: randomUUID(),
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: f.orderId,
      capturedAt: new Date().toISOString(),
      context: { stopId: f.stopId, clean: true },
    };
    const targetHash = canonicalScanHash(consistentBase);

    // First insert has stored contextJson differing from targetHash -> rejected as PAYLOAD_HASH_MISMATCH.
    const initial = await syncScanEvents(db, f.courier, [{
      ...consistentBase,
      context: { stopId: f.stopId, clean: false },
      payloadHash: targetHash,
    }]);
    expect(initial.rejected).toEqual([{ clientEventId: consistentBase.clientEventId, reason: "PAYLOAD_HASH_MISMATCH" }]);

    // Retrying with the context that matches targetHash must still fail with HASH_MISMATCH
    // because the stored row's contextJson disagrees with payloadHash.
    const retry = await syncScanEvents(db, f.courier, [{
      ...consistentBase,
      payloadHash: targetHash,
    }]);
    expect(retry.accepted).toHaveLength(0);
    expect(retry.rejected).toEqual([{ clientEventId: consistentBase.clientEventId, reason: "HASH_MISMATCH" }]);

    const [row] = await db.select().from(scanEvents).where(eq(scanEvents.clientEventId, consistentBase.clientEventId)).limit(1);
    expect(row.syncStatus).toBe("rejected");
    expect(row.contextJson).toEqual({ stopId: f.stopId, clean: false });
  });
});
