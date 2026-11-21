import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, isNull } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  batches, containerAssignments, containers, courierShifts, garments,
  idempotencyRecords, intakeManifests, orderAdjustments, orders, outboxEvents, processingOperations,
  qualityChecks, routes, routeStops, seals, serviceWindows,
} from "../../src/db/schema.js";
import { makePrincipal, seedAddress, seedCatalog, seedDeliveryWindow, seedUser, seedWindow } from "../fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";
import { login, uniquePhone } from "./_fixtures.js";
import { createQuote } from "../../src/services/quotes.js";
import { createOrder, scheduleOrder } from "../../src/services/orders.js";
import { holdSlot } from "../../src/domain/slot-reservation.js";
import { recordIntake } from "../../src/services/intake.js";
import {
  arriveStop, assignDelivery, assignPickup, closeOrder, currentCourierStops, recordDeliveryAttempt,
} from "../../src/services/delivery.js";
import {
  decideAdjustment, partnerWorkspace, proposeAdjustment, receiveHandoff, recordQualityCheck,
  returnUnprocessedOrder, startInspection, startProcessing,
} from "../../src/services/partner.js";

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
  // LND-PRO-002
  // =========================================================================

  it("LND-PRO-002: requires processingOperations after approve_change and rewash before QC, updates batch state, and surfaces workspace flag", async () => {
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

    // Workspace shows hasUncheckedProcessing === false
    const wsBefore = await partnerWorkspace(db, partner.principal);
    expect(wsBefore.orders.find(o => o.orderId === f.orderId)?.hasUncheckedProcessing).toBe(false);

    // QC without startProcessing MUST fail with PROCESSING_OPERATION_REQUIRED and leave zero QC rows
    await expect(recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: true }],
      key: `qc-blocked-1-${rid()}`,
    })).rejects.toMatchObject({ message: "PROCESSING_OPERATION_REQUIRED" });
    expect(await db.select().from(qualityChecks).where(eq(qualityChecks.orderId, f.orderId))).toHaveLength(0);

    // startProcessing in 'processing' state creates batch + processingOperations with orderId in detailsJson
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
    expect((ops1[0].detailsJson as { orderId?: string }).orderId).toBe(f.orderId);

    const wsReadyQc = await partnerWorkspace(db, partner.principal);
    expect(wsReadyQc.orders.find(o => o.orderId === f.orderId)?.hasUncheckedProcessing).toBe(true);

    // QC fail -> rewash ('processing'), batch remains 'processing', workspace flag resets to false
    const qcFail = await recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: false, note: "Пятно осталось" }],
      key: `qc-fail-002-${rid()}`,
    });
    expect(qcFail.state).toBe("processing");
    const [batchAfterFail] = await db.select().from(batches).where(eq(batches.id, proc1.batchId));
    expect(batchAfterFail.state).toBe("processing");

    const wsAfterFail = await partnerWorkspace(db, partner.principal);
    expect(wsAfterFail.orders.find(o => o.orderId === f.orderId)?.hasUncheckedProcessing).toBe(false);

    // Second QC without a new processing batch MUST be rejected
    await expect(recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: true }],
      key: `qc-blocked-2-${rid()}`,
    })).rejects.toMatchObject({ message: "PROCESSING_OPERATION_REQUIRED" });

    // Start rewash batch, then pass QC -> order 'ready', batch 'packed'
    const proc2 = await startProcessing(db, partner.principal, {
      orderId: f.orderId,
      processType: "dry_clean",
      key: `proc2-002-${rid()}`,
    });
    const qcPass = await recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [{ garmentId, passed: true, note: "Чисто" }],
      key: `qc-pass-002-${rid()}`,
    });
    expect(qcPass.state).toBe("ready");
    const [batchAfterPass] = await db.select().from(batches).where(eq(batches.id, proc2.batchId));
    expect(batchAfterPass.state).toBe("packed");
  });

  // =========================================================================
  // LND-PRO-003
  // =========================================================================

  it("LND-PRO-003: propagates confirmed reservation windows into routeStops and enforces overlap only on opt-in", async () => {
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
    await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], bagPassed: true, key: `qc-003-${rid()}` });

    // Opt-in enforceShiftWindowOverlap rejects non-overlapping shift for delivery window
    await expect(assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      enforceShiftWindowOverlap: true,
      key: `ad-strict-${rid()}`,
    })).rejects.toMatchObject({ message: "SHIFT_WINDOW_MISMATCH" });

    // Without enforceShiftWindowOverlap, assignDelivery succeeds, populates delivery reservation window,
    // and records shiftWindowMismatch: true in event payload
    const delAssigned = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      key: `ad-default-${rid()}`,
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
    expect((delEvent.payloadJson as { shiftWindowMismatch?: boolean }).shiftWindowMismatch).toBe(true);

    // Explicit override populates custom window and records windowOverridden: true
    const customStart = new Date("2026-12-01T14:00:00.000Z");
    const customEnd = new Date("2026-12-01T16:00:00.000Z");
    const delOverride = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      windowStart: customStart,
      windowEnd: customEnd,
      enforceShiftWindowOverlap: true,
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
  // LND-PRO-004
  // =========================================================================

  it("LND-PRO-004: retires containerAssignments on outbound repacking, delivery, closure, and unprocessed return", async () => {
    // 1. Outbound repacking on QC pass -> partnerWorkspace shows only active outbound -> delivery retires it -> reusable
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
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

    // 2. returnUnprocessedOrder retires active containerAssignments
    const f2 = await seedFullOrder(db, { state: "pickup_assigned" });
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

    const activeAfterRet = await db.select().from(containerAssignments).where(and(
      eq(containerAssignments.orderId, f2.orderId),
      isNull(containerAssignments.unassignedAt),
    ));
    expect(activeAfterRet).toHaveLength(0);
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
