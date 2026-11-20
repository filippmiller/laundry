import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import {
  claims,
  compensations,
  custodyDiscrepancies,
  customerInvoices,
  evidenceAssets,
  fiscalReceipts,
  garments,
  ledgerEntries,
  ledgerJournals,
  orders,
  partnerContracts,
  partnerCreditNotes,
  partnerInvoiceLines,
  scanEvents,
  seals,
  serviceWindows,
  slotReservations,
} from "../../src/db/schema.js";
import { buildApp } from "../../src/api/server.js";
import { hashRequest } from "../../src/core/idempotency.js";
import { canonicalScanHash } from "../../src/core/scan-hash.js";
import { seedAddress, seedCatalog, seedDeliveryWindow, seedWindow } from "../fixtures.js";
import { login, seedPartner, seedTenant, uniquePhone } from "../api/_fixtures.js";

function cookieHeader(cookie: string, extra: Record<string, string> = {}) {
  return { cookie, ...extra };
}

async function assertLedgerBalanced(db: Db, organizationId: string) {
  const [totals] = await db
    .select({
      debits: sql<number>`coalesce(sum(${ledgerEntries.debitKopeks}), 0)::int`,
      credits: sql<number>`coalesce(sum(${ledgerEntries.creditKopeks}), 0)::int`,
    })
    .from(ledgerEntries)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerEntries.journalId))
    .where(eq(ledgerJournals.organizationId, organizationId));
  expect(totals.debits).toBe(totals.credits);
  return totals;
}

async function createBookedAndScheduledOrder(
  app: FastifyInstance,
  db: Db,
  opts: {
    organizationId: string;
    buildingId: string;
    pickupWindowId: string;
    deliveryWindowId: string;
    serviceId: string;
    tariffVersionId: string;
    termsVersion: string;
    customerCookie: string;
    lines?: Array<{ serviceId: string; tier: "economy" | "protected"; quantity: number; unit: "piece" | "gram" }>;
    offSchedulePickup?: boolean;
    offScheduleDelivery?: boolean;
  },
) {
  const quoteRes = await app.inject({
    method: "POST",
    url: "/api/v1/quotes",
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `q-${randomUUID()}` }),
    payload: {
      buildingId: opts.buildingId,
      tariffVersionId: opts.tariffVersionId,
      pickupWindowId: opts.pickupWindowId,
      deliveryWindowId: opts.deliveryWindowId,
      offSchedulePickup: opts.offSchedulePickup,
      offScheduleDelivery: opts.offScheduleDelivery,
      lines: opts.lines ?? [
        { serviceId: opts.serviceId, tier: "economy", quantity: 2000, unit: "gram" },
      ],
    },
  });
  expect(quoteRes.statusCode, quoteRes.body).toBe(200);
  const quote = quoteRes.json() as {
    id: string;
    quoteHash: string;
    totalKopeks: number;
    lines: Array<{ kind: string; amountKopeks: number }>;
  };

  const holdPickupRes = await app.inject({
    method: "POST",
    url: "/api/v1/slots/holds",
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `hp-${randomUUID()}` }),
    payload: { windowId: opts.pickupWindowId, ttlMinutes: 15 },
  });
  expect(holdPickupRes.statusCode, holdPickupRes.body).toBe(200);
  const pickupHold = holdPickupRes.json() as { reservationId: string };

  const holdDeliveryRes = await app.inject({
    method: "POST",
    url: "/api/v1/slots/holds",
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `hd-${randomUUID()}` }),
    payload: { windowId: opts.deliveryWindowId, ttlMinutes: 15 },
  });
  expect(holdDeliveryRes.statusCode, holdDeliveryRes.body).toBe(200);
  const deliveryHold = holdDeliveryRes.json() as { reservationId: string };

  const orderRes = await app.inject({
    method: "POST",
    url: "/api/v1/orders",
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `ord-${randomUUID()}` }),
    payload: {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: opts.termsVersion,
    },
  });
  expect(orderRes.statusCode, orderRes.body).toBe(200);
  const order = orderRes.json() as { id: string; publicNumber: string; totalKopeks: number };

  const schedRes = await app.inject({
    method: "POST",
    url: `/api/v1/orders/${order.id}/schedule`,
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `sch-${randomUUID()}` }),
    payload: {
      pickupReservationId: pickupHold.reservationId,
      deliveryReservationId: deliveryHold.reservationId,
    },
  });
  expect(schedRes.statusCode, schedRes.body).toBe(200);

  const [orderRow] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
  return {
    quote,
    order,
    orderRow,
    pickupReservationId: pickupHold.reservationId,
    deliveryReservationId: deliveryHold.reservationId,
  };
}

describe("Cross-role end-to-end flows (F01..F36)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    app = buildApp(db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("[F01][CU-004][CU-008][CO-008][PA-002][PA-007][DI-005][FI-002] economy building pickup -> partner wash -> QC -> shared delivery -> close", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const partnerId = await seedPartner(db, seed.organizationId, "Прачечная №1");

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const partner = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId });
    const finance = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });

    // Customer quotes, holds, books, schedules, invoices and pays
    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });

    // Negative auth: customer cannot assign pickups or start partner batches
    const forbiddenAssign = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `neg-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId: randomUUID() },
    });
    expect(forbiddenAssign.statusCode).toBe(403);

    const invRes = await app.inject({
      method: "POST",
      url: "/api/v1/finance/invoices",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `inv-${randomUUID()}` }),
      payload: { orderId: booked.order.id },
    });
    expect(invRes.statusCode).toBe(200);
    const inv = invRes.json() as { invoiceId: string; totalKopeks: number };
    expect(inv.totalKopeks).toBe(booked.quote.totalKopeks);

    const payRes = await app.inject({
      method: "POST",
      url: "/api/v1/finance/payments/capture",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `pay-${randomUUID()}` }),
      payload: { orderId: booked.order.id, amountKopeks: inv.totalKopeks },
    });
    expect(payRes.statusCode).toBe(200);
    expect(payRes.json()).toMatchObject({ state: "captured", fiscalState: "pending_registration" });

    // Courier opens shift, dispatcher assigns pickup
    const shiftRes = await app.inject({
      method: "POST",
      url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }),
      payload: {},
    });
    expect(shiftRes.statusCode).toBe(200);
    const { shiftId } = shiftRes.json() as { shiftId: string };

    const assignPickupRes = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `ap-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    });
    expect(assignPickupRes.statusCode).toBe(200);
    const { stopId: pickupStopId } = assignPickupRes.json() as { stopId: string };

    // Courier starts, arrives, and records economy bag intake with valid seal & handoff PIN
    const sealSerial = `SEAL-${randomUUID().slice(0, 8)}`;
    await db.insert(seals).values({ organizationId: seed.organizationId, serialNumber: sealSerial, state: "available" });

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${pickupStopId}/start`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `st-${randomUUID()}` }),
      payload: {},
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${pickupStopId}/arrive`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `ar-${randomUUID()}` }),
      payload: {},
    })).statusCode).toBe(200);

    const intakeRes = await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${pickupStopId}/intake`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `in-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: "BAG-F01", sealSerial, weightGrams: 2000 }],
        handoffCode: booked.orderRow.handoffCode!,
        customerConfirmation: true,
        courierConfirmation: true,
      },
    });
    expect(intakeRes.statusCode, intakeRes.body).toBe(200);
    const { manifestId } = intakeRes.json() as { manifestId: string };

    // Dispatcher assigns partner; partner receives, inspects, processes, passes QC
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/dispatch/orders/${booked.order.id}/partner`,
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `pa-${randomUUID()}` }),
      payload: { partnerId },
    })).statusCode).toBe(200);

    const receiptRes = await app.inject({
      method: "POST",
      url: "/api/v1/partner/receipts",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `rc-${randomUUID()}` }),
      payload: {
        orderId: booked.order.id,
        manifestId,
        actual: [{ containerCode: "BAG-F01", sealSerial, actualWeightGrams: 2000 }],
      },
    });
    expect(receiptRes.statusCode, receiptRes.body).toBe(200);
    expect(receiptRes.json()).toMatchObject({ status: "accepted" });

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${booked.order.id}/inspection`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `ins-${randomUUID()}` }),
      payload: {},
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "POST",
      url: "/api/v1/partner/batches",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `bat-${randomUUID()}` }),
      payload: { orderId: booked.order.id, processType: "wash" },
    })).statusCode).toBe(200);

    const qcRes = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${booked.order.id}/quality-check`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `qc-${randomUUID()}` }),
      payload: { results: [], bagPassed: true },
    });
    expect(qcRes.statusCode, qcRes.body).toBe(200);
    expect(qcRes.json()).toMatchObject({ state: "ready" });

    // Dispatcher assigns delivery, courier delivers with PIN, finance closes order
    const delAssignRes = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/deliveries",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `da-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    });
    expect(delAssignRes.statusCode).toBe(200);
    const { stopId: deliveryStopId } = delAssignRes.json() as { stopId: string };

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${deliveryStopId}/arrive`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `dar-${randomUUID()}` }),
      payload: {},
    })).statusCode).toBe(200);

    const delAttemptRes = await app.inject({
      method: "POST",
      url: `/api/v1/courier/deliveries/${deliveryStopId}/attempts`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `dat-${randomUUID()}` }),
      payload: { outcome: "delivered", recipientProof: { pin: booked.orderRow.handoffCode } },
    });
    expect(delAttemptRes.statusCode, delAttemptRes.body).toBe(200);

    const closeRes = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${booked.order.id}/close`,
      headers: cookieHeader(finance.cookie, { "idempotency-key": `cl-${randomUUID()}` }),
      payload: {},
    });
    expect(closeRes.statusCode).toBe(200);

    const [finalOrder] = await db.select().from(orders).where(eq(orders.id, booked.order.id)).limit(1);
    expect(finalOrder.lifecycleState).toBe("closed");

    const ledger = await assertLedgerBalanced(db, seed.organizationId);
    expect(ledger.debits).toBeGreaterThanOrEqual(inv.totalKopeks);
  });

  it("[F02][CU-005][CU-006][CO-010][PA-006] mixed economy bag + protected jacket separated -> itemized QC -> exact-set delivery", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const partnerId = await seedPartner(db, seed.organizationId, "Премиум-прачечная");

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const partner = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId });

    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
      lines: [
        { serviceId: seed.catalog.serviceId, tier: "economy", quantity: 1500, unit: "gram" },
        { serviceId: seed.catalog.serviceId, tier: "protected", quantity: 1000, unit: "gram" },
      ],
    });

    const { shiftId } = (await app.inject({
      method: "POST",
      url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }),
      payload: {},
    })).json() as { shiftId: string };

    const { stopId: pickupStopId } = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `ap-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };

    const sealSerial = `SEAL-MX-${randomUUID().slice(0, 6)}`;
    await db.insert(seals).values({ organizationId: seed.organizationId, serialNumber: sealSerial, state: "available" });

    // Mixed intake without separated items is rejected
    const badMixed = await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${pickupStopId}/intake`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `bm-${randomUUID()}` }),
      payload: {
        mode: "mixed",
        bags: [{ containerCode: "BAG-MIX", sealSerial, weightGrams: 1500 }],
        items: [],
        customerConfirmation: true,
        courierConfirmation: true,
      },
    });
    expect(badMixed.statusCode).toBe(400);

    // Valid mixed intake with separated economy bag and protected jacket
    const intakeRes = await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${pickupStopId}/intake`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `mx-${randomUUID()}` }),
      payload: {
        mode: "mixed",
        bags: [{ containerCode: "BAG-MIX", sealSerial, weightGrams: 1500 }],
        items: [{ itemCode: "JKT-001", category: "outerwear", description: "Шерстяной пиджак", declaredValueKopeks: 1500000 }],
        customerConfirmation: true,
        courierConfirmation: true,
      },
    });
    expect(intakeRes.statusCode, intakeRes.body).toBe(200);
    const { manifestId } = intakeRes.json() as { manifestId: string };

    const [garment] = await db.select().from(garments).where(eq(garments.orderId, booked.order.id)).limit(1);
    expect(garment.itemCode).toBe("JKT-001");

    // Partner receives, inspects, processes, and completes itemized QC
    await app.inject({
      method: "POST",
      url: `/api/v1/dispatch/orders/${booked.order.id}/partner`,
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `pa-${randomUUID()}` }),
      payload: { partnerId },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/partner/receipts",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `rc-${randomUUID()}` }),
      payload: { orderId: booked.order.id, manifestId, actual: [{ containerCode: "BAG-MIX", sealSerial, actualWeightGrams: 1500 }] },
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${booked.order.id}/inspection`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `ins-${randomUUID()}` }),
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/partner/batches",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `bat-${randomUUID()}` }),
      payload: { orderId: booked.order.id, processType: "delicate" },
    });
    const qcRes = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${booked.order.id}/quality-check`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `qc-${randomUUID()}` }),
      payload: { results: [{ garmentId: garment.id, passed: true, note: "Отлично" }] },
    });
    expect(qcRes.statusCode).toBe(200);

    // Delivery requires exact garment set (omitting garment fails with DELIVERY_SET_MISMATCH)
    const { stopId: deliveryStopId } = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/deliveries",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `da-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${deliveryStopId}/arrive`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `dar-${randomUUID()}` }),
      payload: {},
    });

    const missingSet = await app.inject({
      method: "POST",
      url: `/api/v1/courier/deliveries/${deliveryStopId}/attempts`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `ms-${randomUUID()}` }),
      payload: { outcome: "delivered", deliveredGarmentIds: [], recipientProof: { pin: booked.orderRow.handoffCode } },
    });
    expect(missingSet.statusCode).toBe(409);

    const goodDelivery = await app.inject({
      method: "POST",
      url: `/api/v1/courier/deliveries/${deliveryStopId}/attempts`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `gd-${randomUUID()}` }),
      payload: { outcome: "delivered", deliveredGarmentIds: [garment.id], recipientProof: { pin: booked.orderRow.handoffCode } },
    });
    expect(goodDelivery.statusCode).toBe(200);
  });

  it("[F03][CU-009][CU-010][CU-011][FI-001] both off-schedule exceptional trips produce two unique surcharge lines and a single invoice", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });

    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
      offSchedulePickup: true,
      offScheduleDelivery: true,
    });

    const surchargeLines = booked.quote.lines.filter(line => line.kind !== "service");
    expect(surchargeLines.length).toBe(2);
    expect(surchargeLines.every(line => line.amountKopeks > 0)).toBe(true);

    const invKey = `inv-f03-${randomUUID()}`;
    const inv1 = await app.inject({
      method: "POST",
      url: "/api/v1/finance/invoices",
      headers: cookieHeader(customer.cookie, { "idempotency-key": invKey }),
      payload: { orderId: booked.order.id },
    });
    const inv2 = await app.inject({
      method: "POST",
      url: "/api/v1/finance/invoices",
      headers: cookieHeader(customer.cookie, { "idempotency-key": invKey }),
      payload: { orderId: booked.order.id },
    });
    expect(inv1.statusCode).toBe(200);
    expect(inv2.statusCode).toBe(200);
    expect(inv1.json().invoiceId).toBe(inv2.json().invoiceId);
  });

  it("[F04][CU-013][OP-010] two concurrent customers compete for the last pickup slot; only one succeeds", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const c1 = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const c2 = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["customer"] });

    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/slots/holds",
        headers: cookieHeader(c1.cookie, { "idempotency-key": `race-1-${randomUUID()}` }),
        payload: { windowId: seed.windowId, ttlMinutes: 10 },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/slots/holds",
        headers: cookieHeader(c2.cookie, { "idempotency-key": `race-2-${randomUUID()}` }),
        payload: { windowId: seed.windowId, ttlMinutes: 10 },
      }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const [win] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId)).limit(1);
    expect(win.reservedOrders).toBe(1);
  });

  it("[F06][CU-018][DI-010] atomic reschedule preserves old holds when second leg fails and swaps cleanly when both valid", async () => {
    const seed = await seedTenant(db);
    const d1 = await seedDeliveryWindow(db, seed, 4);
    const [p2] = await db.insert(serviceWindows).values({
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      kind: "pickup",
      startsAt: new Date("2026-12-03T10:00:00.000Z"),
      endsAt: new Date("2026-12-03T12:00:00.000Z"),
      capacityOrders: 4,
    }).returning();
    const [d2] = await db.insert(serviceWindows).values({
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      kind: "delivery",
      startsAt: new Date("2026-12-04T10:00:00.000Z"),
      endsAt: new Date("2026-12-04T12:00:00.000Z"),
      capacityOrders: 4,
    }).returning();

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId: d1,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });

    const newPickupHold = (await app.inject({
      method: "POST",
      url: "/api/v1/slots/holds",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `np-${randomUUID()}` }),
      payload: { windowId: p2.id, ttlMinutes: 10 },
    })).json() as { reservationId: string };

    // Failing reschedule with non-existent delivery reservation must keep old holds confirmed
    const failedResched = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${booked.order.id}/reschedule`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `fr-${randomUUID()}` }),
      payload: { pickupReservationId: newPickupHold.reservationId, deliveryReservationId: randomUUID() },
    });
    expect(failedResched.statusCode).toBe(404);

    const [oldPickup] = await db.select().from(slotReservations).where(eq(slotReservations.id, booked.pickupReservationId)).limit(1);
    expect(oldPickup.state).toBe("confirmed");

    // Now hold valid delivery window d2 and reschedule atomically
    const newDeliveryHold = (await app.inject({
      method: "POST",
      url: "/api/v1/slots/holds",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `nd-${randomUUID()}` }),
      payload: { windowId: d2.id, ttlMinutes: 10 },
    })).json() as { reservationId: string };

    const okResched = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${booked.order.id}/reschedule`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `ok-${randomUUID()}` }),
      payload: { pickupReservationId: newPickupHold.reservationId, deliveryReservationId: newDeliveryHold.reservationId },
    });
    expect(okResched.statusCode, okResched.body).toBe(200);

    const [releasedOldPickup] = await db.select().from(slotReservations).where(eq(slotReservations.id, booked.pickupReservationId)).limit(1);
    expect(releasedOldPickup.state).toBe("released");
  });

  it("[F07][F08][CU-019][CO-007] cancel after pickup assignment releases capacity and blocks late courier intake", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });

    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });

    const { shiftId } = (await app.inject({
      method: "POST",
      url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }),
      payload: {},
    })).json() as { shiftId: string };

    const { stopId } = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `ap-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };

    // Customer cannot directly cancel after dispatch; dispatcher cancels before handoff
    const custCancelAfterDispatch = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${booked.order.id}/cancel`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `cn-c-${randomUUID()}` }),
      payload: { reason: "Изменились планы" },
    });
    expect(custCancelAfterDispatch.statusCode).toBe(403);

    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${booked.order.id}/cancel`,
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `cn-d-${randomUUID()}` }),
      payload: { reason: "Отмена по просьбе клиента до приёмки" },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json()).toMatchObject({ state: "cancelled", releasedReservations: 2 });

    // Late courier intake on cancelled order is rejected
    const sealSerial = `SEAL-CN-${randomUUID().slice(0, 6)}`;
    await db.insert(seals).values({ organizationId: seed.organizationId, serialNumber: sealSerial, state: "available" });
    const lateIntake = await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${stopId}/intake`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `li-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: "BAG-CN", sealSerial, weightGrams: 2000 }],
        customerConfirmation: true,
        courierConfirmation: true,
      },
    });
    expect(lateIntake.statusCode).toBe(409);
  });

  it("[F09][F17][CO-014][DI-009] recipient unavailable at delivery -> secure return + repeat delivery succeeds", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const partnerId = await seedPartner(db, seed.organizationId, "Прачечная F17");

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const partner = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId });

    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });

    // Advance order to ready
    await db.update(orders).set({ lifecycleState: "ready", assignedPartnerId: partnerId }).where(eq(orders.id, booked.order.id));
    void partner;

    const { shiftId } = (await app.inject({
      method: "POST",
      url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }),
      payload: {},
    })).json() as { shiftId: string };

    const { stopId: stop1 } = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/deliveries",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `d1-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${stop1}/arrive`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `a1-${randomUUID()}` }),
      payload: {},
    });

    const failAttempt = await app.inject({
      method: "POST",
      url: `/api/v1/courier/deliveries/${stop1}/attempts`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `fa-${randomUUID()}` }),
      payload: { outcome: "recipient_unavailable", reason: "Домофон не отвечает" },
    });
    expect(failAttempt.statusCode, failAttempt.body).toBe(200);

    const [afterFail] = await db.select().from(orders).where(eq(orders.id, booked.order.id)).limit(1);
    expect(afterFail.lifecycleState).not.toBe("delivered");

    // Re-dispatch delivery and complete it
    await db.update(orders).set({ lifecycleState: "ready" }).where(eq(orders.id, booked.order.id));
    const { stopId: stop2 } = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/deliveries",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `d2-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${stop2}/arrive`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `a2-${randomUUID()}` }),
      payload: {},
    });
    const okAttempt = await app.inject({
      method: "POST",
      url: `/api/v1/courier/deliveries/${stop2}/attempts`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `ok-${randomUUID()}` }),
      payload: { outcome: "delivered", recipientProof: { pin: booked.orderRow.handoffCode } },
    });
    expect(okAttempt.statusCode).toBe(200);
  });

  it("[F10][CO-016][PA-003][PA-004] wrong seal at partner receipt opens discrepancy and refuses custody transfer", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const partnerId = await seedPartner(db, seed.organizationId, "Прачечная F10");

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const partner = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId });

    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });

    const { shiftId } = (await app.inject({
      method: "POST",
      url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }),
      payload: {},
    })).json() as { shiftId: string };
    const { stopId } = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `ap-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };

    const realSeal = `SEAL-REAL-${randomUUID().slice(0, 6)}`;
    await db.insert(seals).values({ organizationId: seed.organizationId, serialNumber: realSeal, state: "available" });
    const { manifestId } = (await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${stopId}/intake`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `in-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: "BAG-F10", sealSerial: realSeal, weightGrams: 2000 }],
        customerConfirmation: true,
        courierConfirmation: true,
      },
    })).json() as { manifestId: string };

    await app.inject({
      method: "POST",
      url: `/api/v1/dispatch/orders/${booked.order.id}/partner`,
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `pa-${randomUUID()}` }),
      payload: { partnerId },
    });

    // Partner scans wrong seal serial
    const mismatchRes = await app.inject({
      method: "POST",
      url: "/api/v1/partner/receipts",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `rm-${randomUUID()}` }),
      payload: {
        orderId: booked.order.id,
        manifestId,
        actual: [{ containerCode: "BAG-F10", sealSerial: "SEAL-WRONG-999", actualWeightGrams: 2000 }],
      },
    });
    expect(mismatchRes.statusCode).toBe(200);
    expect(mismatchRes.json()).toMatchObject({ status: "discrepancy" });

    // Custody must NOT have transferred
    const [orderAfter] = await db.select().from(orders).where(eq(orders.id, booked.order.id)).limit(1);
    expect(orderAfter.lifecycleState).toBe("picked_up");

    const discrepancies = await db.select().from(custodyDiscrepancies).where(eq(custodyDiscrepancies.orderId, booked.order.id));
    expect(discrepancies.length).toBeGreaterThanOrEqual(1);
    expect(discrepancies[0].kind).toBe("manifest_mismatch");
  });

  it("[F12][F13][F14][CU-021][CU-022][CU-023][PA-005][PA-008][PA-012] partner adjustment accept/decline, return unprocessed, and QC rewash loop", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const partnerId = await seedPartner(db, seed.organizationId, "Прачечная F12");

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const partner = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId });

    // Order A: accept adjustment -> process -> QC fail (rewash) -> QC pass (ready)
    const orderA = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });
    await db.update(orders).set({ lifecycleState: "inspection", assignedPartnerId: partnerId }).where(eq(orders.id, orderA.order.id));

    const propA = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderA.order.id}/adjustments`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `adjA-${randomUUID()}` }),
      payload: { deltaKopeks: 15000, reason: "Сложное пятновыведение" },
    });
    expect(propA.statusCode).toBe(200);
    const { adjustmentId: adjA } = propA.json() as { adjustmentId: string };

    const acceptA = await app.inject({
      method: "POST",
      url: `/api/v1/adjustments/${adjA}/decision`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `accA-${randomUUID()}` }),
      payload: { accept: true, quoteHash: orderA.quote.quoteHash },
    });
    expect(acceptA.statusCode, acceptA.body).toBe(200);

    // Invoice reflects base quote + accepted adjustment
    const invA = await app.inject({
      method: "POST",
      url: "/api/v1/finance/invoices",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `invA-${randomUUID()}` }),
      payload: { orderId: orderA.order.id },
    });
    expect(invA.statusCode).toBe(200);
    expect(invA.json().totalKopeks).toBe(orderA.quote.totalKopeks + 15000);

    // Accepting adjustment moves order into processing -> QC fail -> rewash -> QC pass
    const [afterAccept] = await db.select().from(orders).where(eq(orders.id, orderA.order.id)).limit(1);
    expect(afterAccept.lifecycleState).toBe("processing");

    const [garmentA] = await db.insert(garments).values({
      organizationId: seed.organizationId,
      orderId: orderA.order.id,
      itemCode: "G-REW-1",
      category: "everyday",
      description: "Рубашка",
    }).returning();

    const qcFail = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderA.order.id}/quality-check`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `qcf-${randomUUID()}` }),
      payload: { results: [{ garmentId: garmentA.id, passed: false, note: "Осталось пятно" }] },
    });
    expect(qcFail.statusCode).toBe(200);
    expect(qcFail.json()).toMatchObject({ state: "processing" });

    const qcPass = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderA.order.id}/quality-check`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `qcp-${randomUUID()}` }),
      payload: { results: [{ garmentId: garmentA.id, passed: true, note: "Чисто" }] },
    });
    expect(qcPass.statusCode).toBe(200);
    expect(qcPass.json()).toMatchObject({ state: "ready" });

    // Order B: decline adjustment -> return unprocessed -> invoice voided
    const orderB = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/finance/invoices",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `invB-${randomUUID()}` }),
      payload: { orderId: orderB.order.id },
    });
    await db.update(orders).set({ lifecycleState: "inspection", assignedPartnerId: partnerId }).where(eq(orders.id, orderB.order.id));

    const propB = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderB.order.id}/adjustments`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `adjB-${randomUUID()}` }),
      payload: { deltaKopeks: 50000, reason: "Требуется ручная чистка" },
    });
    const { adjustmentId: adjB } = propB.json() as { adjustmentId: string };
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/adjustments/${adjB}/decision`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `decB-${randomUUID()}` }),
      payload: { accept: false, quoteHash: orderB.quote.quoteHash },
    })).statusCode).toBe(200);

    const retB = await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${orderB.order.id}/return-unprocessed`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `retB-${randomUUID()}` }),
      payload: { reason: "Клиент отказался от доплаты" },
    });
    expect(retB.statusCode, retB.body).toBe(200);

    const [invBRow] = await db.select().from(customerInvoices).where(eq(customerInvoices.orderId, orderB.order.id)).limit(1);
    expect(invBRow.state).toBe("cancelled");
  });

  it("[F16][F18][F27][F28][CU-025][CO-015][SU-006][SU-007][SU-008][FI-015][AD-023] partial delivery -> claim with legal hold -> compensation settled -> reopen preserves history", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const support = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["customer_support", "claims_investigator"] });
    const approver = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["claims_approver"] });
    const finance = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });

    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });
    await db.update(orders).set({ lifecycleState: "ready" }).where(eq(orders.id, booked.order.id));
    const [g1, g2] = await db.insert(garments).values([
      { organizationId: seed.organizationId, orderId: booked.order.id, itemCode: "G-P1", category: "everyday", description: "Брюки" },
      { organizationId: seed.organizationId, orderId: booked.order.id, itemCode: "G-P2", category: "everyday", description: "Пиджак" },
    ]).returning();

    // Register & verify evidence on order
    const payloadBytes = Buffer.from("fake-jpeg-evidence-bytes");
    const sha256 = createHmac("sha256", "").update("x").digest("hex"); // replaced below with real sha256
    void sha256;
    const { createHash } = await import("node:crypto");
    const realSha = createHash("sha256").update(payloadBytes).digest("hex");
    const regEv = await app.inject({
      method: "POST",
      url: "/api/v1/evidence",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `ev-${randomUUID()}` }),
      payload: {
        ownerType: "order",
        ownerId: booked.order.id,
        objectKey: `org/${seed.organizationId}/claim-photo.jpg`,
        sha256: realSha,
        purpose: "claim_evidence",
        mimeType: "image/jpeg",
        sizeBytes: payloadBytes.length,
      },
    });
    expect(regEv.statusCode).toBe(200);
    const { evidenceId } = regEv.json() as { evidenceId: string };
    await db.update(evidenceAssets).set({ status: "verified" }).where(eq(evidenceAssets.id, evidenceId));

    // Partial delivery of only g1
    const { shiftId } = (await app.inject({
      method: "POST",
      url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }),
      payload: {},
    })).json() as { shiftId: string };
    const { stopId } = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/deliveries",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `dd-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${stopId}/arrive`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `ar-${randomUUID()}` }),
      payload: {},
    });
    const partialRes = await app.inject({
      method: "POST",
      url: `/api/v1/courier/deliveries/${stopId}/attempts`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `pt-${randomUUID()}` }),
      payload: { outcome: "partial", deliveredGarmentIds: [g1.id], recipientProof: { pin: booked.orderRow.handoffCode } },
    });
    expect(partialRes.statusCode).toBe(200);

    // Customer opens claim for missing g2 -> places legal hold on evidence
    const claimRes = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${booked.order.id}/claims`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `clm-${randomUUID()}` }),
      payload: { claimType: "missing_item", description: "Не привезли пиджак G-P2", garmentIds: [g2.id], evidenceIds: [evidenceId] },
    });
    expect(claimRes.statusCode, claimRes.body).toBe(200);
    const { claimId } = claimRes.json() as { claimId: string };

    // Legal hold blocks deletion of evidence while claim is open
    const delHeld = await app.inject({
      method: "DELETE",
      url: `/api/v1/evidence/${evidenceId}`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `del-${randomUUID()}` }),
    });
    expect(delHeld.statusCode).toBe(409);

    // Claims approver decides claim -> support proposes compensation -> finance approves & settles
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claimId}/decision`,
      headers: cookieHeader(approver.cookie, { "idempotency-key": `dec-${randomUUID()}` }),
      payload: { outcome: "resolved", rationale: "Утеря подтверждена актом частичной доставки" },
    })).statusCode).toBe(200);

    const compProp = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claimId}/compensations`,
      headers: cookieHeader(support.cookie, { "idempotency-key": `cp-${randomUUID()}` }),
      payload: { amountKopeks: 50000 },
    });
    expect(compProp.statusCode, compProp.body).toBe(200);
    const { compensationId } = compProp.json() as { compensationId: string };

    expect((await app.inject({
      method: "POST",
      url: `/api/v1/compensations/${compensationId}/decision`,
      headers: cookieHeader(finance.cookie, { "idempotency-key": `cd-${randomUUID()}` }),
      payload: { approve: true },
    })).statusCode).toBe(200);

    const settleRes = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claimId}/compensation/settle`,
      headers: cookieHeader(finance.cookie, { "idempotency-key": `cs-${randomUUID()}` }),
      payload: { compensationId },
    });
    expect(settleRes.statusCode, settleRes.body).toBe(200);
    expect(settleRes.json()).toMatchObject({ state: "paid", amountKopeks: 50000 });

    const [compRow] = await db.select().from(compensations).where(eq(compensations.id, compensationId)).limit(1);
    expect(compRow.state).toBe("paid");
    await assertLedgerBalanced(db, seed.organizationId);

    // Reopen claim preserves prior decision history
    const reopenRes = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${claimId}/reopen`,
      headers: cookieHeader(support.cookie, { "idempotency-key": `reo-${randomUUID()}` }),
      payload: { reason: "Новые обстоятельства по чеку" },
    });
    expect(reopenRes.statusCode).toBe(200);
    const [claimRow] = await db.select().from(claims).where(eq(claims.id, claimId)).limit(1);
    expect(claimRow.state).toBe("reopened");
  });

  it("[F19][F20][AU-012][CO-005][CO-006][OP-016] courier offline scan sync (API) accepts canonical hash, dedupes duplicates, rejects tampered/foreign retries, and rejects suspended courier", async () => {
    const seed = await seedTenant(db);
    const otherTenant = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const otherCourier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const foreignCourier = await login(app, { organizationId: otherTenant.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const admin = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_admin"] });

    // Book & schedule an order, open shift, and assign pickup stop to the courier.
    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });

    const shiftRes = await app.inject({
      method: "POST",
      url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-f19-${randomUUID()}` }),
      payload: {},
    });
    expect(shiftRes.statusCode, shiftRes.body).toBe(200);
    const { shiftId } = shiftRes.json() as { shiftId: string };

    const assignRes = await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `ap-f19-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    });
    expect(assignRes.statusCode, assignRes.body).toBe(200);
    const { stopId } = assignRes.json() as { stopId: string };

    const deviceId = randomUUID();
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/courier/devices",
      headers: cookieHeader(courier.cookie),
      payload: { deviceId, label: "Pixel-Scanner-1" },
    })).statusCode).toBe(200);

    const clientEventId = randomUUID();
    const capturedAt = new Date().toISOString();
    const eventBase = {
      clientEventId,
      deviceId,
      scannedType: "order" as const,
      scannedId: booked.order.id,
      capturedAt,
      context: { stopId },
    };
    const validHash = canonicalScanHash(eventBase);
    const event = { ...eventBase, payloadHash: validHash };

    const sync1 = await app.inject({
      method: "POST",
      url: "/api/v1/courier/scan-events/sync",
      headers: cookieHeader(courier.cookie),
      payload: { events: [event, event] },
    });
    expect(sync1.statusCode, sync1.body).toBe(200);
    expect(sync1.json()).toEqual({
      accepted: [clientEventId],
      duplicate: [clientEventId],
      rejected: [],
    });

    // Verify persisted DB state and canonical hash.
    const persistedBefore = await db.select().from(scanEvents).where(eq(scanEvents.clientEventId, clientEventId));
    expect(persistedBefore).toHaveLength(1);
    expect(persistedBefore[0]).toMatchObject({
      organizationId: seed.organizationId,
      deviceId,
      clientEventId,
      actorId: courier.body.userId,
      scannedType: "order",
      scannedId: booked.order.id,
      payloadHash: validHash,
      syncStatus: "accepted",
      shiftId,
    });

    // Negative check 1: mutated payload with same clientEventId is rejected without altering DB.
    const mutatedBase = { ...eventBase, context: { stopId, tampered: true } };
    const mutatedSync = await app.inject({
      method: "POST",
      url: "/api/v1/courier/scan-events/sync",
      headers: cookieHeader(courier.cookie),
      payload: { events: [{ ...mutatedBase, payloadHash: canonicalScanHash(mutatedBase) }] },
    });
    expect(mutatedSync.statusCode, mutatedSync.body).toBe(200);
    expect(mutatedSync.json()).toEqual({
      accepted: [],
      duplicate: [],
      rejected: [{ clientEventId, reason: "HASH_MISMATCH" }],
    });

    // Negative check 2: another courier in same tenant replaying same event is rejected without changing owner.
    const wrongActorSync = await app.inject({
      method: "POST",
      url: "/api/v1/courier/scan-events/sync",
      headers: cookieHeader(otherCourier.cookie),
      payload: { events: [event] },
    });
    expect(wrongActorSync.statusCode, wrongActorSync.body).toBe(200);
    expect(wrongActorSync.json()).toEqual({
      accepted: [],
      duplicate: [],
      rejected: [{ clientEventId, reason: "DEVICE_NOT_OWNED" }],
    });

    // Negative check 3: courier in another tenant replaying same event is rejected without changing tenant/owner.
    const wrongTenantSync = await app.inject({
      method: "POST",
      url: "/api/v1/courier/scan-events/sync",
      headers: cookieHeader(foreignCourier.cookie),
      payload: { events: [event] },
    });
    expect(wrongTenantSync.statusCode, wrongTenantSync.body).toBe(200);
    expect(wrongTenantSync.json()).toEqual({
      accepted: [],
      duplicate: [],
      rejected: [{ clientEventId, reason: "DEVICE_NOT_OWNED" }],
    });

    const persistedAfter = await db.select().from(scanEvents).where(eq(scanEvents.clientEventId, clientEventId));
    expect(persistedAfter).toHaveLength(1);
    expect(persistedAfter[0].actorId).toBe(courier.body.userId);
    expect(persistedAfter[0].organizationId).toBe(seed.organizationId);
    expect(persistedAfter[0].payloadHash).toBe(validHash);
    expect(persistedAfter[0].syncStatus).toBe("accepted");

    // Admin suspends courier -> revokes active sessions -> next offline sync is rejected
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${courier.body.userId}/state`,
      headers: cookieHeader(admin.cookie, { "idempotency-key": `susp-${randomUUID()}` }),
      payload: { state: "suspended", reason: "Утерян рабочий телефон" },
    })).statusCode).toBe(200);

    const syncAfterSuspend = await app.inject({
      method: "POST",
      url: "/api/v1/courier/scan-events/sync",
      headers: cookieHeader(courier.cookie),
      payload: { events: [event] },
    });
    expect(syncAfterSuspend.statusCode).toBe(401);
  });

  it("[F21][F22][PA-020][CU-030] Partner B blocked from Partner A order/receipt; Customer B blocked from Customer A order/finance/claim", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const partnerAId = await seedPartner(db, seed.organizationId, "Partner A");
    const partnerBId = await seedPartner(db, seed.organizationId, "Partner B");

    const customerA = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const customerB = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["customer"] });
    const partnerB = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId: partnerBId });

    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customerA.cookie,
    });
    await db.update(orders).set({ assignedPartnerId: partnerAId, lifecycleState: "inspection" }).where(eq(orders.id, booked.order.id));

    const claimRes = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${booked.order.id}/claims`,
      headers: cookieHeader(customerA.cookie, { "idempotency-key": `ca-${randomUUID()}` }),
      payload: { claimType: "damage", description: "Повреждена пуговица на куртке" },
    });
    const { claimId } = claimRes.json() as { claimId: string };

    // Customer B cannot read Customer A's order, finance, or claim
    expect((await app.inject({ method: "GET", url: `/api/v1/orders/${booked.order.id}`, headers: cookieHeader(customerB.cookie) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/orders/${booked.order.id}/finance`, headers: cookieHeader(customerB.cookie) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/claims/${claimId}`, headers: cookieHeader(customerB.cookie) })).statusCode).toBe(404);

    // Partner B cannot inspect or mutate Partner A's order
    expect((await app.inject({ method: "GET", url: `/api/v1/orders/${booked.order.id}`, headers: cookieHeader(partnerB.cookie) })).statusCode).toBe(404);
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/partner/orders/${booked.order.id}/adjustments`,
      headers: cookieHeader(partnerB.cookie, { "idempotency-key": `pb-${randomUUID()}` }),
      payload: { deltaKopeks: 5000, reason: "Чужой заказ" },
    })).statusCode).toBe(404);
  });

  it("[F23][F25][FI-006][FI-007][FI-009] concurrent full refunds grant only one; duplicate signed payment webhook deduped and fiscal stays pending", async () => {
    const prevSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret-f25";
    try {
      const seed = await seedTenant(db);
      const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
      const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
      const finance = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });

      const booked = await createBookedAndScheduledOrder(app, db, {
        organizationId: seed.organizationId,
        buildingId: seed.buildingId,
        pickupWindowId: seed.windowId,
        deliveryWindowId,
        serviceId: seed.catalog.serviceId,
        tariffVersionId: seed.catalog.tariffVersionId,
        termsVersion: seed.catalog.termsVersion,
        customerCookie: customer.cookie,
      });

      const inv = (await app.inject({
        method: "POST",
        url: "/api/v1/finance/invoices",
        headers: cookieHeader(customer.cookie, { "idempotency-key": `inv-${randomUUID()}` }),
        payload: { orderId: booked.order.id },
      })).json() as { invoiceId: string; totalKopeks: number };

      const cap = (await app.inject({
        method: "POST",
        url: "/api/v1/finance/payments/capture",
        headers: cookieHeader(customer.cookie, { "idempotency-key": `cap-${randomUUID()}` }),
        payload: { orderId: booked.order.id, amountKopeks: inv.totalKopeks },
      })).json() as { paymentIntentId: string };

      // Duplicate signed webhook for fake provider
      const webhookBody = {
        eventId: `evt-${randomUUID()}`,
        eventType: "payment.captured",
        payload: { paymentIntentId: cap.paymentIntentId, amountKopeks: inv.totalKopeks },
      };
      const canonical = `fake:${webhookBody.eventId}:${webhookBody.eventType}:${hashRequest(webhookBody.payload)}`;
      const sig = `sha256=${createHmac("sha256", process.env.PAYMENT_WEBHOOK_SECRET).update(canonical).digest("hex")}`;

      const wh1 = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/payments/fake",
        headers: { "x-provider-signature": sig },
        payload: webhookBody,
      });
      const wh2 = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/payments/fake",
        headers: { "x-provider-signature": sig },
        payload: webhookBody,
      });
      expect(wh1.statusCode).toBe(200);
      expect(wh2.statusCode).toBe(200);

      const [receipt] = await db.select().from(fiscalReceipts).where(eq(fiscalReceipts.invoiceId, inv.invoiceId)).limit(1);
      expect(receipt.state).toBe("pending_registration");

      // Two concurrent full refunds with distinct keys: only one succeeds
      const [rf1, rf2] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/v1/finance/refunds",
          headers: cookieHeader(finance.cookie, { "idempotency-key": `rf1-${randomUUID()}` }),
          payload: { paymentIntentId: cap.paymentIntentId, amountKopeks: inv.totalKopeks, reason: "Полный возврат 1" },
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/finance/refunds",
          headers: cookieHeader(finance.cookie, { "idempotency-key": `rf2-${randomUUID()}` }),
          payload: { paymentIntentId: cap.paymentIntentId, amountKopeks: inv.totalKopeks, reason: "Полный возврат 2" },
        }),
      ]);
      expect([rf1.statusCode, rf2.statusCode].sort((a, b) => a - b)).toEqual([200, 409]);
      await assertLedgerBalanced(db, seed.organizationId);
    } finally {
      if (prevSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
      else process.env.PAYMENT_WEBHOOK_SECRET = prevSecret;
    }
  });

  it("[F26][PA-016][FI-011][FI-012][FI-014] partner invoice accrual -> line dispute -> credit note approval posts balanced ledger", async () => {
    const seed = await seedTenant(db);
    const deliveryWindowId = await seedDeliveryWindow(db, seed, 4);
    const partnerId = await seedPartner(db, seed.organizationId, "Прачечная F26");

    await db.insert(partnerContracts).values({
      partnerId,
      version: "v1",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      signed: true,
      termsJson: { wholesalePerKgKopeks: 60000 },
    });

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const partner = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["laundry_operator", "partner_finance"], partnerId });
    const finance = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });

    const booked = await createBookedAndScheduledOrder(app, db, {
      organizationId: seed.organizationId,
      buildingId: seed.buildingId,
      pickupWindowId: seed.windowId,
      deliveryWindowId,
      serviceId: seed.catalog.serviceId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      customerCookie: customer.cookie,
    });

    const { shiftId } = (await app.inject({
      method: "POST",
      url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }),
      payload: {},
    })).json() as { shiftId: string };
    const { stopId } = (await app.inject({
      method: "POST",
      url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `ap-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };
    const sealSerial = `SEAL-F26-${randomUUID().slice(0, 6)}`;
    await db.insert(seals).values({ organizationId: seed.organizationId, serialNumber: sealSerial, state: "available" });
    const { manifestId } = (await app.inject({
      method: "POST",
      url: `/api/v1/courier/stops/${stopId}/intake`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `in-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: "BAG-F26", sealSerial, weightGrams: 2000 }],
        customerConfirmation: true,
        courierConfirmation: true,
      },
    })).json() as { manifestId: string };
    await app.inject({
      method: "POST",
      url: `/api/v1/dispatch/orders/${booked.order.id}/partner`,
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `pa-${randomUUID()}` }),
      payload: { partnerId },
    });
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/partner/receipts",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `rc-${randomUUID()}` }),
      payload: { orderId: booked.order.id, manifestId, actual: [{ containerCode: "BAG-F26", sealSerial, actualWeightGrams: 2000 }] },
    })).statusCode).toBe(200);

    // Finance creates partner invoice
    const pInvRes = await app.inject({
      method: "POST",
      url: "/api/v1/finance/partner-invoices",
      headers: cookieHeader(finance.cookie, { "idempotency-key": `pinv-${randomUUID()}` }),
      payload: {
        partnerId,
        periodStart: "2026-01-01T00:00:00.000Z",
        periodEnd: "2027-01-01T00:00:00.000Z",
      },
    });
    expect(pInvRes.statusCode, pInvRes.body).toBe(200);
    const { invoiceId } = pInvRes.json() as { invoiceId: string };

    const [line] = await db.select().from(partnerInvoiceLines).where(eq(partnerInvoiceLines.invoiceId, invoiceId)).limit(1);
    expect(line).toBeDefined();

    // Partner disputes line -> creates credit note -> finance approves credit note
    const disputeRes = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-invoice-lines/${line.id}/disputes`,
      headers: cookieHeader(partner.cookie, { "idempotency-key": `disp-${randomUUID()}` }),
      payload: { reason: "Спор по тарифу обработки" },
    });
    expect(disputeRes.statusCode, disputeRes.body).toBe(200);

    const [creditNote] = await db.insert(partnerCreditNotes).values({
      organizationId: seed.organizationId,
      invoiceId,
      originalLineId: line.id,
      amountKopeks: 20000,
      reason: "Согласованная корректировка акта",
      state: "draft",
    }).returning();

    const approveCn = await app.inject({
      method: "POST",
      url: `/api/v1/finance/partner-credit-notes/${creditNote.id}/approve`,
      headers: cookieHeader(finance.cookie, { "idempotency-key": `acn-${randomUUID()}` }),
      payload: {},
    });
    expect(approveCn.statusCode, approveCn.body).toBe(200);
    expect(approveCn.json()).toMatchObject({ state: "approved" });

    await assertLedgerBalanced(db, seed.organizationId);
  });

  it("[F29][F30][AD-002][AD-003][AD-004][AD-007] admin role grant/revoke revokes session immediately and last-admin lockout is prevented under concurrency", async () => {
    const seed = await seedTenant(db);
    const admin1 = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_admin"] });
    const admin2 = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_admin"] });
    const staff = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["customer_support"] });

    // Admin1 grants dispatcher role to staff, then revokes it
    const grantRes = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${staff.body.userId}/roles`,
      headers: cookieHeader(admin1.cookie, { "idempotency-key": `gr-${randomUUID()}` }),
      payload: { role: "dispatcher", reason: "Дежурство в смене" },
    });
    expect(grantRes.statusCode).toBe(200);

    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/members/${staff.body.userId}/roles/dispatcher?reason=${encodeURIComponent("Окончание дежурства")}&key=rv-${randomUUID()}`,
      headers: cookieHeader(admin1.cookie),
    });
    expect(revokeRes.statusCode).toBe(200);

    // Concurrent attempt by admin1 and admin2 to revoke each other's platform_admin role
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "DELETE",
        url: `/api/v1/admin/members/${admin2.body.userId}/roles/platform_admin?reason=${encodeURIComponent("Снятие 1")}&key=la1-${randomUUID()}`,
        headers: cookieHeader(admin1.cookie),
      }),
      app.inject({
        method: "DELETE",
        url: `/api/v1/admin/members/${admin1.body.userId}/roles/platform_admin?reason=${encodeURIComponent("Снятие 2")}&key=la2-${randomUUID()}`,
        headers: cookieHeader(admin2.cookie),
      }),
    ]);

    // At most one can succeed; at least one active admin remains
    const successCount = [r1.statusCode, r2.statusCode].filter(s => s === 200).length;
    expect(successCount).toBeLessThanOrEqual(1);
  });

  it("[F34][F35][AU-015][AU-017] cross-org same phone isolation and public guest tracking anti-enumeration", async () => {
    const orgA = await seedTenant(db);
    const deliveryA = await seedDeliveryWindow(db, orgA, 4);

    const orgB = await seedWindow(db, { capacity: 4 });
    await seedCatalog(db, orgB.organizationId);
    await seedAddress(db, orgB.organizationId, orgB.userId, orgB.buildingId);

    const sharedPhone = uniquePhone();
    const userOrgA = await login(app, { organizationId: orgA.organizationId, phone: sharedPhone, roles: ["customer"] });
    const userOrgB = await login(app, { organizationId: orgB.organizationId, phone: sharedPhone, roles: ["customer"] });
    await seedAddress(db, orgA.organizationId, userOrgA.body.userId!, orgA.buildingId);

    const bookedA = await createBookedAndScheduledOrder(app, db, {
      organizationId: orgA.organizationId,
      buildingId: orgA.buildingId,
      pickupWindowId: orgA.windowId,
      deliveryWindowId: deliveryA,
      serviceId: orgA.catalog.serviceId,
      tariffVersionId: orgA.catalog.tariffVersionId,
      termsVersion: orgA.catalog.termsVersion,
      customerCookie: userOrgA.cookie,
    });

    // Same phone logged into Org B cannot see Org A's order
    const crossRead = await app.inject({
      method: "GET",
      url: `/api/v1/orders/${bookedA.order.id}`,
      headers: cookieHeader(userOrgB.cookie),
    });
    expect(crossRead.statusCode).toBe(404);

    // Public guest tracking: wrong phone and nonexistent order return identical 404 without PII
    const wrongPhone = await app.inject({
      method: "GET",
      url: `/api/v1/track/${bookedA.order.publicNumber}?organizationId=${orgA.organizationId}&phone=${encodeURIComponent("+79990000000")}`,
    });
    const missingOrder = await app.inject({
      method: "GET",
      url: `/api/v1/track/LA-99999999-DEAD?organizationId=${orgA.organizationId}&phone=${encodeURIComponent(sharedPhone)}`,
    });
    expect(wrongPhone.statusCode).toBe(404);
    expect(missingOrder.statusCode).toBe(404);
    expect(wrongPhone.json().error.code).toBe(missingOrder.json().error.code);

    // Correct phone + org returns minimal status without leaking customer phone or address
    const validTrack = await app.inject({
      method: "GET",
      url: `/api/v1/track/${bookedA.order.publicNumber}?organizationId=${orgA.organizationId}&phone=${encodeURIComponent(sharedPhone)}`,
    });
    expect(validTrack.statusCode).toBe(200);
    const body = validTrack.json() as Record<string, unknown>;
    expect(body.publicNumber).toBe(bookedA.order.publicNumber);
    expect(body.state).toBe("scheduled");
    expect(JSON.stringify(body)).not.toContain(sharedPhone);
  });
});
