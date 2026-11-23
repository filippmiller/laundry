import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, createPool, type Db } from "../../src/db/client.js";
import {
  courierShifts, custodyEvents, deliveryAttempts, evidenceAssets,
  intakeManifests, orders, organizations, outboxEvents, routeStops, scanEvents, shiftReconciliationAdjustments,
} from "../../src/db/schema.js";
import { makePrincipal, seedUser } from "../fixtures.js";
import { seedFullOrder, seedSeal } from "../operations-fixtures.js";
import { canonicalScanHash } from "../../src/core/scan-hash.js";
import { completeShift, getShiftReconciliation, openShift } from "../../src/services/courier-shift.js";
import {
  arriveStop, currentCourierStops, recordDeliveryAttempt, startStop,
} from "../../src/services/delivery.js";
import {
  checkCourierDeviceOwnership, recordIntake, syncScanEvents, type ScanEventInput,
} from "../../src/services/intake.js";
import {
  deleteEvidence, listEvidence, readEvidence, readEvidenceContent, registerEvidence, uploadEvidence,
} from "../../src/services/workspace.js";
import type { Pool } from "pg";

const rid = () => randomUUID();

/**
 * Deterministic barrier helper: opens a dedicated pg client, begins a transaction,
 * acquires `SELECT ... FOR UPDATE` on a target row, and returns a `release()` handle.
 */
async function holdRowLock(pool: Pool, table: "courier_shifts" | "route_stops" | "orders" | "evidence_assets", id: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Waits until at least one backend is actively blocked on a PostgreSQL row/tuple/transaction lock
 * on a query referencing `relationName`. (In PostgreSQL, row-lock waiters block on `transactionid`
 * or `tuple` locks where `pg_locks.relation` is NULL, so we inspect `pg_stat_activity`.)
 */
async function waitForLockWaiter(pool: Pool, relationName: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query ILIKE $1
        LIMIT 1`,
      [`%${relationName}%`],
    );
    if (res.rowCount && res.rowCount > 0) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for lock waiter on ${relationName}`);
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 4 Track 1: courier shift entitlement, concurrency races, unique active shift, and late-scan reconciliation", () => {
  let db: Db;
  let pool: Pool;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 16 });
    db = created.db;
    pool = createPool(process.env.TEST_DATABASE_URL!, { max: 8 });
    close = async () => {
      await pool.end();
      await created.pool.end();
    };
  });

  afterAll(async () => {
    await close();
  });

  it("N-CD-01 + W3-EV-01: active shift allows evidence & stop ops; foreign courier/tenant denied; post-close revokes all evidence & stop access even after opening a NEW shift", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const otherCourierId = await seedUser(db, f.organizationId);
    const otherCourier = makePrincipal(f.organizationId, otherCourierId, ["courier"]);
    const [foreignOrg] = await db.insert(organizations).values({
      name: `Foreign Tenant ${rid().slice(0, 8)}`,
    }).returning();
    const foreignOrgId = foreignOrg.id;
    const foreignCourierId = await seedUser(db, foreignOrgId);
    const foreignCourier = makePrincipal(foreignOrgId, foreignCourierId, ["courier"]);

    const bytes = Buffer.from("courier-intake-photo-bytes-wave4");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // Active shift: assigned courier can register, upload, list, read, and download content.
    const reg = await registerEvidence(db, f.courier, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `orders/${f.orderId}/${rid()}.jpg`,
      sha256,
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      key: `ev-reg-1-${rid()}`,
    });
    const uploaded = await uploadEvidence(db, f.courier, {
      evidenceId: reg.evidenceId,
      bytes,
      mimeType: "image/jpeg",
      key: `ev-up-1-${rid()}`,
    });
    expect(uploaded.status).toBe("verified");

    const listed = await listEvidence(db, f.courier, "order", f.orderId);
    expect(listed.some(row => row.id === reg.evidenceId)).toBe(true);
    const meta = await readEvidence(db, f.courier, reg.evidenceId);
    expect(meta.id).toBe(reg.evidenceId);
    const content = await readEvidenceContent(db, f.courier, reg.evidenceId);
    expect(content.bytes.equals(bytes)).toBe(true);

    // Foreign courier in same tenant and foreign tenant courier are denied (403/404).
    await expect(listEvidence(db, otherCourier, "order", f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readEvidence(db, otherCourier, reg.evidenceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readEvidenceContent(db, otherCourier, reg.evidenceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listEvidence(db, foreignCourier, "order", f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readEvidence(db, foreignCourier, reg.evidenceId)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Register a second pending asset BEFORE shift close to test post-close upload denial.
    const bytes2 = Buffer.from("pending-before-close-photo");
    const sha2 = createHash("sha256").update(bytes2).digest("hex");
    const regPending = await registerEvidence(db, f.courier, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `orders/${f.orderId}/${rid()}.jpg`,
      sha256: sha2,
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      sizeBytes: bytes2.byteLength,
      key: `ev-reg-2-${rid()}`,
    });

    // Complete shift while stop is still pending.
    const completed = await completeShift(db, f.courier, { shiftId: f.shiftId, key: `complete-ev-${rid()}` });
    expect(completed.state).toBe("completed");
    expect(await currentCourierStops(db, f.courier)).toEqual([]);

    // Post-close: ALL evidence operations on the old order are denied.
    await expect(listEvidence(db, f.courier, "order", f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readEvidence(db, f.courier, reg.evidenceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readEvidenceContent(db, f.courier, reg.evidenceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(uploadEvidence(db, f.courier, {
      evidenceId: regPending.evidenceId,
      bytes: bytes2,
      mimeType: "image/jpeg",
      key: `ev-up-post-close-${rid()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(registerEvidence(db, f.courier, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `orders/${f.orderId}/${rid()}.jpg`,
      sha256,
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      key: `ev-reg-post-close-${rid()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteEvidence(db, f.courier, {
      evidenceId: reg.evidenceId,
      key: `ev-del-post-close-${rid()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Opening a NEW active shift MUST NOT re-grant access to stops or evidence on the old route/shift!
    const newShift = await openShift(db, f.courier, { key: `open-new-shift-${rid()}` });
    expect(newShift.shiftId).not.toBe(f.shiftId);
    expect(newShift.state).toBe("active");

    expect(await currentCourierStops(db, f.courier)).toEqual([]);
    await expect(startStop(db, f.courier, { stopId: f.stopId, key: `start-old-stop-${rid()}` }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });
    await expect(listEvidence(db, f.courier, "order", f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readEvidence(db, f.courier, reg.evidenceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readEvidenceContent(db, f.courier, reg.evidenceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(uploadEvidence(db, f.courier, {
      evidenceId: regPending.evidenceId,
      bytes: bytes2,
      mimeType: "image/jpeg",
      key: `ev-up-new-shift-${rid()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("N-CD-01 deterministic race: close/start serializes cleanly in both orders (no post-close start)", async () => {
    // Order A: startStop acquires shift FOR SHARE first, blocks on route_stops; completeShift waits for startStop!
    const f1 = await seedFullOrder(db, { state: "pickup_assigned" });
    const stopLock = await holdRowLock(pool, "route_stops", f1.stopId);
    let closeDoneBeforeRelease = false;
    let started: Awaited<ReturnType<typeof startStop>>;
    let closed: Awaited<ReturnType<typeof completeShift>>;
    try {
      const startPromise = startStop(db, f1.courier, { stopId: f1.stopId, key: `race-start-a-${rid()}` });
      await waitForLockWaiter(pool, "route_stops");

      const closePromise = completeShift(db, f1.courier, { shiftId: f1.shiftId, key: `race-close-a-${rid()}` })
        .then(res => {
          closeDoneBeforeRelease = true;
          return res;
        });
      await waitForLockWaiter(pool, "courier_shifts");
      expect(closeDoneBeforeRelease).toBe(false);

      await stopLock.release();
      [started, closed] = await Promise.all([startPromise, closePromise]);
    } finally {
      await stopLock.release();
    }
    expect(started.state).toBe("en_route");
    expect(closed.state).toBe("completed");
    // Because startStop committed BEFORE completeShift, completeShift's snapshot sees the en_route stop!
    expect(closed.stops).toEqual({ en_route: 1 });

    // Order B: completeShift wins shift lock first; concurrent startStop waits on shift lock then aborts with SHIFT_NOT_ACTIVE.
    const f2 = await seedFullOrder(db, { state: "pickup_assigned" });
    const shiftLock = await holdRowLock(pool, "courier_shifts", f2.shiftId);
    let closed2: Awaited<ReturnType<typeof completeShift>>;
    let start2Res: { ok: true; v: Awaited<ReturnType<typeof startStop>> } | { ok: false; e: unknown };
    try {
      const close2 = completeShift(db, f2.courier, { shiftId: f2.shiftId, key: `race-close-b-${rid()}` });
      await waitForLockWaiter(pool, "courier_shifts");
      const start2 = startStop(db, f2.courier, { stopId: f2.stopId, key: `race-start-b-${rid()}` })
        .then(v => ({ ok: true as const, v }))
        .catch(e => ({ ok: false as const, e }));
      await shiftLock.release();

      [closed2, start2Res] = await Promise.all([close2, start2]);
    } finally {
      await shiftLock.release();
    }
    expect(closed2.state).toBe("completed");
    if (!start2Res.ok) {
      expect(start2Res.e).toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });
      const [stopRow] = await db.select().from(routeStops).where(eq(routeStops.id, f2.stopId)).limit(1);
      expect(stopRow.state).toBe("pending");
      const enRouteEvents = await db.select().from(outboxEvents).where(and(
        eq(outboxEvents.aggregateId, f2.stopId),
        eq(outboxEvents.eventType, "delivery.en_route"),
      ));
      expect(enRouteEvents).toHaveLength(0);
    } else {
      // If start2 acquired FOR SHARE before close2 acquired FOR UPDATE, close2's snapshot must reflect en_route.
      expect(closed2.stops).toEqual({ en_route: 1 });
    }
  });

  it("N-CD-01 deterministic race: close/intake serializes cleanly (no post-close manifest or custody)", async () => {
    // Order A: recordIntake acquires shift FOR SHARE first, blocks on orders; completeShift waits for intake to commit!
    const f1 = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal1 = await seedSeal(db, f1.organizationId);
    const orderLock = await holdRowLock(pool, "orders", f1.orderId);
    let closeFinishedEarly = false;
    let intakeRes: Awaited<ReturnType<typeof recordIntake>>;
    let closeRes: Awaited<ReturnType<typeof completeShift>>;
    try {
      const intakePromise = recordIntake(db, f1.courier, {
        orderId: f1.orderId,
        mode: "economy_bag",
        bags: [{ containerCode: `BAG-R1-${rid().slice(0, 6)}`, sealSerial: seal1.serial, weightGrams: 1200 }],
        customerConfirmation: true,
        courierConfirmation: true,
        key: `race-intake-a-${rid()}`,
      });
      // `INSERT INTO intake_manifests` acquires FOR KEY SHARE on `orders` and blocks on `orderLock`.
      await waitForLockWaiter(pool, "intake_manifests");

      const closePromise = completeShift(db, f1.courier, { shiftId: f1.shiftId, key: `race-close-in-a-${rid()}` })
        .then(res => {
          closeFinishedEarly = true;
          return res;
        });
      await waitForLockWaiter(pool, "courier_shifts");
      expect(closeFinishedEarly).toBe(false);

      await orderLock.release();
      [intakeRes, closeRes] = await Promise.all([intakePromise, closePromise]);
    } finally {
      await orderLock.release();
    }
    expect(intakeRes.state).toBe("picked_up");
    expect(closeRes.state).toBe("completed");

    // Order B: close commits while intake is waiting on shift lock -> intake rejected with 0 manifests/custody.
    const f2 = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal2 = await seedSeal(db, f2.organizationId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE courier_shifts SET state = 'completed', completed_at = NOW() WHERE id = $1`, [f2.shiftId]);
      const intakeBlocked = recordIntake(db, f2.courier, {
        orderId: f2.orderId,
        mode: "economy_bag",
        bags: [{ containerCode: `BAG-R2-${rid().slice(0, 6)}`, sealSerial: seal2.serial, weightGrams: 1200 }],
        customerConfirmation: true,
        courierConfirmation: true,
        key: `race-intake-b-${rid()}`,
      });
      await waitForLockWaiter(pool, "courier_shifts");
      await client.query("COMMIT");

      await expect(intakeBlocked).rejects.toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });
      expect(await db.select().from(intakeManifests).where(eq(intakeManifests.orderId, f2.orderId))).toHaveLength(0);
      expect(await db.select().from(custodyEvents).where(eq(custodyEvents.orderId, f2.orderId))).toHaveLength(0);
      const [orderRow] = await db.select().from(orders).where(eq(orders.id, f2.orderId)).limit(1);
      expect(orderRow.lifecycleState).toBe("pickup_assigned");
    } finally {
      client.release();
    }
  });

  it("N-CD-01 + W3-EV-01 deterministic races: close/arrive, close/delivery, and close/upload reject with zero business effect after close commits", async () => {
    // 1. close/arrive
    const fArrive = await seedFullOrder(db, { state: "pickup_assigned" });
    const c1 = await pool.connect();
    try {
      await c1.query("BEGIN");
      await c1.query(`UPDATE courier_shifts SET state = 'completed', completed_at = NOW() WHERE id = $1`, [fArrive.shiftId]);
      const arriveBlocked = arriveStop(db, fArrive.courier, { stopId: fArrive.stopId, key: `race-arrive-${rid()}` });
      await waitForLockWaiter(pool, "courier_shifts");
      await c1.query("COMMIT");
      await expect(arriveBlocked).rejects.toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });
      const [stopRow] = await db.select().from(routeStops).where(eq(routeStops.id, fArrive.stopId)).limit(1);
      expect(stopRow.state).toBe("pending");
    } finally {
      c1.release();
    }

    // 2. close/delivery
    const fDel = await seedFullOrder(db, { state: "pickup_assigned" });
    await db.update(routeStops).set({ state: "arrived" }).where(eq(routeStops.id, fDel.stopId));
    const c2 = await pool.connect();
    try {
      await c2.query("BEGIN");
      await c2.query(`UPDATE courier_shifts SET state = 'completed', completed_at = NOW() WHERE id = $1`, [fDel.shiftId]);
      const delBlocked = recordDeliveryAttempt(db, fDel.courier, {
        stopId: fDel.stopId,
        outcome: "recipient_unavailable",
        key: `race-delivery-${rid()}`,
      });
      await waitForLockWaiter(pool, "courier_shifts");
      await c2.query("COMMIT");
      await expect(delBlocked).rejects.toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });
      expect(await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.orderId, fDel.orderId))).toHaveLength(0);
    } finally {
      c2.release();
    }

    // 3. close/upload
    const fUp = await seedFullOrder(db, { state: "pickup_assigned" });
    const bytes = Buffer.from("race-upload-evidence-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reg = await registerEvidence(db, fUp.courier, {
      ownerType: "order",
      ownerId: fUp.orderId,
      objectKey: `orders/${fUp.orderId}/${rid()}.jpg`,
      sha256,
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      key: `race-up-reg-${rid()}`,
    });
    const c3 = await pool.connect();
    try {
      await c3.query("BEGIN");
      await c3.query(`UPDATE courier_shifts SET state = 'completed', completed_at = NOW() WHERE id = $1`, [fUp.shiftId]);
      const uploadBlocked = uploadEvidence(db, fUp.courier, {
        evidenceId: reg.evidenceId,
        bytes,
        mimeType: "image/jpeg",
        key: `race-up-put-${rid()}`,
      });
      await waitForLockWaiter(pool, "courier_shifts");
      await c3.query("COMMIT");
      await expect(uploadBlocked).rejects.toMatchObject({ code: "NOT_FOUND" });
      const [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, reg.evidenceId)).limit(1);
      expect(asset.status).toBe("pending_upload");
    } finally {
      c3.release();
    }
  });

  it("N-CD-06: concurrent openShift (fresh+fresh and planned+fresh) yields strictly ONE active shift and DB unique index enforces it", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });

    // Case 1: Two simultaneous fresh openShift calls with different keys.
    const courier1Id = await seedUser(db, f.organizationId);
    const courier1 = makePrincipal(f.organizationId, courier1Id, ["courier"]);
    const [r1, r2] = await Promise.all([
      openShift(db, courier1, { key: `fresh-a-${rid()}` }),
      openShift(db, courier1, { key: `fresh-b-${rid()}` }),
    ]);
    expect(r1.shiftId).toBe(r2.shiftId);
    expect([r1.reused, r2.reused].sort()).toEqual([false, true]);
    const activeRows1 = await db.select().from(courierShifts).where(and(
      eq(courierShifts.organizationId, f.organizationId),
      eq(courierShifts.courierId, courier1Id),
      eq(courierShifts.state, "active"),
    ));
    expect(activeRows1).toHaveLength(1);

    // Case 2: Planned activation racing fresh openShift; foreign/completed shifts untouched.
    const courier2Id = await seedUser(db, f.organizationId);
    const courier2 = makePrincipal(f.organizationId, courier2Id, ["courier"]);
    const [completedOld] = await db.insert(courierShifts).values({
      organizationId: f.organizationId,
      courierId: courier2Id,
      state: "completed",
      startsAt: new Date(Date.now() - 10 * 3600_000),
      endsAt: new Date(Date.now() - 2 * 3600_000),
    }).returning();
    const [planned] = await db.insert(courierShifts).values({
      organizationId: f.organizationId,
      courierId: courier2Id,
      state: "planned",
      startsAt: new Date(Date.now() + 3600_000),
      endsAt: new Date(Date.now() + 9 * 3600_000),
    }).returning();

    const [p1, p2] = await Promise.all([
      openShift(db, courier2, { key: `plan-a-${rid()}` }),
      openShift(db, courier2, { key: `plan-b-${rid()}` }),
    ]);
    expect(p1.shiftId).toBe(planned.id);
    expect(p2.shiftId).toBe(planned.id);
    expect([p1.reused, p2.reused].sort()).toEqual([false, true]);

    const activeRows2 = await db.select().from(courierShifts).where(and(
      eq(courierShifts.organizationId, f.organizationId),
      eq(courierShifts.courierId, courier2Id),
      eq(courierShifts.state, "active"),
    ));
    expect(activeRows2).toHaveLength(1);
    const [stillCompleted] = await db.select().from(courierShifts).where(eq(courierShifts.id, completedOld.id)).limit(1);
    expect(stillCompleted.state).toBe("completed");

    // Case 3: DB partial unique index directly rejects a second active row for the same (org, courier).
    await expect(db.insert(courierShifts).values({
      organizationId: f.organizationId,
      courierId: courier2Id,
      state: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600_000),
    })).rejects.toThrow();
  });

  it("N-CD-02: late valid offline scan from Shift 1 arriving during Shift 2 is accepted once, preserves Shift 1 close snapshot, records auditable adjustment, and never pollutes Shift 2", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const shift1Start = new Date(Date.now() - 120_000);
    await db.update(courierShifts).set({ startsAt: shift1Start }).where(eq(courierShifts.id, f.shiftId));

    // Read-only device ownership verification (used by safe legacy migration) works accurately.
    expect(await checkCourierDeviceOwnership(db, f.courier, f.deviceId)).toMatchObject({ owned: true, deviceId: f.deviceId });
    const otherCourier = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["courier"]);
    expect(await checkCourierDeviceOwnership(db, otherCourier, f.deviceId)).toEqual({ owned: false, deviceId: f.deviceId });
    expect(await checkCourierDeviceOwnership(db, f.courier, rid())).toMatchObject({ owned: false });

    // Sync 1 valid + 1 rejected scan during Shift 1.
    const scan1Base: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: rid(),
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: f.orderId,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      context: { stopId: f.stopId },
    };
    const rejectedBase: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: rid(),
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: rid(),
      capturedAt: new Date(Date.now() - 50_000).toISOString(),
      context: { stopId: f.stopId },
    };
    const initialSync = await syncScanEvents(db, f.courier, [
      { ...scan1Base, payloadHash: canonicalScanHash(scan1Base) },
      { ...rejectedBase, payloadHash: canonicalScanHash(rejectedBase) },
    ]);
    expect(initialSync.accepted).toHaveLength(1);
    expect(initialSync.rejected).toHaveLength(1);

    // Close Shift 1: snapshot records 1 accepted, 1 rejected.
    const lateCapturedAt = new Date(Date.now() - 30_000).toISOString();
    const close1 = await completeShift(db, f.courier, { shiftId: f.shiftId, key: `close-s1-${rid()}` });
    expect(close1.scans).toEqual({ accepted: 1, rejected: 1 });

    // Pause briefly and open Shift 2.
    await new Promise(resolve => setTimeout(resolve, 20));
    const shift2 = await openShift(db, f.courier, { key: `open-s2-${rid()}` });
    expect(shift2.shiftId).not.toBe(f.shiftId);

    // Late valid offline scan captured during Shift 1 arrives while Shift 2 is active,
    // even carrying a forged client `context.shiftId` pointing to Shift 2!
    const lateEventId = rid();
    const lateBase: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: lateEventId,
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: f.orderId,
      capturedAt: lateCapturedAt,
      context: { shiftId: shift2.shiftId, forged: true },
    };
    const lateEvent: ScanEventInput = { ...lateBase, payloadHash: canonicalScanHash(lateBase) };

    const lateSync1 = await syncScanEvents(db, f.courier, [lateEvent]);
    expect(lateSync1).toEqual({ accepted: [lateEventId], duplicate: [], rejected: [] });

    // Replaying the exact same late scan is a duplicate (accepted strictly once, no duplicate adjustment).
    const lateSync2 = await syncScanEvents(db, f.courier, [lateEvent]);
    expect(lateSync2).toEqual({ accepted: [], duplicate: [lateEventId], rejected: [] });

    // Verify scan_events row is attributed to Shift 1 (never Shift 2).
    const [lateRow] = await db.select().from(scanEvents).where(eq(scanEvents.clientEventId, lateEventId)).limit(1);
    expect(lateRow.syncStatus).toBe("accepted");
    expect(lateRow.shiftId).toBe(f.shiftId);

    // Verify Shift 1 reconciliation preserves original close snapshot (1/1) AND has 1 auditable adjustment -> effective 2/1.
    const recon1 = await getShiftReconciliation(db, f.courier, f.shiftId);
    expect(recon1.snapshot?.scans).toEqual({ accepted: 1, rejected: 1 });
    expect(recon1.adjustments).toHaveLength(1);
    expect(recon1.adjustments[0]).toMatchObject({
      scanEventId: lateRow.id,
      deltaAccepted: 1,
      deltaRejected: 0,
      reason: "late_offline_scan",
    });
    expect(recon1.effectiveScans).toEqual({ accepted: 2, rejected: 1 });

    // Verify auditable domain event `shift.reconciliation_adjusted` was recorded on Shift 1.
    const adjEvents = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateType, "courier_shift"),
      eq(outboxEvents.aggregateId, f.shiftId),
      eq(outboxEvents.eventType, "shift.reconciliation_adjusted"),
    ));
    expect(adjEvents).toHaveLength(1);

    // Verify Shift 2 close reports 0 accepted / 0 rejected (never receives Shift 1's late scan).
    const close2 = await completeShift(db, f.courier, { shiftId: shift2.shiftId, key: `close-s2-${rid()}` });
    expect(close2.scans).toEqual({ accepted: 0, rejected: 0 });
    const adj2 = await db.select().from(shiftReconciliationAdjustments)
      .where(eq(shiftReconciliationAdjustments.shiftId, shift2.shiftId));
    expect(adj2).toHaveLength(0);
  });
});
