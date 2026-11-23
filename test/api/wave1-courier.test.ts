import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { courierShifts, customerAddresses, orders, routes, scanEvents } from "../../src/db/schema.js";
import { canonicalScanHash } from "../../src/core/scan-hash.js";
import { assignDelivery, currentCourierStops } from "../../src/services/delivery.js";
import { recordIntake, syncScanEvents, type ScanEventInput } from "../../src/services/intake.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";
import { completeProcessing, startInspection, startProcessing, receiveHandoff, recordQualityCheck } from "../../src/services/partner.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 1 courier & delivery fixes", () => {
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

  it("currentCourierStops returns building address, apartment, and notes without duplicating rows", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const [order] = await db.select({ addressId: orders.addressId }).from(orders).where(eq(orders.id, f.orderId)).limit(1);
    await db.update(customerAddresses)
      .set({ apartment: "42B", notes: "Код домофона 42#" })
      .where(eq(customerAddresses.id, order.addressId));
    // Add a second address for the same customer in the same building to verify no fan-out.
    await db.insert(customerAddresses).values({
      organizationId: f.organizationId,
      customerId: f.principal.userId,
      buildingId: f.buildingId,
      apartment: "99",
      notes: "Вторая квартира",
    });

    const stops = await currentCourierStops(db, f.courier);
    const matched = stops.filter(s => s.stopId === f.stopId);
    expect(matched).toHaveLength(1);
    expect(matched[0].address).toBeTruthy();
    expect(matched[0].apartment).toBe("42B");
    expect(matched[0].notes).toBe("Код домофона 42#");
  });

  it("assignDelivery defaults route plannedStart/plannedEnd to shift.startsAt/shift.endsAt", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = `BAG-${Math.random().toString(36).slice(2, 8)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${randomUUID()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `recv-${randomUUID()}`,
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-${randomUUID()}` });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: `proc-${randomUUID()}` });
    await completeProcessing(db, partner.principal, { orderId: f.orderId, key: `comp-${randomUUID()}` });
    await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], bagPassed: true, key: `qc-${randomUUID()}` });

    const [shift] = await db.select().from(courierShifts).where(eq(courierShifts.id, f.shiftId)).limit(1);
    const assigned = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      key: `assign-del-${randomUUID()}`,
    });
    const [deliveryRoute] = await db.select().from(routes).where(eq(routes.organizationId, f.organizationId))
      .then(rows => rows.filter(r => r.kind === "delivery"));
    expect(assigned.state).toBe("out_for_delivery");
    expect(deliveryRoute.plannedStart.getTime()).toBe(shift.startsAt.getTime());
    expect(deliveryRoute.plannedEnd.getTime()).toBe(shift.endsAt.getTime());
  });

  it("syncScanEvents re-evaluates previously rejected scans instead of returning duplicate", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    // Close the active shift so the scan is initially rejected with NO_ACTIVE_SHIFT.
    await db.update(courierShifts).set({ state: "completed" }).where(eq(courierShifts.id, f.shiftId));

    const base: Omit<ScanEventInput, "payloadHash"> = {
      clientEventId: randomUUID(),
      deviceId: f.deviceId,
      scannedType: "order",
      scannedId: f.orderId,
      capturedAt: new Date().toISOString(),
      context: { stopId: f.stopId },
    };
    const event: ScanEventInput = { ...base, payloadHash: canonicalScanHash(base) };

    const first = await syncScanEvents(db, f.courier, [event]);
    expect(first.accepted).toHaveLength(0);
    expect(first.duplicate).toHaveLength(0);
    expect(first.rejected).toEqual([{ clientEventId: event.clientEventId, reason: "NO_ACTIVE_SHIFT" }]);

    // Retry while shift is still closed -> must remain rejected, never duplicate.
    const second = await syncScanEvents(db, f.courier, [event]);
    expect(second.accepted).toHaveLength(0);
    expect(second.duplicate).toHaveLength(0);
    expect(second.rejected).toEqual([{ clientEventId: event.clientEventId, reason: "NO_ACTIVE_SHIFT" }]);

    // Open shift again and retry the exact same event -> must promote to accepted.
    await db.update(courierShifts).set({ state: "active" }).where(eq(courierShifts.id, f.shiftId));
    const third = await syncScanEvents(db, f.courier, [event]);
    expect(third.accepted).toEqual([event.clientEventId]);
    expect(third.duplicate).toHaveLength(0);
    expect(third.rejected).toHaveLength(0);

    const [row] = await db.select().from(scanEvents).where(eq(scanEvents.clientEventId, event.clientEventId)).limit(1);
    expect(row.syncStatus).toBe("accepted");

    // Subsequent retry of an accepted scan -> duplicate.
    const fourth = await syncScanEvents(db, f.courier, [event]);
    expect(fourth.duplicate).toEqual([event.clientEventId]);
  });
});
