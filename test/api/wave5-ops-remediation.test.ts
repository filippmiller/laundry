import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, isNull } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  batches, batchItems, containerAssignments, containers, courierShifts,
  idempotencyRecords, intakeManifests, orderAdjustments, orders, outboxEvents, partnerCreditNotes,
  partnerDisputes, partnerInvoiceLines, partnerServiceAccruals, processingOperations,
  qualityChecks, routes, routeStops, seals, serviceWindows, shiftReconciliationAdjustments,
} from "../../src/db/schema.js";
import { makePrincipal, seedAddress, seedCatalog, seedDeliveryWindow, seedUser, seedWindow } from "../fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";
import { login, uniquePhone } from "./_fixtures.js";
import { canonicalScanHash } from "../../src/core/scan-hash.js";
import { createQuote } from "../../src/services/quotes.js";
import { createOrder, scheduleOrder } from "../../src/services/orders.js";
import { holdSlot } from "../../src/domain/slot-reservation.js";
import { recordIntake, registerCourierDevice, syncScanEvents } from "../../src/services/intake.js";
import { completeShift, openShift } from "../../src/services/courier-shift.js";
import {
  arriveStop, assignDelivery, assignPickup, closeOrder, currentCourierStops, recordDeliveryAttempt,
} from "../../src/services/delivery.js";
import {
  completeProcessing, decideAdjustment, partnerWorkspace, proposeAdjustment, receiveHandoff, recordQualityCheck,
  returnUnprocessedOrder, startInspection, startProcessing,
} from "../../src/services/partner.js";
import { createPartnerInvoice, disputePartnerLine, resolvePartnerDispute } from "../../src/services/finance.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 5 Ops Remediation (LND-PRO-001..004, LND-PRO-011)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function seedScheduledOrderWithTiers(
    lines: Array<{ tier: "economy" | "protected"; quantity: number }>,
    options: { shiftStartsAt?: Date; shiftEndsAt?: Date } = {},
  ) {
    const seed = await seedWindow(db, { capacity: 3 });
    const deliveryWindowId = await seedDeliveryWindow(db, seed);
    const catalog = await seedCatalog(db, seed.organizationId);
    await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
    const customer = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    const dispatcher = makePrincipal(seed.organizationId, await seedUser(db, seed.organizationId), ["dispatcher"]);
    const courierId = await seedUser(db, seed.organizationId);
    const courier = makePrincipal(seed.organizationId, courierId, ["courier"]);

    const quote = await createQuote(db, customer, {
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      tariffVersionId: catalog.tariffVersionId,
      key: `quote-${rid()}`,
      lines: lines.map(l => ({
        serviceId: catalog.serviceId,
        tier: l.tier,
        quantity: l.quantity,
        unit: "gram" as const,
      })),
    });
    const order = await createOrder(db, customer, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: catalog.termsVersion,
      key: `order-${rid()}`,
    });
    const pickupHold = await holdSlot(db, {
      principal: customer,
      windowId: seed.windowId,
      key: `hold-p-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
      expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    const deliveryHold = await holdSlot(db, {
      principal: customer,
      windowId: deliveryWindowId,
      key: `hold-d-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
      expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    await scheduleOrder(db, customer, {
      orderId: order.id,
      pickupReservationId: pickupHold.reservationId,
      deliveryReservationId: deliveryHold.reservationId,
      key: `sched-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
    });

    const [shift] = await db.insert(courierShifts).values({
      organizationId: seed.organizationId,
      courierId,
      state: "active",
      startsAt: options.shiftStartsAt ?? new Date("2026-12-01T09:00:00.000Z"),
      endsAt: options.shiftEndsAt ?? new Date("2026-12-01T18:00:00.000Z"),
    }).returning();

    return {
      ...seed,
      deliveryWindowId,
      catalog,
      customer,
      dispatcher,
      courier,
      courierId,
      orderId: order.id,
      quoteId: quote.id,
      shiftId: shift.id,
    };
  }

  // =========================================================================
  // LND-PRO-001
  // =========================================================================

  it("LND-PRO-001: enforces quoted tier + mandatory item inventory in recordIntake and exposes quotedTiers on currentCourierStops", async () => {
    // 1. Protected-only quote
    const prot = await seedScheduledOrderWithTiers([{ tier: "protected", quantity: 1_000 }]);
    const protPickup = await assignPickup(db, prot.dispatcher, {
      orderId: prot.orderId,
      shiftId: prot.shiftId,
      key: `ap-prot-${rid()}`,
    });

    const protStops = await currentCourierStops(db, prot.courier);
    const protStop = protStops.find(s => s.stopId === protPickup.stopId);
    expect(protStop?.quotedTiers).toEqual(["protected"]);

    const protSeal = await seedSeal(db, prot.organizationId);
    // Rejects economy_bag with zero DB writes
    await expect(recordIntake(db, prot.courier, {
      orderId: prot.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: `BAG-P1-${rid().slice(0, 6)}`, sealSerial: protSeal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-p-econ-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "INTAKE_MODE_MISMATCH" });

    // Rejects mixed on protected-only quote with zero DB writes
    await expect(recordIntake(db, prot.courier, {
      orderId: prot.orderId,
      mode: "mixed",
      bags: [{ containerCode: `BAG-P2-${rid().slice(0, 6)}`, sealSerial: protSeal.serial, weightGrams: 1_000 }],
      items: [{ itemCode: `IT-P2-${rid().slice(0, 6)}`, category: "coat", description: "Пальто" }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-p-mix-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "INTAKE_MODE_MISMATCH" });

    // Rejects protected_items with empty items BEFORE any DB insert
    await expect(recordIntake(db, prot.courier, {
      orderId: prot.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-P3-${rid().slice(0, 6)}`, sealSerial: protSeal.serial, weightGrams: 1_000 }],
      items: [],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-p-empty-${rid()}`,
    })).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED", message: "PROTECTED_ITEMS_REQUIRED" });

    expect(await db.select().from(intakeManifests).where(eq(intakeManifests.orderId, prot.orderId))).toHaveLength(0);
    expect(await db.select().from(containerAssignments).where(eq(containerAssignments.orderId, prot.orderId))).toHaveLength(0);
    const [sealStillAvail] = await db.select().from(seals).where(eq(seals.id, protSeal.id));
    expect(sealStillAvail.state).toBe("available");

    // Accepts valid protected_items with items
    const protAccepted = await recordIntake(db, prot.courier, {
      orderId: prot.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-P4-${rid().slice(0, 6)}`, sealSerial: protSeal.serial, weightGrams: 1_000 }],
      items: [{ itemCode: `IT-P4-${rid().slice(0, 6)}`, category: "outerwear", description: "Пальто" }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-p-ok-${rid()}`,
    });
    expect(protAccepted.state).toBe("picked_up");
    expect(protAccepted.garments).toHaveLength(1);

    // 2. Mixed quote (economy + protected)
    const mix = await seedScheduledOrderWithTiers([
      { tier: "economy", quantity: 1_000 },
      { tier: "protected", quantity: 500 },
    ]);
    const mixPickup = await assignPickup(db, mix.dispatcher, {
      orderId: mix.orderId,
      shiftId: mix.shiftId,
      key: `ap-mix-${rid()}`,
    });
    const mixStops = await currentCourierStops(db, mix.courier);
    const mixStop = mixStops.find(s => s.stopId === mixPickup.stopId);
    expect(mixStop?.quotedTiers.slice().sort()).toEqual(["economy", "protected"]);

    const mixSeal = await seedSeal(db, mix.organizationId);
    await expect(recordIntake(db, mix.courier, {
      orderId: mix.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: `BAG-M1-${rid().slice(0, 6)}`, sealSerial: mixSeal.serial, weightGrams: 1_500 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-m-econ-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "INTAKE_MODE_MISMATCH" });

    await expect(recordIntake(db, mix.courier, {
      orderId: mix.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-M2-${rid().slice(0, 6)}`, sealSerial: mixSeal.serial, weightGrams: 1_500 }],
      items: [{ itemCode: `IT-M2-${rid().slice(0, 6)}`, category: "shirt", description: "Рубашка" }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-m-prot-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "INTAKE_MODE_MISMATCH" });

    const mixAccepted = await recordIntake(db, mix.courier, {
      orderId: mix.orderId,
      mode: "mixed",
      bags: [{ containerCode: `BAG-M3-${rid().slice(0, 6)}`, sealSerial: mixSeal.serial, weightGrams: 1_500 }],
      items: [{ itemCode: `IT-M3-${rid().slice(0, 6)}`, category: "shirt", description: "Рубашка" }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-m-ok-${rid()}`,
    });
    expect(mixAccepted.state).toBe("picked_up");
    expect(mixAccepted.garments).toHaveLength(1);
  });

  // =========================================================================
  // LND-PRO-002 / CLS-005
  // =========================================================================

  it("LND-PRO-002 (CLS-005): enforces startProcessing -> completeProcessing -> recordQualityCheck across normal, approve_change, and rewash flows", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = `BAG-002-${rid().slice(0, 6)}`;

    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "protected_items",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      items: [{ itemCode: `IT-002-${rid().slice(0, 6)}`, category: "shirt", description: "Шёлковая блуза" }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-002-${rid()}`,
    });
    const garmentId = intake.garments[0].id;

    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `rec-002-${rid()}`,
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-002-${rid()}` });

    // Propose and accept adjustment -> lifecycleState becomes 'processing' with NO batch yet
    const adj = await proposeAdjustment(db, partner.principal, {
      orderId: f.orderId,
      deltaKopeks: 20_000,
      reason: "Сложная химчистка шёлка",
      key: `adj-002-${rid()}`,
    });
    const [orderRow] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const approved = await decideAdjustment(db, f.principal, {
      adjustmentId: adj.adjustmentId,
      accept: true,
      quoteHash: orderRow.acceptedQuoteHash,
      key: `dec-002-${rid()}`,
    });
    expect(approved.state).toBe("processing");

    // Workspace shows hasActiveProcessingBatch === false, hasUncheckedProcessing === false
    const wsBefore = await partnerWorkspace(db, partner.principal);
    const wsRowBefore = wsBefore.orders.find(o => o.orderId === f.orderId);
    expect(wsRowBefore?.hasActiveProcessingBatch).toBe(false);
    expect(wsRowBefore?.hasUncheckedProcessing).toBe(false);

    // completeProcessing without an active processing batch MUST fail with PROCESSING_BATCH_REQUIRED
    await expect(completeProcessing(db, partner.principal, {
      orderId: f.orderId,
      key: `comp-missing-${rid()}`,
    })).rejects.toMatchObject({ message: "PROCESSING_BATCH_REQUIRED" });

    // QC without startProcessing + completeProcessing MUST fail with PROCESSING_NOT_COMPLETED and leave zero QC rows
    await expect(recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: true }],
      key: `qc-blocked-1-${rid()}`,
    })).rejects.toMatchObject({ message: "PROCESSING_NOT_COMPLETED" });
    expect(await db.select().from(qualityChecks).where(eq(qualityChecks.orderId, f.orderId))).toHaveLength(0);

    // startProcessing in 'processing' state creates batch + batchItems + start_processing op
    const [preBatchOrder] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const proc1 = await startProcessing(db, partner.principal, {
      orderId: f.orderId,
      processType: "dry_clean",
      key: `proc1-002-${rid()}`,
    });
    expect(proc1.state).toBe("processing");
    const [postBatchOrder] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(postBatchOrder.version).toBe(preBatchOrder.version + 1);

    const ops1 = await db.select().from(processingOperations).where(eq(processingOperations.batchId, proc1.batchId));
    expect(ops1).toHaveLength(1);
    expect(ops1[0].operation).toBe("start_processing");
    expect((ops1[0].detailsJson as { orderId?: string }).orderId).toBe(f.orderId);

    // After startProcessing (before completeProcessing): hasActiveProcessingBatch=true, hasUncheckedProcessing=false, QC still blocked
    const wsActive = await partnerWorkspace(db, partner.principal);
    const wsRowActive = wsActive.orders.find(o => o.orderId === f.orderId);
    expect(wsRowActive?.hasActiveProcessingBatch).toBe(true);
    expect(wsRowActive?.hasUncheckedProcessing).toBe(false);

    await expect(recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: true }],
      key: `qc-blocked-before-complete-${rid()}`,
    })).rejects.toMatchObject({ message: "PROCESSING_NOT_COMPLETED" });

    // completeProcessing transitions batch to 'quality_check', batch_items to 'ready_for_qc', emits processing.completed
    const comp1 = await completeProcessing(db, partner.principal, {
      orderId: f.orderId,
      notes: "Сушка завершена",
      key: `comp1-002-${rid()}`,
    });
    expect(comp1).toMatchObject({ orderId: f.orderId, batchId: proc1.batchId, state: "quality_check" });

    const [batch1Ready] = await db.select().from(batches).where(eq(batches.id, proc1.batchId));
    expect(batch1Ready.state).toBe("quality_check");
    const [item1Ready] = await db.select().from(batchItems).where(eq(batchItems.batchId, proc1.batchId));
    expect(item1Ready.status).toBe("ready_for_qc");

    const wsReadyQc = await partnerWorkspace(db, partner.principal);
    const wsRowReady = wsReadyQc.orders.find(o => o.orderId === f.orderId);
    expect(wsRowReady?.hasActiveProcessingBatch).toBe(false);
    expect(wsRowReady?.hasUncheckedProcessing).toBe(true);

    // QC fail -> rewash ('processing'), batch cancelled, batch_items 'failed_qc', workspace flags reset to false
    const qcFail = await recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: false, note: "Пятно осталось" }],
      key: `qc-fail-002-${rid()}`,
    });
    expect(qcFail.state).toBe("processing");
    const [batchAfterFail] = await db.select().from(batches).where(eq(batches.id, proc1.batchId));
    expect(batchAfterFail.state).toBe("cancelled");
    const [itemAfterFail] = await db.select().from(batchItems).where(eq(batchItems.batchId, proc1.batchId));
    expect(itemAfterFail.status).toBe("failed_qc");

    const wsAfterFail = await partnerWorkspace(db, partner.principal);
    const wsRowAfterFail = wsAfterFail.orders.find(o => o.orderId === f.orderId);
    expect(wsRowAfterFail?.hasActiveProcessingBatch).toBe(false);
    expect(wsRowAfterFail?.hasUncheckedProcessing).toBe(false);

    // Second QC without a new processing batch + completeProcessing MUST be rejected
    await expect(recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: true }],
      key: `qc-blocked-2-${rid()}`,
    })).rejects.toMatchObject({ message: "PROCESSING_NOT_COMPLETED" });

    // Start rewash batch, completeProcessing, then pass QC -> order 'ready', new batch 'packed', old remains 'cancelled'/'failed_qc'
    const proc2 = await startProcessing(db, partner.principal, {
      orderId: f.orderId,
      processType: "dry_clean",
      key: `proc2-002-${rid()}`,
    });
    await completeProcessing(db, partner.principal, {
      orderId: f.orderId,
      batchId: proc2.batchId,
      key: `comp2-002-${rid()}`,
    });
    const qcPass = await recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: true, note: "Чисто" }],
      key: `qc-pass-002-${rid()}`,
    });
    expect(qcPass.state).toBe("ready");
    const [batchAfterPass] = await db.select().from(batches).where(eq(batches.id, proc2.batchId));
    expect(batchAfterPass.state).toBe("packed");
    const [itemAfterPass] = await db.select().from(batchItems).where(eq(batchItems.batchId, proc2.batchId));
    expect(itemAfterPass.status).toBe("packed");

    const [oldBatchStillCancelled] = await db.select().from(batches).where(eq(batches.id, proc1.batchId));
    expect(oldBatchStillCancelled.state).toBe("cancelled");
    const [oldItemStillFailed] = await db.select().from(batchItems).where(eq(batchItems.batchId, proc1.batchId));
    expect(oldItemStillFailed.status).toBe("failed_qc");

    // Normal economy flow (no approve_change): inspection -> startProcessing -> supersede -> completeProcessing -> QC
    const fNormal = await seedFullOrder(db, { state: "pickup_assigned", tier: "economy" });
    const sealN = await seedSeal(db, fNormal.organizationId);
    const partnerN = await seedPartnerForOrder(db, fNormal);
    const bagN = `BAG-N02-${rid().slice(0, 6)}`;
    const intakeN = await recordIntake(db, fNormal.courier, {
      orderId: fNormal.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bagN, sealSerial: sealN.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-n02-${rid()}`,
    });
    await receiveHandoff(db, partnerN.principal, {
      orderId: fNormal.orderId,
      manifestId: intakeN.manifestId,
      actual: [{ containerCode: bagN, sealSerial: sealN.serial, actualWeightGrams: 1_000 }],
      key: `rec-n02-${rid()}`,
    });
    await startInspection(db, partnerN.principal, { orderId: fNormal.orderId, key: `insp-n02-${rid()}` });
    const pFirst = await startProcessing(db, partnerN.principal, {
      orderId: fNormal.orderId,
      processType: "wash",
      key: `p1-n02-${rid()}`,
    });
    // Starting another batch supersedes prior active batch to 'cancelled'
    const pSecond = await startProcessing(db, partnerN.principal, {
      orderId: fNormal.orderId,
      processType: "wash",
      key: `p2-n02-${rid()}`,
    });
    const [pFirstRow] = await db.select().from(batches).where(eq(batches.id, pFirst.batchId));
    expect(pFirstRow.state).toBe("cancelled");
    await completeProcessing(db, partnerN.principal, { orderId: fNormal.orderId, key: `comp-n02-${rid()}` });
    const qcN = await recordQualityCheck(db, partnerN.principal, {
      orderId: fNormal.orderId,
      results: [],
      bagPassed: true,
      key: `qc-n02-${rid()}`,
    });
    expect(qcN.state).toBe("ready");
    const [pSecondRow] = await db.select().from(batches).where(eq(batches.id, pSecond.batchId));
    expect(pSecondRow.state).toBe("packed");
  });

  // =========================================================================
  // LND-PRO-003 / OBS-001
  // =========================================================================

  it("LND-PRO-003 (OBS-001): enforces shift-window overlap by default and supports audited dispatcher override", async () => {
    // Shift covers pickup window (2026-12-01 09..18), does NOT cover delivery window (2026-12-02 10..12)
    const f = await seedScheduledOrderWithTiers([{ tier: "economy", quantity: 1_000 }]);
    const [pickupWin] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, f.windowId));
    const [deliveryWin] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, f.deliveryWindowId));

    // Pickup assignment inherits canonical pickup reservation window
    const pickupAssigned = await assignPickup(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      key: `ap-003-${rid()}`,
    });
    const [pickupStop] = await db.select().from(routeStops).where(eq(routeStops.id, pickupAssigned.stopId));
    expect(pickupStop.windowStart?.toISOString()).toBe(pickupWin.startsAt.toISOString());
    expect(pickupStop.windowEnd?.toISOString()).toBe(pickupWin.endsAt.toISOString());

    const [pickupEvent] = await db.select().from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, f.orderId), eq(outboxEvents.eventType, "order.assign_pickup")))
      .orderBy(desc(outboxEvents.createdAt))
      .limit(1);
    expect((pickupEvent.payloadJson as { shiftWindowMismatch?: boolean }).shiftWindowMismatch).toBe(false);

    // Intake -> Partner -> Ready
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = `BAG-003-${rid().slice(0, 6)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-003-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `rec-003-${rid()}`,
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-003-${rid()}` });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: `proc-003-${rid()}` });
    await completeProcessing(db, partner.principal, { orderId: f.orderId, key: `comp-003-${rid()}` });
    await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], bagPassed: true, key: `qc-003-${rid()}` });

    // Default-on enforcement rejects non-overlapping shift for delivery window with 409 SHIFT_WINDOW_MISMATCH
    await expect(assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      key: `ad-default-reject-${rid()}`,
    })).rejects.toMatchObject({ code: "CONFLICT_VERSION", message: "SHIFT_WINDOW_MISMATCH" });

    // Audited override with short/missing reason rejects with 400 OVERRIDE_REASON_REQUIRED
    await expect(assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      overrideShiftWindowMismatch: true,
      overrideReason: "abc",
      key: `ad-short-reason-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "OVERRIDE_REASON_REQUIRED" });

    // Audited override with valid reason succeeds and records shiftWindowMismatch + overrideReason + overrideActorId
    const overrideReason = "Согласованная доставка вне окна смены";
    const delAssigned = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      overrideShiftWindowMismatch: true,
      overrideReason,
      key: `ad-audited-override-${rid()}`,
    });
    const [delStop] = await db.select().from(routeStops).where(eq(routeStops.id, delAssigned.stopId));
    expect(delStop.windowStart?.toISOString()).toBe(deliveryWin.startsAt.toISOString());
    expect(delStop.windowEnd?.toISOString()).toBe(deliveryWin.endsAt.toISOString());

    const [delRoute] = await db.select().from(routes).where(eq(routes.id, delStop.routeId));
    expect(delRoute.plannedStart.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(delRoute.plannedEnd.toISOString()).toBe("2026-12-01T18:00:00.000Z");

    const [delEvent] = await db.select().from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, f.orderId), eq(outboxEvents.eventType, "order.dispatch")))
      .orderBy(desc(outboxEvents.createdAt))
      .limit(1);
    expect(delEvent.payloadJson).toMatchObject({
      shiftWindowMismatch: true,
      overrideReason,
      overrideActorId: f.dispatcher.userId,
    });

    // Explicit window override overlapping shift populates custom window and records windowOverridden: true
    const customStart = new Date("2026-12-01T14:00:00.000Z");
    const customEnd = new Date("2026-12-01T16:00:00.000Z");
    const delOverride = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      windowStart: customStart,
      windowEnd: customEnd,
      key: `ad-override-${rid()}`,
    });
    const [overrideStop] = await db.select().from(routeStops).where(eq(routeStops.id, delOverride.stopId));
    expect(overrideStop.windowStart?.toISOString()).toBe(customStart.toISOString());
    expect(overrideStop.windowEnd?.toISOString()).toBe(customEnd.toISOString());

    const [overrideEvent] = await db.select().from(outboxEvents)
      .where(and(eq(outboxEvents.aggregateId, f.orderId), eq(outboxEvents.eventType, "order.dispatch")))
      .orderBy(desc(outboxEvents.createdAt))
      .limit(1);
    expect((overrideEvent.payloadJson as { windowOverridden?: boolean; shiftWindowMismatch?: boolean })).toMatchObject({
      windowOverridden: true,
      shiftWindowMismatch: false,
    });
  });

  // =========================================================================
  // LND-PRO-004 / CLS-003
  // =========================================================================

  it("LND-PRO-004 (CLS-003): retires containerAssignments on outbound repacking, delivery, closure; keeps returnUnprocessedOrder binding active until delivery", async () => {
    // 1. Outbound repacking on QC pass -> partnerWorkspace shows only active outbound -> delivery retires it -> reusable
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    await db.update(courierShifts).set({ endsAt: new Date("2026-12-03T18:00:00.000Z") }).where(eq(courierShifts.id, f.shiftId));
    const inSeal = await seedSeal(db, f.organizationId);
    const outSeal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const inBag = `BAG-IN-${rid().slice(0, 6)}`;
    const outBag = `BAG-OUT-${rid().slice(0, 6)}`;

    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: inBag, sealSerial: inSeal.serial, weightGrams: 1_200 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-004-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: inBag, sealSerial: inSeal.serial, actualWeightGrams: 1_200 }],
      key: `rec-004-${rid()}`,
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-004-${rid()}` });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: `proc-004-${rid()}` });
    await completeProcessing(db, partner.principal, { orderId: f.orderId, key: `comp-004-${rid()}` });

    const partnerSession = await login(app, {
      organizationId: f.organizationId,
      phone: uniquePhone(),
      roles: [...partner.principal.roles],
      partnerId: partner.partnerId,
    });
    expect(partnerSession.status).toBe(200);

    const qcResponse = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${f.orderId}/quality-check`,
      headers: { cookie: partnerSession.cookie, "idempotency-key": `qc-004-${rid()}` },
      payload: {
        results: [],
        bagPassed: true,
        outboundContainerCode: outBag,
        outboundSealCode: outSeal.serial,
      },
    });
    expect(qcResponse.statusCode).toBe(200);
    const qc = qcResponse.json() as { state: string };
    expect(qc.state).toBe("ready");

    // Inbound assignment is retired, outbound assignment is active, outbound seal is assigned
    const assignmentsAfterQc = await db.select({
      id: containerAssignments.id,
      unassignedAt: containerAssignments.unassignedAt,
      code: containers.code,
      sealId: containerAssignments.sealId,
    }).from(containerAssignments)
      .innerJoin(containers, eq(containers.id, containerAssignments.containerId))
      .where(eq(containerAssignments.orderId, f.orderId));
    expect(assignmentsAfterQc).toHaveLength(2);
    const retiredInbound = assignmentsAfterQc.find(a => a.code === inBag)!;
    const activeOutbound = assignmentsAfterQc.find(a => a.code === outBag)!;
    expect(retiredInbound.unassignedAt).not.toBeNull();
    expect(activeOutbound.unassignedAt).toBeNull();

    const [outSealRow] = await db.select().from(seals).where(eq(seals.id, outSeal.id));
    expect(outSealRow.state).toBe("assigned");

    // partnerWorkspace lists ONLY the active outbound container
    const wsAfterQc = await partnerWorkspace(db, partner.principal);
    const wsOrder = wsAfterQc.orders.find(o => o.orderId === f.orderId)!;
    expect(wsOrder.containers.map(c => c.containerCode)).toEqual([outBag]);

    // Delivery attempt (delivered) retires active containerAssignments
    const del = await assignDelivery(db, f.dispatcher, { orderId: f.orderId, shiftId: f.shiftId, key: `ad-004-${rid()}` });
    await arriveStop(db, f.courier, { stopId: del.stopId, key: `arr-004-${rid()}` });
    const delivered = await recordDeliveryAttempt(db, f.courier, {
      stopId: del.stopId,
      outcome: "delivered",
      recipientProof: { method: "signature", name: "Иван" },
      key: `del-004-${rid()}`,
    });
    expect(delivered.state).toBe("delivered");

    const activeAfterDel = await db.select().from(containerAssignments).where(and(
      eq(containerAssignments.orderId, f.orderId),
      isNull(containerAssignments.unassignedAt),
    ));
    expect(activeAfterDel).toHaveLength(0);

    // Close order also succeeds cleanly
    const worker = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["system_worker"]);
    const closed = await closeOrder(db, worker, { orderId: f.orderId, key: `close-004-${rid()}` });
    expect(closed.state).toBe("closed");

    // 2. CLS-003: returnUnprocessedOrder keeps containerAssignments active through ready/out_for_delivery until delivered
    const f2 = await seedFullOrder(db, { state: "pickup_assigned" });
    await db.update(courierShifts).set({ endsAt: new Date("2026-12-03T18:00:00.000Z") }).where(eq(courierShifts.id, f2.shiftId));
    const seal2 = await seedSeal(db, f2.organizationId);
    const partner2 = await seedPartnerForOrder(db, f2);
    const bag2 = `BAG-RET-${rid().slice(0, 6)}`;
    const intake2 = await recordIntake(db, f2.courier, {
      orderId: f2.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag2, sealSerial: seal2.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int2-004-${rid()}`,
    });
    await receiveHandoff(db, partner2.principal, {
      orderId: f2.orderId,
      manifestId: intake2.manifestId,
      actual: [{ containerCode: bag2, sealSerial: seal2.serial, actualWeightGrams: 1_000 }],
      key: `rec2-004-${rid()}`,
    });
    await startInspection(db, partner2.principal, { orderId: f2.orderId, key: `insp2-004-${rid()}` });
    const ret = await returnUnprocessedOrder(db, partner2.principal, {
      orderId: f2.orderId,
      reason: "Ткань не подлежит чистке",
      key: `ret2-004-${rid()}`,
    });
    expect(ret.state).toBe("ready");

    // Binding stays active after returnUnprocessedOrder
    const activeAfterRet = await db.select().from(containerAssignments).where(and(
      eq(containerAssignments.orderId, f2.orderId),
      isNull(containerAssignments.unassignedAt),
    ));
    expect(activeAfterRet).toHaveLength(1);

    // Reusing bag2 in the same org before delivery is blocked
    const siblingCustomer = makePrincipal(f2.organizationId, await seedUser(db, f2.organizationId), ["customer"]);
    await seedAddress(db, f2.organizationId, siblingCustomer.userId, f2.buildingId);
    const siblingQuote = await createQuote(db, siblingCustomer, {
      buildingId: f2.buildingId,
      pickupWindowId: f2.windowId,
      deliveryWindowId: f2.deliveryWindowId,
      tariffVersionId: f2.catalog.tariffVersionId,
      key: `q-sib-${rid()}`,
      lines: [{ serviceId: f2.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });
    const siblingOrder = await createOrder(db, siblingCustomer, {
      quoteId: siblingQuote.id,
      acceptedQuoteHash: siblingQuote.quoteHash,
      termsVersion: f2.catalog.termsVersion,
      key: `o-sib-${rid()}`,
    });
    const sibPickupHold = await holdSlot(db, {
      principal: siblingCustomer,
      windowId: f2.windowId,
      key: `h-sib-p-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
      expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    const sibDelHold = await holdSlot(db, {
      principal: siblingCustomer,
      windowId: f2.deliveryWindowId,
      key: `h-sib-d-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
      expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    await scheduleOrder(db, siblingCustomer, {
      orderId: siblingOrder.id,
      pickupReservationId: sibPickupHold.reservationId,
      deliveryReservationId: sibDelHold.reservationId,
      key: `s-sib-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
    });
    await assignPickup(db, f2.dispatcher, {
      orderId: siblingOrder.id,
      shiftId: f2.shiftId,
      key: `ap-sib-${rid()}`,
    });
    const sibSeal = await seedSeal(db, f2.organizationId);
    await expect(recordIntake(db, f2.courier, {
      orderId: siblingOrder.id,
      mode: "economy_bag",
      bags: [{ containerCode: bag2, sealSerial: sibSeal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-sib-blocked-${rid()}`,
    })).rejects.toMatchObject({ code: "CUSTODY_CONFLICT", message: "CONTAINER_ALREADY_ASSIGNED" });

    // Deliver f2 -> retires containerAssignments -> bag2 becomes reusable
    const del2 = await assignDelivery(db, f2.dispatcher, {
      orderId: f2.orderId,
      shiftId: f2.shiftId,
      key: `ad-ret-${rid()}`,
    });
    await arriveStop(db, f2.courier, { stopId: del2.stopId, key: `arr-ret-${rid()}` });
    await recordDeliveryAttempt(db, f2.courier, {
      stopId: del2.stopId,
      outcome: "delivered",
      recipientProof: { method: "signature", name: "Анна" },
      key: `del-ret-${rid()}`,
    });

    const activeAfterRetDel = await db.select().from(containerAssignments).where(and(
      eq(containerAssignments.orderId, f2.orderId),
      isNull(containerAssignments.unassignedAt),
    ));
    expect(activeAfterRetDel).toHaveLength(0);

    const sibAccepted = await recordIntake(db, f2.courier, {
      orderId: siblingOrder.id,
      mode: "economy_bag",
      bags: [{ containerCode: bag2, sealSerial: sibSeal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-sib-ok-${rid()}`,
    });
    expect(sibAccepted.state).toBe("picked_up");
  });

  // =========================================================================
  // CLS-004: Temporal scan resolution across bag reuse & completed shifts
  // =========================================================================

  it("CLS-004: resolves delayed container scan to Order A on completed Shift 1 even after bag reuse in Shift 2, and rejects forged context or out-of-window scans", async () => {
    const f = await seedScheduledOrderWithTiers([{ tier: "economy", quantity: 1_000 }]);
    const deviceId = randomUUID();
    await registerCourierDevice(db, f.courier, { deviceId, label: "CLS-004 scanner" });

    // Replace default future shift with a real-time Shift 1 so completeShift captures a realistic completedAt window
    await db.update(courierShifts).set({
      state: "completed",
      completedAt: new Date(),
    }).where(eq(courierShifts.id, f.shiftId));

    const shift1Start = new Date(Date.now() - 10 * 60_000);
    const shift1End = new Date(Date.now() + 2 * 60 * 60_000);
    const s1 = await openShift(db, f.courier, {
      startsAt: shift1Start.toISOString(),
      endsAt: shift1End.toISOString(),
      key: `open-s1-${rid()}`,
    });

    await assignPickup(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: s1.shiftId,
      overrideShiftWindowMismatch: true,
      overrideReason: "Забор по оперативной смене 1",
      key: `ap-cls4-a-${rid()}`,
    });

    const sharedBag = `BAG-CLS4-${rid().slice(0, 6)}`;
    const sealA = await seedSeal(db, f.organizationId);
    const intakeA = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: sharedBag, sealSerial: sealA.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-cls4-a-${rid()}`,
    });

    // Timestamp strictly after intakeA.assignedAt and before Shift 1 completion / Order A delivery
    await new Promise(resolve => setTimeout(resolve, 20));
    const capturedInShift1 = new Date();
    await new Promise(resolve => setTimeout(resolve, 20));

    // Order A goes through partner -> ready -> delivered in Shift 1 (retires sharedBag)
    const partner = await seedPartnerForOrder(db, f);
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intakeA.manifestId,
      actual: [{ containerCode: sharedBag, sealSerial: sealA.serial, actualWeightGrams: 1_000 }],
      key: `rec-cls4-a-${rid()}`,
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-cls4-a-${rid()}` });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: `proc-cls4-a-${rid()}` });
    await completeProcessing(db, partner.principal, { orderId: f.orderId, key: `comp-cls4-a-${rid()}` });
    await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], bagPassed: true, key: `qc-cls4-a-${rid()}` });
    const delA = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: s1.shiftId,
      overrideShiftWindowMismatch: true,
      overrideReason: "Доставка по смене 1",
      key: `ad-cls4-a-${rid()}`,
    });
    await arriveStop(db, f.courier, { stopId: delA.stopId, key: `arr-cls4-a-${rid()}` });
    await recordDeliveryAttempt(db, f.courier, {
      stopId: delA.stopId,
      outcome: "delivered",
      recipientProof: { method: "signature", name: "Клиент А" },
      key: `del-cls4-a-${rid()}`,
    });

    // Complete Shift 1
    await completeShift(db, f.courier, { shiftId: s1.shiftId, key: `comp-s1-${rid()}` });
    await new Promise(resolve => setTimeout(resolve, 20));
    const afterShift1BeforeOrderB = new Date();
    await new Promise(resolve => setTimeout(resolve, 20));

    // Open Shift 2 and reuse sharedBag for Order B
    const s2 = await openShift(db, f.courier, {
      startsAt: new Date(Date.now() - 10_000).toISOString(),
      endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      key: `open-s2-${rid()}`,
    });
    const custB = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await seedAddress(db, f.organizationId, custB.userId, f.buildingId);
    const quoteB = await createQuote(db, custB, {
      buildingId: f.buildingId,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key: `q-cls4-b-${rid()}`,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });
    const orderB = await createOrder(db, custB, {
      quoteId: quoteB.id,
      acceptedQuoteHash: quoteB.quoteHash,
      termsVersion: f.catalog.termsVersion,
      key: `o-cls4-b-${rid()}`,
    });
    const pHoldB = await holdSlot(db, {
      principal: custB,
      windowId: f.windowId,
      key: `hp-cls4-b-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
      expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    const dHoldB = await holdSlot(db, {
      principal: custB,
      windowId: f.deliveryWindowId,
      key: `hd-cls4-b-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
      expiresAt: new Date("2026-11-16T12:10:00Z"),
    });
    await scheduleOrder(db, custB, {
      orderId: orderB.id,
      pickupReservationId: pHoldB.reservationId,
      deliveryReservationId: dHoldB.reservationId,
      key: `sched-cls4-b-${rid()}`,
      now: new Date("2026-11-16T12:00:00Z"),
    });
    await assignPickup(db, f.dispatcher, {
      orderId: orderB.id,
      shiftId: s2.shiftId,
      overrideShiftWindowMismatch: true,
      overrideReason: "Забор по оперативной смене 2",
      key: `ap-cls4-b-${rid()}`,
    });
    const sealB = await seedSeal(db, f.organizationId);
    await recordIntake(db, f.courier, {
      orderId: orderB.id,
      mode: "economy_bag",
      bags: [{ containerCode: sharedBag, sealSerial: sealB.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-cls4-b-${rid()}`,
    });

    // 1. Delayed first container scan captured during Shift 1 -> resolves Order A on Shift 1 (never Shift 2)
    const delayedBase = {
      clientEventId: rid(),
      deviceId,
      scannedType: "container" as const,
      scannedId: sharedBag,
      capturedAt: capturedInShift1.toISOString(),
      context: { orderId: f.orderId },
    };
    const delayedSync = await syncScanEvents(db, f.courier, [{
      ...delayedBase,
      payloadHash: canonicalScanHash(delayedBase),
    }]);
    expect(delayedSync.accepted).toEqual([delayedBase.clientEventId]);

    const adjRows = await db.select().from(shiftReconciliationAdjustments)
      .where(eq(shiftReconciliationAdjustments.shiftId, s1.shiftId));
    expect(adjRows).toHaveLength(1);
    expect(adjRows[0].deltaAccepted).toBe(1);

    // 2. Forged context.orderId (claiming Order B for a scan captured during Order A's Shift 1 window) -> CONTEXT_ORDER_MISMATCH
    const forgedCtxBase = {
      clientEventId: rid(),
      deviceId,
      scannedType: "container" as const,
      scannedId: sharedBag,
      capturedAt: capturedInShift1.toISOString(),
      context: { orderId: orderB.id },
    };
    const forgedCtxSync = await syncScanEvents(db, f.courier, [{
      ...forgedCtxBase,
      payloadHash: canonicalScanHash(forgedCtxBase),
    }]);
    expect(forgedCtxSync.rejected).toEqual([
      { clientEventId: forgedCtxBase.clientEventId, reason: "CONTEXT_ORDER_MISMATCH" },
    ]);

    // 3. Out-of-window scan (between Shift 1 delivery/close and Order B intake) -> CONTAINER_NOT_ASSIGNED
    const outOfWinBase = {
      clientEventId: rid(),
      deviceId,
      scannedType: "container" as const,
      scannedId: sharedBag,
      capturedAt: afterShift1BeforeOrderB.toISOString(),
      context: {},
    };
    const outOfWinSync = await syncScanEvents(db, f.courier, [{
      ...outOfWinBase,
      payloadHash: canonicalScanHash(outOfWinBase),
    }]);
    expect(outOfWinSync.rejected).toEqual([
      { clientEventId: outOfWinBase.clientEventId, reason: "CONTAINER_NOT_ASSIGNED" },
    ]);

    // 4. Future capturedAt (> receivedAt + 60s) -> INVALID_CAPTURED_AT
    const futureBase = {
      clientEventId: rid(),
      deviceId,
      scannedType: "container" as const,
      scannedId: sharedBag,
      capturedAt: new Date(Date.now() + 120_000).toISOString(),
      context: {},
    };
    const futureSync = await syncScanEvents(db, f.courier, [{
      ...futureBase,
      payloadHash: canonicalScanHash(futureBase),
    }]);
    expect(futureSync.rejected).toEqual([
      { clientEventId: futureBase.clientEventId, reason: "INVALID_CAPTURED_AT" },
    ]);
  });

  // =========================================================================
  // CLS-002 partner-side: voidPartnerAccrualsForOrder after partial credit
  // =========================================================================

  it("CLS-002: voidPartnerAccrualsForOrder credits only remaining balance, resolves open disputes, and nets accrual quantity to zero", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "economy" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const bag = `BAG-CLS2-${rid().slice(0, 6)}`;

    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-cls2-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `rec-cls2-${rid()}`,
    });

    const inv = await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: `pinv-cls2-${rid()}`,
    });
    expect(inv.totalKopeks).toBe(600);

    const [invLine] = await db.select().from(partnerInvoiceLines)
      .where(eq(partnerInvoiceLines.invoiceId, inv.invoiceId));
    const disp1 = await disputePartnerLine(db, finance, {
      lineId: invLine.id,
      reason: "Частичная корректировка веса",
      key: `disp1-cls2-${rid()}`,
    });
    await resolvePartnerDispute(db, finance, {
      disputeId: disp1.disputeId,
      outcome: "partial",
      creditKopeks: 200,
      reason: "Согласован частичный кредит 200 коп.",
      key: `res1-cls2-${rid()}`,
    });

    // Open a second dispute that remains open when returnUnprocessedOrder runs
    const disp2 = await disputePartnerLine(db, finance, {
      lineId: invLine.id,
      reason: "Повторная проверка перед возвратом",
      key: `disp2-cls2-${rid()}`,
    });

    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-cls2-${rid()}` });
    const ret = await returnUnprocessedOrder(db, partner.principal, {
      orderId: f.orderId,
      reason: "Возврат после частичного кредита и открытого спора",
      key: `ret-cls2-${rid()}`,
    });
    expect(ret.state).toBe("ready");

    // Credit notes total = 200 (prior partial) + 400 (remaining) = 600
    const creditNotes = await db.select().from(partnerCreditNotes)
      .where(eq(partnerCreditNotes.originalLineId, invLine.id));
    expect(creditNotes).toHaveLength(2);
    expect(creditNotes.map(n => n.amountKopeks).sort((a, b) => a - b)).toEqual([200, 400]);

    // Line is 'credited', open dispute is 'resolved', accrual.disputed is false
    const [lineAfter] = await db.select().from(partnerInvoiceLines).where(eq(partnerInvoiceLines.id, invLine.id));
    expect(lineAfter.state).toBe("credited");
    const [disp2After] = await db.select().from(partnerDisputes).where(eq(partnerDisputes.id, disp2.disputeId));
    expect(disp2After.state).toBe("resolved");

    const accrualRows = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, partner.partnerId));
    expect(accrualRows.every(a => a.disputed === false)).toBe(true);
    expect(accrualRows.reduce((sumAmt, a) => sumAmt + a.amountKopeks, 0)).toBe(0);
    expect(accrualRows.reduce((sumQty, a) => sumQty + a.quantity, 0)).toBe(0);
  });

  // =========================================================================
  // LND-PRO-011 (service guard)
  // =========================================================================

  it("LND-PRO-011: proposeAdjustment rejects zero, negative, and non-integer deltaKopeks before withIdempotencyFlat", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = `BAG-011-${rid().slice(0, 6)}`;

    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `int-011-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
      key: `rec-011-${rid()}`,
    });
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-011-${rid()}` });

    for (const badDelta of [0, -100, 12.5]) {
      const badKey = `adj-bad-${badDelta}-${rid()}`;
      await expect(proposeAdjustment(db, partner.principal, {
        orderId: f.orderId,
        deltaKopeks: badDelta,
        reason: "Некорректная сумма",
        key: badKey,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "ADJUSTMENT_DELTA_INVALID" });

      // Rejected before withIdempotencyFlat -> zero idempotency_records rows written
      const idemRows = await db.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.organizationId, f.organizationId),
        eq(idempotencyRecords.key, badKey),
      ));
      expect(idemRows).toHaveLength(0);
    }

    expect(await db.select().from(orderAdjustments).where(eq(orderAdjustments.orderId, f.orderId))).toHaveLength(0);

    // Positive integer still succeeds
    const ok = await proposeAdjustment(db, partner.principal, {
      orderId: f.orderId,
      deltaKopeks: 5_000,
      reason: "Доплата за пятновыведение",
      key: `adj-ok-${rid()}`,
    });
    expect(ok.state).toBe("awaiting_approval");
  });
});
