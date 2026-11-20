import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import {
  custodyDiscrepancies,
  evidenceAssets,
  ledgerEntries,
  ledgerJournals,
  orderLines,
  orders,
  partnerContracts,
  partnerPayouts,
  partnerReceiptLines,
  partnerServiceAccruals,
  paymentIntents,
  seals,
  serviceWindows,
} from "../../src/db/schema.js";
import { buildApp } from "../../src/api/server.js";
import { seedAddress, seedDeliveryWindow, seedWindow } from "../fixtures.js";
import { login, seedInvoice, seedOrder, seedPartner, seedTenant, uniquePhone } from "../api/_fixtures.js";

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

async function bookOrder(
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
      lines: [{ serviceId: opts.serviceId, tier: "economy", quantity: 2000, unit: "gram" }],
    },
  });
  expect(quoteRes.statusCode, quoteRes.body).toBe(200);
  const quote = quoteRes.json() as { id: string; quoteHash: string; totalKopeks: number };

  const pHold = (await app.inject({
    method: "POST",
    url: "/api/v1/slots/holds",
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `hp-${randomUUID()}` }),
    payload: { windowId: opts.pickupWindowId, ttlMinutes: 15 },
  })).json() as { reservationId: string };
  const dHold = (await app.inject({
    method: "POST",
    url: "/api/v1/slots/holds",
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `hd-${randomUUID()}` }),
    payload: { windowId: opts.deliveryWindowId, ttlMinutes: 15 },
  })).json() as { reservationId: string };

  const orderRes = await app.inject({
    method: "POST",
    url: "/api/v1/orders",
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `ord-${randomUUID()}` }),
    payload: { quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: opts.termsVersion },
  });
  expect(orderRes.statusCode, orderRes.body).toBe(200);
  const order = orderRes.json() as { id: string; publicNumber: string; totalKopeks: number };

  const schedRes = await app.inject({
    method: "POST",
    url: `/api/v1/orders/${order.id}/schedule`,
    headers: cookieHeader(opts.customerCookie, { "idempotency-key": `sch-${randomUUID()}` }),
    payload: { pickupReservationId: pHold.reservationId, deliveryReservationId: dHold.reservationId },
  });
  expect(schedRes.statusCode, schedRes.body).toBe(200);

  const [orderRow] = await db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
  return { quote, order, orderRow };
}

describe("Adversarial business & security edge cases", () => {
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

  it("[CO-009][CO-012][F11] shared building: cross-customer container & seal reuse blocked in same org, allowed across tenants", async () => {
    const orgA = await seedTenant(db);
    const delA = await seedDeliveryWindow(db, orgA, 6);
    const orgB = await seedTenant(db);
    const delB = await seedDeliveryWindow(db, orgB, 6);

    const custA1 = await login(app, { organizationId: orgA.organizationId, phone: orgA.phone, roles: ["customer"] });
    const custA2 = await login(app, { organizationId: orgA.organizationId, phone: uniquePhone(), roles: ["customer"] });
    await seedAddress(db, orgA.organizationId, custA2.body.userId!, orgA.buildingId);

    const courierA = await login(app, { organizationId: orgA.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispA = await login(app, { organizationId: orgA.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });

    const order1 = await bookOrder(app, db, {
      organizationId: orgA.organizationId, buildingId: orgA.buildingId,
      pickupWindowId: orgA.windowId, deliveryWindowId: delA,
      serviceId: orgA.catalog.serviceId, tariffVersionId: orgA.catalog.tariffVersionId,
      termsVersion: orgA.catalog.termsVersion, customerCookie: custA1.cookie,
    });
    const order2 = await bookOrder(app, db, {
      organizationId: orgA.organizationId, buildingId: orgA.buildingId,
      pickupWindowId: orgA.windowId, deliveryWindowId: delA,
      serviceId: orgA.catalog.serviceId, tariffVersionId: orgA.catalog.tariffVersionId,
      termsVersion: orgA.catalog.termsVersion, customerCookie: custA2.cookie,
    });

    const { shiftId: shiftA } = (await app.inject({
      method: "POST", url: "/api/v1/courier/shifts",
      headers: cookieHeader(courierA.cookie, { "idempotency-key": `shA-${randomUUID()}` }), payload: {},
    })).json() as { shiftId: string };

    const { stopId: stop1 } = (await app.inject({
      method: "POST", url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispA.cookie, { "idempotency-key": `ap1-${randomUUID()}` }),
      payload: { orderId: order1.order.id, shiftId: shiftA },
    })).json() as { stopId: string };
    const { stopId: stop2 } = (await app.inject({
      method: "POST", url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispA.cookie, { "idempotency-key": `ap2-${randomUUID()}` }),
      payload: { orderId: order2.order.id, shiftId: shiftA },
    })).json() as { stopId: string };

    const sharedContainer = `BAG-SH-${randomUUID().slice(0, 6)}`;
    const seal1 = `SEAL-1-${randomUUID().slice(0, 6)}`;
    const seal2 = `SEAL-2-${randomUUID().slice(0, 6)}`;
    await db.insert(seals).values([
      { organizationId: orgA.organizationId, serialNumber: seal1, state: "available" },
      { organizationId: orgA.organizationId, serialNumber: seal2, state: "available" },
    ]);

    // First customer intake succeeds
    expect((await app.inject({
      method: "POST", url: `/api/v1/courier/stops/${stop1}/intake`,
      headers: cookieHeader(courierA.cookie, { "idempotency-key": `in1-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: sharedContainer, sealSerial: seal1, weightGrams: 2000 }],
        customerConfirmation: true, courierConfirmation: true,
      },
    })).statusCode).toBe(200);

    // Reusing the same active container for another customer in the same building MUST be blocked
    const reuseContainer = await app.inject({
      method: "POST", url: `/api/v1/courier/stops/${stop2}/intake`,
      headers: cookieHeader(courierA.cookie, { "idempotency-key": `in2a-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: sharedContainer, sealSerial: seal2, weightGrams: 2000 }],
        customerConfirmation: true, courierConfirmation: true,
      },
    });
    expect(reuseContainer.statusCode).toBe(409);
    expect(reuseContainer.json().error.message).toBe("CONTAINER_ALREADY_ASSIGNED");

    // Reusing the already-assigned seal on a fresh container MUST also be blocked
    const reuseSeal = await app.inject({
      method: "POST", url: `/api/v1/courier/stops/${stop2}/intake`,
      headers: cookieHeader(courierA.cookie, { "idempotency-key": `in2b-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: `${sharedContainer}-NEW`, sealSerial: seal1, weightGrams: 2000 }],
        customerConfirmation: true, courierConfirmation: true,
      },
    });
    expect(reuseSeal.statusCode).toBe(409);
    expect(reuseSeal.json().error.message).toBe("SEAL_NOT_AVAILABLE");

    // Tenant-scoped uniqueness: Org B can independently use the exact same container code
    const custB = await login(app, { organizationId: orgB.organizationId, phone: orgB.phone, roles: ["customer"] });
    const courierB = await login(app, { organizationId: orgB.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispB = await login(app, { organizationId: orgB.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const orderB = await bookOrder(app, db, {
      organizationId: orgB.organizationId, buildingId: orgB.buildingId,
      pickupWindowId: orgB.windowId, deliveryWindowId: delB,
      serviceId: orgB.catalog.serviceId, tariffVersionId: orgB.catalog.tariffVersionId,
      termsVersion: orgB.catalog.termsVersion, customerCookie: custB.cookie,
    });
    const { shiftId: shiftB } = (await app.inject({
      method: "POST", url: "/api/v1/courier/shifts",
      headers: cookieHeader(courierB.cookie, { "idempotency-key": `shB-${randomUUID()}` }), payload: {},
    })).json() as { shiftId: string };
    const { stopId: stopB } = (await app.inject({
      method: "POST", url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispB.cookie, { "idempotency-key": `apB-${randomUUID()}` }),
      payload: { orderId: orderB.order.id, shiftId: shiftB },
    })).json() as { stopId: string };
    const sealB = `SEAL-B-${randomUUID().slice(0, 6)}`;
    await db.insert(seals).values({ organizationId: orgB.organizationId, serialNumber: sealB, state: "available" });
    const orgBIntake = await app.inject({
      method: "POST", url: `/api/v1/courier/stops/${stopB}/intake`,
      headers: cookieHeader(courierB.cookie, { "idempotency-key": `inB-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: sharedContainer, sealSerial: sealB, weightGrams: 2000 }],
        customerConfirmation: true, courierConfirmation: true,
      },
    });
    expect(orgBIntake.statusCode, orgBIntake.body).toBe(200);
  });

  it("[F24][FI-008][SU-006][SU-009] friendly fraud / double-dipping: PIN-confirmed delivery + concurrent damage claim compensation & payment chargeback preserves ledger & legal hold", async () => {
    const seed = await seedTenant(db);
    const delWin = await seedDeliveryWindow(db, seed, 4);

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const support = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["customer_support", "claims_investigator"] });
    const approver = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["claims_approver"] });
    const finance = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });

    const booked = await bookOrder(app, db, {
      organizationId: seed.organizationId, buildingId: seed.buildingId,
      pickupWindowId: seed.windowId, deliveryWindowId: delWin,
      serviceId: seed.catalog.serviceId, tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion, customerCookie: customer.cookie,
    });

    const inv = (await app.inject({
      method: "POST", url: "/api/v1/finance/invoices",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `inv-${randomUUID()}` }),
      payload: { orderId: booked.order.id },
    })).json() as { totalKopeks: number };
    const cap = (await app.inject({
      method: "POST", url: "/api/v1/finance/payments/capture",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `cap-${randomUUID()}` }),
      payload: { orderId: booked.order.id, amountKopeks: inv.totalKopeks },
    })).json() as { paymentIntentId: string };

    // Deliver with customer PIN
    await db.update(orders).set({ lifecycleState: "ready" }).where(eq(orders.id, booked.order.id));
    const { shiftId } = (await app.inject({
      method: "POST", url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }), payload: {},
    })).json() as { shiftId: string };
    const { stopId } = (await app.inject({
      method: "POST", url: "/api/v1/dispatch/deliveries",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `dd-${randomUUID()}` }),
      payload: { orderId: booked.order.id, shiftId },
    })).json() as { stopId: string };
    await app.inject({
      method: "POST", url: `/api/v1/courier/stops/${stopId}/arrive`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `ar-${randomUUID()}` }), payload: {},
    });
    expect((await app.inject({
      method: "POST", url: `/api/v1/courier/deliveries/${stopId}/attempts`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `del-${randomUUID()}` }),
      payload: { outcome: "delivered", recipientProof: { pin: booked.orderRow.handoffCode } },
    })).statusCode).toBe(200);

    // Attach verified delivery proof evidence
    const sha = createHash("sha256").update("delivery-photo").digest("hex");
    const { evidenceId } = (await app.inject({
      method: "POST", url: "/api/v1/evidence",
      headers: cookieHeader(customer.cookie, { "idempotency-key": `ev-${randomUUID()}` }),
      payload: {
        ownerType: "order", ownerId: booked.order.id,
        objectKey: `org/${seed.organizationId}/proof.jpg`, sha256: sha, purpose: "delivery_proof",
      },
    })).json() as { evidenceId: string };
    await db.update(evidenceAssets).set({ status: "verified" }).where(eq(evidenceAssets.id, evidenceId));

    // Customer opens damage claim -> evidence locked under legal hold
    const { claimId } = (await app.inject({
      method: "POST", url: `/api/v1/orders/${booked.order.id}/claims`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `clm-${randomUUID()}` }),
      payload: { claimType: "damage", description: "Заявлено повреждение после доставки по PIN", evidenceIds: [evidenceId] },
    })).json() as { claimId: string };

    // Legal hold prevents deleting delivery proof
    expect((await app.inject({
      method: "DELETE", url: `/api/v1/evidence/${evidenceId}`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `delev-${randomUUID()}` }),
    })).statusCode).toBe(409);

    // Claim/finance separation: customer cannot decide claim or approve compensation
    expect((await app.inject({
      method: "POST", url: `/api/v1/claims/${claimId}/decision`,
      headers: cookieHeader(customer.cookie, { "idempotency-key": `baddec-${randomUUID()}` }),
      payload: { outcome: "resolved", rationale: "Самоутверждение претензии" },
    })).statusCode).toBe(403);

    // Claims approver resolves, support proposes compensation, finance approves
    expect((await app.inject({
      method: "POST", url: `/api/v1/claims/${claimId}/decision`,
      headers: cookieHeader(approver.cookie, { "idempotency-key": `dec-${randomUUID()}` }),
      payload: { outcome: "resolved", rationale: "Частичная компенсация после проверки" },
    })).statusCode).toBe(200);
    const { compensationId } = (await app.inject({
      method: "POST", url: `/api/v1/claims/${claimId}/compensations`,
      headers: cookieHeader(support.cookie, { "idempotency-key": `cp-${randomUUID()}` }),
      payload: { amountKopeks: 10000 },
    })).json() as { compensationId: string };
    expect((await app.inject({
      method: "POST", url: `/api/v1/compensations/${compensationId}/decision`,
      headers: cookieHeader(finance.cookie, { "idempotency-key": `cd-${randomUUID()}` }),
      payload: { approve: true },
    })).statusCode).toBe(200);

    // Concurrently settle compensation AND receive bank chargeback
    const [settleRes, cbRes] = await Promise.all([
      app.inject({
        method: "POST", url: `/api/v1/claims/${claimId}/compensation/settle`,
        headers: cookieHeader(finance.cookie, { "idempotency-key": `stl-${randomUUID()}` }),
        payload: { compensationId },
      }),
      app.inject({
        method: "POST", url: "/api/v1/finance/chargebacks",
        headers: cookieHeader(finance.cookie, { "idempotency-key": `cb-${randomUUID()}` }),
        payload: { paymentIntentId: cap.paymentIntentId, reason: "Chargeback от банка-эмитента" },
      }),
    ]);
    expect(settleRes.statusCode).toBe(200);
    expect(cbRes.statusCode).toBe(200);

    const [intentAfter] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, cap.paymentIntentId)).limit(1);
    expect(intentAfter.state).toBe("disputed");

    // Once disputed (chargeback), additional refund is blocked so no double payout occurs
    const extraRefund = await app.inject({
      method: "POST", url: "/api/v1/finance/refunds",
      headers: cookieHeader(finance.cookie, { "idempotency-key": `rfx-${randomUUID()}` }),
      payload: { paymentIntentId: cap.paymentIntentId, amountKopeks: 5000, reason: "Попытка повторного возврата" },
    });
    expect(extraRefund.statusCode).toBe(409);

    await assertLedgerBalanced(db, seed.organizationId);
  });

  it("[FI-013][AD-002] Separation of Duties (SoD): finance user cannot self-approve a partner payout; second approver succeeds", async () => {
    const seed = await seedTenant(db);
    const partnerId = await seedPartner(db, seed.organizationId, "Прачечная SoD");
    const { order: sodOrder } = await seedOrder(db, {
      organizationId: seed.organizationId,
      customerId: seed.userId,
      addressId: seed.addressId,
      tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion,
      publicNumber: `SOD-${uniquePhone().slice(-6)}`,
      assignedPartnerId: partnerId,
    });
    const [sodLine] = await db.insert(orderLines).values({
      orderId: sodOrder.id,
      serviceId: seed.catalog.serviceId,
      tier: "economy",
      quotedQuantity: 1_000,
      unit: "gram",
      quotedAmountKopeks: 300_000,
      tariffSnapshotJson: {},
    }).returning();
    const [sodContract] = await db.insert(partnerContracts).values({
      partnerId,
      version: "1.0",
      effectiveFrom: new Date(Date.now() - 86_400_000),
      signed: true,
    }).returning();
    await db.insert(partnerServiceAccruals).values({
      organizationId: seed.organizationId,
      partnerId,
      orderLineId: sodLine.id,
      contractId: sodContract.id,
      quantity: 1_000,
      amountKopeks: 300_000,
      status: "accrued",
    });

    const finance1 = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });
    const finance2 = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });
    const partnerUser = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["partner_finance"], partnerId });

    // Partner cannot schedule payouts
    expect((await app.inject({
      method: "POST", url: "/api/v1/finance/partner-payouts",
      headers: cookieHeader(partnerUser.cookie, { "idempotency-key": `pp-neg-${randomUUID()}` }),
      payload: { partnerId, amountKopeks: 100000, reference: "SELF-PAYOUT" },
    })).statusCode).toBe(403);

    // Finance1 schedules payout
    const createRes = await app.inject({
      method: "POST", url: "/api/v1/finance/partner-payouts",
      headers: cookieHeader(finance1.cookie, { "idempotency-key": `pp-cr-${randomUUID()}` }),
      payload: { partnerId, amountKopeks: 250000, reference: "PAY-2026-11" },
    });
    expect(createRes.statusCode).toBe(200);
    const { payoutId } = createRes.json() as { payoutId: string };

    // Finance1 attempts to approve their own payout -> MUST be rejected with 403 DUAL_CONTROL_REQUIRED
    const selfApprove = await app.inject({
      method: "POST", url: `/api/v1/finance/partner-payouts/${payoutId}/approve`,
      headers: cookieHeader(finance1.cookie, { "idempotency-key": `pp-self-${randomUUID()}` }),
      payload: {},
    });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error.message).toBe("DUAL_CONTROL_REQUIRED");

    // Payout remains scheduled
    const [beforeSecond] = await db.select().from(partnerPayouts).where(eq(partnerPayouts.id, payoutId)).limit(1);
    expect(beforeSecond.state).toBe("scheduled");

    // Finance2 (different user) approves -> succeeds and posts balanced journal
    const secondApprove = await app.inject({
      method: "POST", url: `/api/v1/finance/partner-payouts/${payoutId}/approve`,
      headers: cookieHeader(finance2.cookie, { "idempotency-key": `pp-ok-${randomUUID()}` }),
      payload: {},
    });
    expect(secondApprove.statusCode).toBe(200);
    expect(secondApprove.json()).toMatchObject({ state: "approved" });

    const [afterSecond] = await db.select().from(partnerPayouts).where(eq(partnerPayouts.id, payoutId)).limit(1);
    expect(afterSecond.state).toBe("approved");
    expect(afterSecond.createdBy).not.toBe(afterSecond.approvedBy);

    await assertLedgerBalanced(db, seed.organizationId);
  });

  it("[PA-003][PA-004][CO-016] custody blame-shifting: broken seal rejects receipt while preserving discrepancy; 50% underweight bag flags weight_mismatch", async () => {
    const seed = await seedTenant(db);
    const delWin = await seedDeliveryWindow(db, seed, 6);
    const partnerId = await seedPartner(db, seed.organizationId, "Прачечная Tamper");

    const customer = await login(app, { organizationId: seed.organizationId, phone: seed.phone, roles: ["customer"] });
    const courier = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const dispatcher = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["dispatcher"] });
    const partner = await login(app, { organizationId: seed.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId });

    const { shiftId } = (await app.inject({
      method: "POST", url: "/api/v1/courier/shifts",
      headers: cookieHeader(courier.cookie, { "idempotency-key": `sh-${randomUUID()}` }), payload: {},
    })).json() as { shiftId: string };

    // Case 1: Broken seal reported before receipt -> receipt rejected with 409 AND durable custody_discrepancies row written
    const order1 = await bookOrder(app, db, {
      organizationId: seed.organizationId, buildingId: seed.buildingId,
      pickupWindowId: seed.windowId, deliveryWindowId: delWin,
      serviceId: seed.catalog.serviceId, tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion, customerCookie: customer.cookie,
    });
    const { stopId: stop1 } = (await app.inject({
      method: "POST", url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `ap1-${randomUUID()}` }),
      payload: { orderId: order1.order.id, shiftId },
    })).json() as { stopId: string };

    const brokenSeal = `SEAL-BRK-${randomUUID().slice(0, 6)}`;
    await db.insert(seals).values({ organizationId: seed.organizationId, serialNumber: brokenSeal, state: "available" });
    const { manifestId: man1 } = (await app.inject({
      method: "POST", url: `/api/v1/courier/stops/${stop1}/intake`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `in1-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: "BAG-BRK-1", sealSerial: brokenSeal, weightGrams: 2000 }],
        customerConfirmation: true, courierConfirmation: true,
      },
    })).json() as { manifestId: string };
    await app.inject({
      method: "POST", url: `/api/v1/dispatch/orders/${order1.order.id}/partner`,
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `pa1-${randomUUID()}` }),
      payload: { partnerId },
    });

    // Report seal broken
    expect((await app.inject({
      method: "POST", url: "/api/v1/custody/seals/broken",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `sb-${randomUUID()}` }),
      payload: { orderId: order1.order.id, sealSerial: brokenSeal, reason: "Пломба сорвана при доставке" },
    })).statusCode).toBe(200);

    // Attempting receipt on broken seal rejects custody transfer with 409 SEAL_NOT_INTACT
    const rejectedReceipt = await app.inject({
      method: "POST", url: "/api/v1/partner/receipts",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `rc1-${randomUUID()}` }),
      payload: {
        orderId: order1.order.id, manifestId: man1,
        actual: [{ containerCode: "BAG-BRK-1", sealSerial: brokenSeal, actualWeightGrams: 2000 }],
      },
    });
    expect(rejectedReceipt.statusCode).toBe(409);
    expect(rejectedReceipt.json().error.message).toBe("SEAL_NOT_INTACT");

    const [ord1After] = await db.select().from(orders).where(eq(orders.id, order1.order.id)).limit(1);
    expect(ord1After.lifecycleState).toBe("picked_up");

    const disc1 = await db.select().from(custodyDiscrepancies).where(eq(custodyDiscrepancies.orderId, order1.order.id));
    expect(disc1.some(d => d.kind === "seal_not_intact")).toBe(true);

    // Case 2: 50% underweight bag (1000g actual vs 2000g manifest) flags weight_mismatch & opens incident
    const order2 = await bookOrder(app, db, {
      organizationId: seed.organizationId, buildingId: seed.buildingId,
      pickupWindowId: seed.windowId, deliveryWindowId: delWin,
      serviceId: seed.catalog.serviceId, tariffVersionId: seed.catalog.tariffVersionId,
      termsVersion: seed.catalog.termsVersion, customerCookie: customer.cookie,
    });
    const { stopId: stop2 } = (await app.inject({
      method: "POST", url: "/api/v1/dispatch/pickups/assign",
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `ap2-${randomUUID()}` }),
      payload: { orderId: order2.order.id, shiftId },
    })).json() as { stopId: string };
    const weightSeal = `SEAL-WT-${randomUUID().slice(0, 6)}`;
    await db.insert(seals).values({ organizationId: seed.organizationId, serialNumber: weightSeal, state: "available" });
    const { manifestId: man2 } = (await app.inject({
      method: "POST", url: `/api/v1/courier/stops/${stop2}/intake`,
      headers: cookieHeader(courier.cookie, { "idempotency-key": `in2-${randomUUID()}` }),
      payload: {
        mode: "economy_bag",
        bags: [{ containerCode: "BAG-WT-2", sealSerial: weightSeal, weightGrams: 2000 }],
        customerConfirmation: true, courierConfirmation: true,
      },
    })).json() as { manifestId: string };
    await app.inject({
      method: "POST", url: `/api/v1/dispatch/orders/${order2.order.id}/partner`,
      headers: cookieHeader(dispatcher.cookie, { "idempotency-key": `pa2-${randomUUID()}` }),
      payload: { partnerId },
    });

    const wtReceipt = await app.inject({
      method: "POST", url: "/api/v1/partner/receipts",
      headers: cookieHeader(partner.cookie, { "idempotency-key": `rc2-${randomUUID()}` }),
      payload: {
        orderId: order2.order.id, manifestId: man2,
        actual: [{ containerCode: "BAG-WT-2", sealSerial: weightSeal, actualWeightGrams: 1000 }],
      },
    });
    expect(wtReceipt.statusCode).toBe(200);
    const { receiptId, incidentId } = wtReceipt.json() as { receiptId: string; incidentId: string | null };
    expect(incidentId).toBeTruthy();

    const [line] = await db.select().from(partnerReceiptLines).where(eq(partnerReceiptLines.receiptId, receiptId)).limit(1);
    expect(line.status).toBe("weight_mismatch");

    const disc2 = await db.select().from(custodyDiscrepancies).where(and(
      eq(custodyDiscrepancies.orderId, order2.order.id),
      eq(custodyDiscrepancies.kind, "weight_mismatch"),
    ));
    expect(disc2.length).toBe(1);
  });

  it("[AD-020][OP-011] 2x multi-tenant / multi-role negative matrix: Org B roles cannot read or mutate Org A resources", async () => {
    const orgA = await seedTenant(db);
    const partnerAId = await seedPartner(db, orgA.organizationId, "Partner OrgA");
    const orgB = await seedTenant(db);
    const partnerBId = await seedPartner(db, orgB.organizationId, "Partner OrgB");

    const custA = await login(app, { organizationId: orgA.organizationId, phone: orgA.phone, roles: ["customer"] });
    const finA = await login(app, { organizationId: orgA.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });

    // Seed Org A order, invoice, claim, evidence, payout
    const { order: orderA } = await seedOrder(db, {
      organizationId: orgA.organizationId, customerId: custA.body.userId!, addressId: orgA.addressId,
      tariffVersionId: orgA.catalog.tariffVersionId, termsVersion: orgA.catalog.termsVersion,
      publicNumber: `LA-MT-${randomUUID().slice(0, 6)}`, lifecycleState: "inspection", assignedPartnerId: partnerAId,
    });
    await seedInvoice(db, {
      organizationId: orgA.organizationId,
      orderId: orderA.id,
      number: `INV-${orderA.publicNumber}`,
      totalKopeks: 10000,
    });
    const { claimId: claimA } = (await app.inject({
      method: "POST", url: `/api/v1/orders/${orderA.id}/claims`,
      headers: cookieHeader(custA.cookie, { "idempotency-key": `clmA-${randomUUID()}` }),
      payload: { claimType: "damage", description: "Претензия в организации A" },
    })).json() as { claimId: string };
    const { evidenceId: evA } = (await app.inject({
      method: "POST", url: "/api/v1/evidence",
      headers: cookieHeader(custA.cookie, { "idempotency-key": `evA-${randomUUID()}` }),
      payload: {
        ownerType: "order", ownerId: orderA.id,
        objectKey: `org/${orgA.organizationId}/secret.jpg`,
        sha256: createHash("sha256").update("secret-a").digest("hex"),
        purpose: "claim_evidence",
      },
    })).json() as { evidenceId: string };
    const [lineA] = await db.insert(orderLines).values({
      orderId: orderA.id,
      serviceId: orgA.catalog.serviceId,
      tier: "economy",
      quotedQuantity: 1_000,
      unit: "gram",
      quotedAmountKopeks: 100_000,
      tariffSnapshotJson: {},
    }).returning();
    const [contractA] = await db.insert(partnerContracts).values({
      partnerId: partnerAId,
      version: "1.0",
      effectiveFrom: new Date(Date.now() - 86_400_000),
      signed: true,
    }).returning();
    await db.insert(partnerServiceAccruals).values({
      organizationId: orgA.organizationId,
      partnerId: partnerAId,
      orderLineId: lineA.id,
      contractId: contractA.id,
      quantity: 1_000,
      amountKopeks: 100_000,
      status: "accrued",
    });
    const { payoutId: payoutA } = (await app.inject({
      method: "POST", url: "/api/v1/finance/partner-payouts",
      headers: cookieHeader(finA.cookie, { "idempotency-key": `payA-${randomUUID()}` }),
      payload: { partnerId: partnerAId, amountKopeks: 50000 },
    })).json() as { payoutId: string };

    // Org B principals across all 6 roles
    const custB = await login(app, { organizationId: orgB.organizationId, phone: orgB.phone, roles: ["customer"] });
    const courierB = await login(app, { organizationId: orgB.organizationId, phone: uniquePhone(), roles: ["courier"] });
    const partnerB = await login(app, { organizationId: orgB.organizationId, phone: uniquePhone(), roles: ["laundry_operator"], partnerId: partnerBId });
    const supportB = await login(app, { organizationId: orgB.organizationId, phone: uniquePhone(), roles: ["customer_support", "claims_approver"] });
    const finB = await login(app, { organizationId: orgB.organizationId, phone: uniquePhone(), roles: ["platform_finance"] });
    const adminB = await login(app, { organizationId: orgB.organizationId, phone: uniquePhone(), roles: ["platform_admin"] });

    // Every cross-tenant probe MUST be denied (403 or 404)
    const probes = [
      app.inject({ method: "GET", url: `/api/v1/orders/${orderA.id}`, headers: cookieHeader(custB.cookie) }),
      app.inject({ method: "GET", url: `/api/v1/orders/${orderA.id}`, headers: cookieHeader(courierB.cookie) }),
      app.inject({ method: "GET", url: `/api/v1/orders/${orderA.id}`, headers: cookieHeader(partnerB.cookie) }),
      app.inject({ method: "GET", url: `/api/v1/orders/${orderA.id}/finance`, headers: cookieHeader(finB.cookie) }),
      app.inject({ method: "GET", url: `/api/v1/claims/${claimA}`, headers: cookieHeader(supportB.cookie) }),
      app.inject({ method: "GET", url: `/api/v1/evidence/${evA}`, headers: cookieHeader(supportB.cookie) }),
      app.inject({ method: "GET", url: `/api/v1/evidence/${evA}`, headers: cookieHeader(adminB.cookie) }),
      app.inject({
        method: "POST", url: `/api/v1/finance/partner-payouts/${payoutA}/approve`,
        headers: cookieHeader(finB.cookie, { "idempotency-key": `xpay-${randomUUID()}` }), payload: {},
      }),
      app.inject({
        method: "POST", url: `/api/v1/claims/${claimA}/decision`,
        headers: cookieHeader(supportB.cookie, { "idempotency-key": `xclm-${randomUUID()}` }),
        payload: { outcome: "denied_with_reason", rationale: "Попытка вмешательства из другой организации" },
      }),
      app.inject({
        method: "POST", url: `/api/v1/admin/members/${custA.body.userId}/state`,
        headers: cookieHeader(adminB.cookie, { "idempotency-key": `xadm-${randomUUID()}` }),
        payload: { state: "suspended", reason: "Чужой пользователь" },
      }),
    ];

    const responses = await Promise.all(probes);
    for (const res of responses) {
      expect([403, 404], `Expected 403/404, got ${res.statusCode}: ${res.body}`).toContain(res.statusCode);
    }

    // Privacy export for Org B customer contains zero Org A data
    const privB = await app.inject({ method: "GET", url: "/api/v1/me/privacy-export", headers: cookieHeader(custB.cookie) });
    expect(privB.statusCode).toBe(200);
    expect(privB.body).not.toContain(orderA.id);
    expect(privB.body).not.toContain(orderA.publicNumber);
  });

  it("[CU-013][CU-014][OP-010] safety_buffer_orders enforcement under concurrency + idempotency key payload mismatch rejection", async () => {
    const seed = await seedWindow(db, { capacity: 3 });
    await db.update(serviceWindows).set({ safetyBufferOrders: 1 }).where(eq(serviceWindows.id, seed.windowId));

    // Effective capacity = capacityOrders (3) - safetyBufferOrders (1) = 2
    const customers = await Promise.all(
      [seed.phone, uniquePhone(), uniquePhone(), uniquePhone()].map(phone =>
        login(app, { organizationId: seed.organizationId, phone, roles: ["customer"] }),
      ),
    );

    const results = await Promise.all(
      customers.map((c, idx) =>
        app.inject({
          method: "POST",
          url: "/api/v1/slots/holds",
          headers: cookieHeader(c.cookie, { "idempotency-key": `buf-${idx}-${randomUUID()}` }),
          payload: { windowId: seed.windowId, ttlMinutes: 10 },
        }),
      ),
    );

    const okCount = results.filter(r => r.statusCode === 200).length;
    const conflictCount = results.filter(r => r.statusCode === 409).length;
    expect(okCount).toBe(2);
    expect(conflictCount).toBe(2);

    // Idempotency key reused with a different payload (different ttlMinutes) MUST be rejected with 409
    const seed2 = await seedWindow(db, { capacity: 5 });
    const c = await login(app, { organizationId: seed2.organizationId, phone: seed2.phone, roles: ["customer"] });
    const reusedKey = `idem-conflict-${randomUUID()}`;
    const first = await app.inject({
      method: "POST", url: "/api/v1/slots/holds",
      headers: cookieHeader(c.cookie, { "idempotency-key": reusedKey }),
      payload: { windowId: seed2.windowId, ttlMinutes: 10 },
    });
    expect(first.statusCode).toBe(200);

    const mismatch = await app.inject({
      method: "POST", url: "/api/v1/slots/holds",
      headers: cookieHeader(c.cookie, { "idempotency-key": reusedKey }),
      payload: { windowId: seed2.windowId, ttlMinutes: 25 },
    });
    expect(mismatch.statusCode).toBe(409);

    // Concurrent cancel vs reschedule on the same scheduled order: at most one wins, never both
    const raceTenant = await seedTenant(db);
    const raceDel1 = await seedDeliveryWindow(db, raceTenant, 4);
    const [racePick2] = await db.insert(serviceWindows).values({
      organizationId: raceTenant.organizationId,
      buildingId: raceTenant.buildingId,
      kind: "pickup",
      startsAt: new Date("2026-12-05T10:00:00.000Z"),
      endsAt: new Date("2026-12-05T12:00:00.000Z"),
      capacityOrders: 4,
    }).returning();
    const [raceDel2] = await db.insert(serviceWindows).values({
      organizationId: raceTenant.organizationId,
      buildingId: raceTenant.buildingId,
      kind: "delivery",
      startsAt: new Date("2026-12-06T10:00:00.000Z"),
      endsAt: new Date("2026-12-06T12:00:00.000Z"),
      capacityOrders: 4,
    }).returning();
    const raceCust = await login(app, { organizationId: raceTenant.organizationId, phone: raceTenant.phone, roles: ["customer"] });
    const raceBooked = await bookOrder(app, db, {
      organizationId: raceTenant.organizationId, buildingId: raceTenant.buildingId,
      pickupWindowId: raceTenant.windowId, deliveryWindowId: raceDel1,
      serviceId: raceTenant.catalog.serviceId, tariffVersionId: raceTenant.catalog.tariffVersionId,
      termsVersion: raceTenant.catalog.termsVersion, customerCookie: raceCust.cookie,
    });
    const np = (await app.inject({
      method: "POST", url: "/api/v1/slots/holds",
      headers: cookieHeader(raceCust.cookie, { "idempotency-key": `rnp-${randomUUID()}` }),
      payload: { windowId: racePick2.id, ttlMinutes: 10 },
    })).json() as { reservationId: string };
    const nd = (await app.inject({
      method: "POST", url: "/api/v1/slots/holds",
      headers: cookieHeader(raceCust.cookie, { "idempotency-key": `rnd-${randomUUID()}` }),
      payload: { windowId: raceDel2.id, ttlMinutes: 10 },
    })).json() as { reservationId: string };

    const [cancelRace, reschedRace] = await Promise.all([
      app.inject({
        method: "POST", url: `/api/v1/orders/${raceBooked.order.id}/cancel`,
        headers: cookieHeader(raceCust.cookie, { "idempotency-key": `rcn-${randomUUID()}` }),
        payload: { reason: "Отмена в гонке" },
      }),
      app.inject({
        method: "POST", url: `/api/v1/orders/${raceBooked.order.id}/reschedule`,
        headers: cookieHeader(raceCust.cookie, { "idempotency-key": `rrs-${randomUUID()}` }),
        payload: { pickupReservationId: np.reservationId, deliveryReservationId: nd.reservationId },
      }),
    ]);
    // Both cannot mutate the same version; one succeeds (200) and the other sees conflict (409)
    const raceStatuses = [cancelRace.statusCode, reschedRace.statusCode].sort((a, b) => a - b);
    expect(raceStatuses).toEqual([200, 409]);
  });
});
