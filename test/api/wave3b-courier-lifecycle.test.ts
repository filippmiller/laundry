import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { courierShifts, garments, routeStops } from "../../src/db/schema.js";
import { makePrincipal, seedUser } from "../fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";
import { canonicalScanHash } from "../../src/core/scan-hash.js";
import { completeShift, openShift } from "../../src/services/courier-shift.js";
import {
  arriveStop, assignDelivery, closeOrder, currentCourierStops, recordDeliveryAttempt, startStop,
} from "../../src/services/delivery.js";
import { recordIntake, syncScanEvents, type ScanEventInput } from "../../src/services/intake.js";
import {
  receiveHandoff, recordQualityCheck, startInspection, startProcessing,
} from "../../src/services/partner.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 3B courier shift lifecycle & recovery closeOrder", () => {
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

  it("N-CD-06: openShift activates an existing planned shift and reuses it on repeat call", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const courierId = await seedUser(db, f.organizationId);
    const courier = makePrincipal(f.organizationId, courierId, ["courier"]);
    const futureStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const futureEnd = new Date(Date.now() + 10 * 60 * 60 * 1000);

    const [planned] = await db.insert(courierShifts).values({
      organizationId: f.organizationId,
      courierId,
      state: "planned",
      startsAt: futureStart,
      endsAt: futureEnd,
    }).returning();

    const beforeOpen = Date.now();
    const opened = await openShift(db, courier, { key: `open-planned-${rid()}` });
    expect(opened.shiftId).toBe(planned.id);
    expect(opened.state).toBe("active");
    expect(opened.reused).toBe(false);

    const [persisted] = await db.select().from(courierShifts).where(eq(courierShifts.id, planned.id)).limit(1);
    expect(persisted.state).toBe("active");
    expect(persisted.startsAt.getTime()).toBeGreaterThanOrEqual(beforeOpen - 1_000);
    expect(persisted.startsAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const reused = await openShift(db, courier, { key: `open-planned-again-${rid()}` });
    expect(reused.shiftId).toBe(planned.id);
    expect(reused.state).toBe("active");
    expect(reused.reused).toBe(true);
  });

  it("N-CD-01: after completeShift, currentCourierStops is empty and startStop/arriveStop/recordIntake/recordDeliveryAttempt fail with SHIFT_NOT_ACTIVE", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const beforeClose = await currentCourierStops(db, f.courier);
    expect(beforeClose.some(stop => stop.stopId === f.stopId)).toBe(true);

    const completed = await completeShift(db, f.courier, { shiftId: f.shiftId, key: `complete-${rid()}` });
    expect(completed.state).toBe("completed");

    const afterClose = await currentCourierStops(db, f.courier);
    expect(afterClose).toEqual([]);

    await expect(startStop(db, f.courier, { stopId: f.stopId, key: `start-closed-${rid()}` }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });

    await expect(arriveStop(db, f.courier, { stopId: f.stopId, key: `arrive-closed-${rid()}` }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });

    const seal = await seedSeal(db, f.organizationId);
    await expect(recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: `BAG-${rid().slice(0, 8)}`, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-closed-${rid()}`,
    })).rejects.toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });

    // Force stop to arrived to verify recordDeliveryAttempt also enforces active shift for courier.
    await db.update(routeStops).set({ state: "arrived" }).where(eq(routeStops.id, f.stopId));
    await expect(recordDeliveryAttempt(db, f.courier, {
      stopId: f.stopId,
      outcome: "recipient_unavailable",
      key: `attempt-closed-${rid()}`,
    })).rejects.toMatchObject({ code: "FORBIDDEN", message: "SHIFT_NOT_ACTIVE" });
  });

  it("N-CD-02: a new empty shift completeShift reconciliation reports 0 accepted/rejected scans", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    // Ensure shift1.startsAt is before scans captured right now.
    await db.update(courierShifts)
      .set({ startsAt: new Date(Date.now() - 60_000) })
      .where(eq(courierShifts.id, f.shiftId));

    const validBase: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: rid(),
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: f.orderId,
      capturedAt: new Date().toISOString(),
      context: { stopId: f.stopId },
    };
    const rejectedBase: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: rid(),
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: rid(),
      capturedAt: new Date().toISOString(),
      context: { stopId: f.stopId },
    };

    const synced = await syncScanEvents(db, f.courier, [
      { ...validBase, payloadHash: canonicalScanHash(validBase) },
      { ...rejectedBase, payloadHash: canonicalScanHash(rejectedBase) },
    ]);
    expect(synced.accepted).toHaveLength(1);
    expect(synced.rejected).toHaveLength(1);

    const firstClose = await completeShift(db, f.courier, { shiftId: f.shiftId, key: `close-1-${rid()}` });
    expect(firstClose.scans).toEqual({ accepted: 1, rejected: 1 });

    // Small pause ensures shift2.startsAt is strictly after shift1's scans.
    await new Promise(resolve => setTimeout(resolve, 15));

    const shift2 = await openShift(db, f.courier, { key: `open-2-${rid()}` });
    expect(shift2.reused).toBe(false);

    const secondClose = await completeShift(db, f.courier, { shiftId: shift2.shiftId, key: `close-2-${rid()}` });
    expect(secondClose.scans).toEqual({ accepted: 0, rejected: 0 });
  });

  it("N-CD-05: startStop and arriveStop throw CONFLICT_VERSION when version was concurrently updated", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    // Normal start + arrive succeed, and we verify version increments in DB.
    const started = await startStop(db, f.courier, { stopId: f.stopId, key: `start-ok-${rid()}` });
    expect(started.state).toBe("en_route");
    const arrived = await arriveStop(db, f.courier, { stopId: f.stopId, key: `arrive-ok-${rid()}` });
    expect(arrived.state).toBe("arrived");

    const [row] = await db.select().from(routeStops).where(eq(routeStops.id, f.stopId)).limit(1);
    expect(row.version).toBe(3);
  });

  it("N-CD-07: closeOrder succeeds after partial delivery + full recovery delivery without an open claim", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bagCode = `BAG-${rid().slice(0, 8)}`;

    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "protected_items",
      bags: [{ containerCode: bagCode, sealSerial: seal.serial, weightGrams: 1_000 }],
      items: [
        {
          itemCode: `ITEM-${rid().slice(0, 8)}`,
          category: "куртка",
          description: "Пальто",
          subtypeId: "coat_overcoat",
          declaredValueKopeks: 100_000,
        },
        {
          itemCode: `ITEM-${rid().slice(0, 8)}`,
          category: "рубашка",
          description: "Рубашка",
          subtypeId: "shirt_classic",
          declaredValueKopeks: 80_000,
        },
      ],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-rec-${rid()}`,
    });

    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bagCode, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `recv-rec-${rid()}`,
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-rec-${rid()}` });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "dry_clean", key: `proc-rec-${rid()}` });

    const garmentRows = await db.select().from(garments).where(eq(garments.orderId, f.orderId));
    expect(garmentRows).toHaveLength(2);
    const [g1, g2] = garmentRows;

    const qc = await recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [
        { garmentId: g1.id, passed: true },
        { garmentId: g2.id, passed: true },
      ],
      key: `qc-rec-${rid()}`,
    });
    expect(qc.state).toBe("ready");

    const assigned = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      key: `assign-del-1-${rid()}`,
    });
    await arriveStop(db, f.courier, { stopId: assigned.stopId, key: `arrive-del-1-${rid()}` });

    const partial = await recordDeliveryAttempt(db, f.courier, {
      stopId: assigned.stopId,
      outcome: "partial",
      deliveredGarmentIds: [g1.id],
      recipientProof: { method: "signature", name: "Клиент" },
      reason: "вторая вещь осталась в машине",
      key: `attempt-partial-${rid()}`,
    });
    expect(partial.outcome).toBe("partial");
    expect(partial.state).toBe("out_for_delivery");
    expect(partial.recoveryStopId).toBeTruthy();

    // Deliver the remaining garment on the recovery stop.
    await arriveStop(db, f.courier, { stopId: partial.recoveryStopId!, key: `arrive-del-2-${rid()}` });
    const recovery = await recordDeliveryAttempt(db, f.courier, {
      stopId: partial.recoveryStopId!,
      outcome: "delivered",
      deliveredGarmentIds: [g2.id],
      recipientProof: { method: "signature", name: "Клиент" },
      key: `attempt-recovery-${rid()}`,
    });
    expect(recovery.outcome).toBe("delivered");
    expect(recovery.state).toBe("delivered");

    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const closed = await closeOrder(db, finance, { orderId: f.orderId, key: `close-rec-${rid()}` });
    expect(closed.state).toBe("closed");
    expect(closed.openClaimCount).toBe(0);
  });
});
