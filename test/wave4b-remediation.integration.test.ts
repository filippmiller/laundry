import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { buildApp } from "../src/api/server.js";
import { createDb, type Db } from "../src/db/client.js";
import {
  customerInvoices, evidenceAssets, evidenceLegalHolds, garments, ledgerAccounts,
  ledgerEntries, ledgerJournals, orderLines, orders, outboxEvents, partnerPayouts,
  partnerServiceAccruals, paymentEvents, paymentIntents, refunds, routeStops,
  serviceWindows, slotReservations,
} from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedEvidence, seedFullOrder, seedPartnerForOrder, seedSeal } from "./operations-fixtures.js";
import { canonicalScanHash } from "../src/core/scan-hash.js";
import { recordIntake, syncScanEvents } from "../src/services/intake.js";
import {
  decideAdjustment, proposeAdjustment, receiveHandoff, recordQualityCheck,
  returnUnprocessedOrder, startInspection, startProcessing,
} from "../src/services/partner.js";
import {
  approvePartnerPayout, capturePayment, createCustomerInvoice, createPartnerInvoice,
  createPartnerPayout, handlePaymentWebhook,
} from "../src/services/finance.js";
import { financeAnalytics } from "../src/services/finance-analytics.js";
import {
  arriveStop, assignDelivery, currentCourierStops, recordDeliveryAttempt,
} from "../src/services/delivery.js";
import { loadOrderView } from "../src/services/orders.js";
import { deleteEvidence, registerEvidence, uploadEvidence } from "../src/services/workspace.js";
import { decideClaim, openClaim, reopenClaim } from "../src/services/claims.js";
import { processPaymentInbox } from "../src/services/payment-inbox.js";
import { processOutbox } from "../src/services/outbox.js";

const rid = () => randomUUID();
const sha256Hex = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 4B Backend Red-Team Remediation", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    process.env.PAYMENT_WEBHOOK_SECRET = "test-webhook-secret";
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 12 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function login(organizationId: string, phone: string, roles: string[], partnerId?: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { organizationId, phone, roles, ...(partnerId ? { partnerId } : {}) },
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: String(response.headers["set-cookie"] ?? "").split(";")[0],
      userId: (response.json() as { userId: string }).userId,
    };
  }

  async function receiveAtPartner(opts: {
    tier?: "economy" | "protected";
    intakeWeightGrams?: number;
    actualWeightGrams?: number;
    items?: Array<{ itemCode: string; category: string; description: string }>;
  } = {}) {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: opts.tier ?? "economy" });
    const partner = await seedPartnerForOrder(db, f);
    const seal = await seedSeal(db, f.organizationId);
    const bag = `BAG-4B-${rid().slice(0, 8)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: opts.items?.length ? "protected_items" : "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: opts.intakeWeightGrams ?? 1_000 }],
      ...(opts.items?.length ? { items: opts.items } : {}),
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${rid()}`,
    });
    const receipt = await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: opts.actualWeightGrams ?? 1_000 }],
      key: `receipt-${rid()}`,
    });
    return { f, partner, seal, bag, intake, receipt };
  }

  // --- 1. Financial & Concurrency Locks ---

  it("1a: concurrent decideAdjustment with distinct keys only applies once, and concurrent open-invoice payment falls back to supplemental invoice", async () => {
    const { f, partner } = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_400 });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-${rid()}` });

    const insp = await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-${rid()}` });
    expect(insp.state).toBe("awaiting_approval");
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));

    // Race two concurrent decideAdjustment calls with distinct keys
    const results = await Promise.allSettled([
      decideAdjustment(db, f.principal, {
        adjustmentId: insp.adjustment!.adjustmentId,
        accept: true,
        quoteHash: order.acceptedQuoteHash,
        key: `dec-a-${rid()}`,
      }),
      decideAdjustment(db, f.principal, {
        adjustmentId: insp.adjustment!.adjustmentId,
        accept: true,
        quoteHash: order.acceptedQuoteHash,
        key: `dec-b-${rid()}`,
      }),
    ]);
    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const [afterInv] = await db.select().from(customerInvoices).where(eq(customerInvoices.id, inv.invoiceId));
    expect(afterInv.totalKopeks).toBe(inv.totalKopeks + 40);

    // Concurrent open-invoice payment fallback: simulate invoice becoming 'paid' right before conditional UPDATE
    const case2 = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_400 });
    const fin2 = makePrincipal(case2.f.organizationId, await seedUser(db, case2.f.organizationId), ["platform_finance"]);
    const inv2 = await createCustomerInvoice(db, fin2, { orderId: case2.f.orderId, key: `inv2-${rid()}` });
    const insp2 = await startInspection(db, case2.partner.principal, { orderId: case2.f.orderId, key: `insp2-${rid()}` });
    const [order2] = await db.select().from(orders).where(eq(orders.id, case2.f.orderId));

    let intercepted = false;
    const wrapTx = (tx: Db): Db => new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (fn: (inner: Db) => Promise<unknown>) =>
            target.transaction(inner => fn(wrapTx(inner as unknown as Db)));
        }
        if (prop === "update") {
          return (table: unknown) => {
            const builder = (target.update as (t: unknown) => { set: (...a: unknown[]) => unknown })(table);
            if (table === customerInvoices && !intercepted) {
              intercepted = true;
              return new Proxy(builder, {
                get(bTarget, bProp, bReceiver) {
                  if (bProp === "set") {
                    return (...setArgs: unknown[]) => {
                      const whereBuilder = (bTarget.set as (...a: unknown[]) => { where: (...w: unknown[]) => unknown })(...setArgs);
                      return new Proxy(whereBuilder, {
                        get(wTarget, wProp, wReceiver) {
                          if (wProp === "where") {
                            return (...whereArgs: unknown[]) => {
                              const q = (wTarget.where as (...a: unknown[]) => { returning: (...r: unknown[]) => Promise<unknown> })(...whereArgs);
                              return new Proxy(q, {
                                get(qTarget, qProp, qReceiver) {
                                  if (qProp === "returning") {
                                    return async (...retArgs: unknown[]) => {
                                      // Concurrent payment marks invoice paid before the conditional UPDATE runs
                                      await db.update(customerInvoices).set({ state: "paid" }).where(eq(customerInvoices.id, inv2.invoiceId));
                                      return (qTarget.returning as (...r: unknown[]) => Promise<unknown>)(...retArgs);
                                    };
                                  }
                                  return Reflect.get(qTarget, qProp, qReceiver);
                                },
                              });
                            };
                          }
                          return Reflect.get(wTarget, wProp, wReceiver);
                        },
                      });
                    };
                  }
                  return Reflect.get(bTarget, bProp, bReceiver);
                },
              });
            }
            return builder;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const decision2 = await decideAdjustment(wrapTx(db), case2.f.principal, {
      adjustmentId: insp2.adjustment!.adjustmentId,
      accept: true,
      quoteHash: order2.acceptedQuoteHash,
      key: `dec-fallback-${rid()}`,
    });
    expect(decision2.supplementalInvoiceId).toBeTruthy();
    const invRows2 = await db.select().from(customerInvoices)
      .where(eq(customerInvoices.orderId, case2.f.orderId))
      .orderBy(asc(customerInvoices.createdAt));
    expect(invRows2).toHaveLength(2);
    expect(invRows2[0].state).toBe("paid");
    expect(invRows2[0].totalKopeks).toBe(inv2.totalKopeks);
    expect(invRows2[1].id).toBe(decision2.supplementalInvoiceId);
    expect(invRows2[1].state).toBe("open");
    expect(invRows2[1].totalKopeks).toBe(40);
  });

  it("1b: decideAdjustment(returnUnprocessed) rejects captured orders, cancels open invoices, voids accruals, releases slots, and blocks createCustomerInvoice", async () => {
    // Case 1: captured order -> reject with ORDER_ALREADY_CHARGED
    const c1 = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_400 });
    const fin1 = makePrincipal(c1.f.organizationId, await seedUser(db, c1.f.organizationId), ["platform_finance"]);
    const inv1 = await createCustomerInvoice(db, fin1, { orderId: c1.f.orderId, key: `inv-c1-${rid()}` });
    await capturePayment(db, fin1, { orderId: c1.f.orderId, amountKopeks: inv1.totalKopeks, key: `cap-c1-${rid()}` });
    const insp1 = await startInspection(db, c1.partner.principal, { orderId: c1.f.orderId, key: `insp-c1-${rid()}` });
    const [o1] = await db.select().from(orders).where(eq(orders.id, c1.f.orderId));

    await expect(decideAdjustment(db, c1.f.principal, {
      adjustmentId: insp1.adjustment!.adjustmentId,
      accept: false,
      returnUnprocessed: true,
      quoteHash: o1.acceptedQuoteHash,
      key: `ret-c1-${rid()}`,
    })).rejects.toMatchObject({ code: "FINANCIAL_HOLD", message: "ORDER_ALREADY_CHARGED" });

    // Case 2: uncaptured order -> cancels open invoice, voids accruals, releases slots, blocks subsequent createCustomerInvoice
    const c2 = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_400 });
    const fin2 = makePrincipal(c2.f.organizationId, await seedUser(db, c2.f.organizationId), ["platform_finance"]);
    const inv2 = await createCustomerInvoice(db, fin2, { orderId: c2.f.orderId, key: `inv-c2-${rid()}` });
    const insp2 = await startInspection(db, c2.partner.principal, { orderId: c2.f.orderId, key: `insp-c2-${rid()}` });
    const [o2] = await db.select().from(orders).where(eq(orders.id, c2.f.orderId));

    const [winBefore] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, c2.f.windowId));
    const ret = await decideAdjustment(db, c2.f.principal, {
      adjustmentId: insp2.adjustment!.adjustmentId,
      accept: false,
      returnUnprocessed: true,
      quoteHash: o2.acceptedQuoteHash,
      key: `ret-c2-${rid()}`,
    });
    expect(ret.state).toBe("ready");

    const [cancelledInv] = await db.select().from(customerInvoices).where(eq(customerInvoices.id, inv2.invoiceId));
    expect(cancelledInv.state).toBe("cancelled");

    const accruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, c2.partner.partnerId));
    expect(accruals.every(a => a.status === "voided" && a.amountKopeks === 0)).toBe(true);

    const reservations = await db.select().from(slotReservations).where(eq(slotReservations.orderId, c2.f.orderId));
    expect(reservations.every(r => r.state === "released")).toBe(true);
    const [winAfter] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, c2.f.windowId));
    expect(winAfter.reservedOrders).toBe(winBefore.reservedOrders - 1);

    // Also verify a fresh returned_unprocessed order cannot be invoiced via createCustomerInvoice
    const c3 = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_000 });
    const fin3 = makePrincipal(c3.f.organizationId, await seedUser(db, c3.f.organizationId), ["platform_finance"]);
    await startInspection(db, c3.partner.principal, { orderId: c3.f.orderId, key: `insp-c3-${rid()}` });
    await returnUnprocessedOrder(db, c3.partner.principal, {
      orderId: c3.f.orderId,
      reason: "Невозможно обработать",
      key: `ret-c3-${rid()}`,
    });
    await expect(createCustomerInvoice(db, fin3, { orderId: c3.f.orderId, key: `inv-c3-${rid()}` }))
      .rejects.toMatchObject({ code: "FINANCIAL_HOLD", message: "ORDER_RETURNED_UNPROCESSED" });
  });

  it("1c: concurrent receiveHandoff with distinct keys never double-credits partnerServiceAccruals", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const partner = await seedPartnerForOrder(db, f);
    const seal = await seedSeal(db, f.organizationId);
    const bag = `BAG-RACE-${rid().slice(0, 8)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-race-${rid()}`,
    });

    const results = await Promise.allSettled([
      receiveHandoff(db, partner.principal, {
        orderId: f.orderId,
        manifestId: intake.manifestId,
        actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
        key: `rec-a-${rid()}`,
      }),
      receiveHandoff(db, partner.principal, {
        orderId: f.orderId,
        manifestId: intake.manifestId,
        actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: 1_000 }],
        key: `rec-b-${rid()}`,
      }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);

    const accruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, partner.partnerId));
    expect(accruals).toHaveLength(1);
  });

  it("1d: voidPartnerAccrualsForOrder reverses BOTH positive and negative already-invoiced accruals so net reaches 0", async () => {
    const { f, partner } = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_000 });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    // Invoice the initial +600 kopek accrual
    await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: `pinv1-${rid()}`,
    });

    // Simulate a negative delta accrual (-200) that was also invoiced into status='accrued'
    const [line] = await db.select().from(orderLines).where(eq(orderLines.orderId, f.orderId));
    await db.insert(partnerServiceAccruals).values({
      organizationId: f.organizationId,
      partnerId: partner.partnerId,
      orderLineId: line.id,
      contractId: partner.contractId,
      contractPriceVersionId: partner.priceVersionId,
      quantity: -333,
      amountKopeks: -200,
      status: "accrued",
    });

    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-${rid()}` });
    await returnUnprocessedOrder(db, partner.principal, {
      orderId: f.orderId,
      reason: "Полный возврат без обработки",
      key: `ret-${rid()}`,
    });

    const accruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, partner.partnerId));
    const netAmount = accruals
      .filter(a => a.status !== "voided")
      .reduce((sum, a) => sum + a.amountKopeks, 0);
    expect(netAmount).toBe(0);
  });

  it("1e: approvePartnerPayout rejects NULL createdBy; financeAnalytics counts only approved/paid payouts; createPartnerInvoice posts partner_payable credit", async () => {
    const { f, partner } = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_000 });
    const fin1 = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
    const fin2 = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    // 1. createPartnerInvoice posts balanced processing_expense debit / partner_payable credit
    const pInv = await createPartnerInvoice(db, fin1, {
      partnerId: partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: `pinv-${rid()}`,
    });
    expect(pInv.totalKopeks).toBe(600);

    const [journal] = await db.select().from(ledgerJournals).where(and(
      eq(ledgerJournals.organizationId, f.organizationId),
      eq(ledgerJournals.sourceType, "partner_invoice"),
      eq(ledgerJournals.sourceId, pInv.invoiceId),
    ));
    expect(journal).toBeDefined();
    const entries = await db.select({
      code: ledgerAccounts.code,
      debit: ledgerEntries.debitKopeks,
      credit: ledgerEntries.creditKopeks,
    }).from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .where(eq(ledgerEntries.journalId, journal.id));
    expect(entries).toEqual(expect.arrayContaining([
      { code: "processing_expense", debit: 600, credit: 0 },
      { code: "partner_payable", debit: 0, credit: 600 },
    ]));

    // 2. Scheduled payout does NOT reduce reported payableKopeks in financeAnalytics
    const payout = await createPartnerPayout(db, fin1, {
      partnerId: partner.partnerId,
      amountKopeks: 600,
      reference: "PAY-4B",
      key: `po-${rid()}`,
    });
    const beforeApprove = await financeAnalytics(db, fin1);
    expect(beforeApprove.payables.paidKopeks).toBe(0);
    expect(beforeApprove.payables.payableKopeks).toBe(600);

    // 3. Approving with fin2 reduces payableKopeks to 0
    await approvePartnerPayout(db, fin2, { payoutId: payout.payoutId, key: `po-app-${rid()}` });
    const afterApprove = await financeAnalytics(db, fin1);
    expect(afterApprove.payables.paidKopeks).toBe(600);
    expect(afterApprove.payables.payableKopeks).toBe(0);

    // 4. Payout with NULL createdBy is rejected with 403 DUAL_CONTROL_REQUIRED
    const [orphanPayout] = await db.insert(partnerPayouts).values({
      organizationId: f.organizationId,
      partnerId: partner.partnerId,
      amountKopeks: 100,
      state: "scheduled",
      createdBy: null,
    }).returning();
    await expect(approvePartnerPayout(db, fin2, { payoutId: orphanPayout.id, key: `po-null-${rid()}` }))
      .rejects.toMatchObject({ status: 403, code: "FORBIDDEN", message: "DUAL_CONTROL_REQUIRED" });
  });

  // --- 2. Delivery & Pickup Stop Lifecycle ---

  it("2a: partial delivery followed by recovery stop completion transitions cleanly to delivered", async () => {
    const { f, partner, intake } = await receiveAtPartner({
      tier: "protected",
      items: [
        { itemCode: `G1-${rid().slice(0, 6)}`, category: "shirt", description: "Рубашка 1" },
        { itemCode: `G2-${rid().slice(0, 6)}`, category: "pants", description: "Брюки 2" },
      ],
    });
    const [g1, g2] = intake.garments;

    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-${rid()}` });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: `proc-${rid()}` });
    await recordQualityCheck(db, partner.principal, {
      orderId: f.orderId,
      results: [
        { garmentId: g1.id, passed: true },
        { garmentId: g2.id, passed: true },
      ],
      key: `qc-${rid()}`,
    });

    const assigned = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      key: `del-assign-${rid()}`,
    });
    await arriveStop(db, f.courier, { stopId: assigned.stopId, key: `arrive1-${rid()}` });

    // Initial partial delivery of garment 1
    const partial = await recordDeliveryAttempt(db, f.courier, {
      stopId: assigned.stopId,
      outcome: "partial",
      deliveredGarmentIds: [g1.id],
      recipientProof: { signature: "sig-1" },
      key: `partial-${rid()}`,
    });
    expect(partial.state).toBe("out_for_delivery");
    expect(partial.recoveryStopId).toBeTruthy();

    // Recovery stop delivers remaining garment 2 -> MUST transition cleanly to "delivered"
    await arriveStop(db, f.courier, { stopId: partial.recoveryStopId!, key: `arrive2-${rid()}` });
    const finalAttempt = await recordDeliveryAttempt(db, f.courier, {
      stopId: partial.recoveryStopId!,
      outcome: "delivered",
      deliveredGarmentIds: [g2.id],
      recipientProof: { signature: "sig-2" },
      key: `recover-${rid()}`,
    });
    expect(finalAttempt.state).toBe("delivered");

    const [finalOrder] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    expect(finalOrder.lifecycleState).toBe("delivered");
    const finalGarments = await db.select().from(garments).where(eq(garments.orderId, f.orderId));
    expect(finalGarments.every(g => g.status === "delivered")).toBe(true);
    const [recStop] = await db.select().from(routeStops).where(eq(routeStops.id, partial.recoveryStopId!));
    expect(recStop.state).toBe("completed");
  });

  it("2b: delivery reassignment bumps superseded stop version and blocks in-flight completion; pickup stop completes on handoff revoking courier ABAC", async () => {
    const { f, partner } = await receiveAtPartner();

    // Pickup stop is now completed after receiveHandoff -> courier loses ABAC read/scan access
    const [pickupStop] = await db.select().from(routeStops).where(eq(routeStops.id, f.stopId));
    expect(pickupStop.state).toBe("completed");
    const activeStops = await currentCourierStops(db, f.courier);
    expect(activeStops.some(s => s.stopId === f.stopId)).toBe(false);
    await expect(loadOrderView(db, f.courier, f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const scanBase = {
      clientEventId: rid(),
      deviceId: f.deviceId,
      scannedType: "order" as const,
      scannedId: f.orderId,
      capturedAt: new Date().toISOString(),
      context: {},
    };
    const scanRes = await syncScanEvents(db, f.courier, [{ ...scanBase, payloadHash: canonicalScanHash(scanBase) }]);
    expect(scanRes.rejected[0]?.reason).toBe("ORDER_NOT_ASSIGNED");

    // Progress to ready and test delivery reassignment stop version bump
    await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-${rid()}` });
    await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash", key: `proc-${rid()}` });
    await recordQualityCheck(db, partner.principal, { orderId: f.orderId, results: [], bagPassed: true, key: `qc-${rid()}` });

    const del1 = await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      key: `da1-${rid()}`,
    });
    await arriveStop(db, f.courier, { stopId: del1.stopId, key: `arr1-${rid()}` });
    const [beforeReassign] = await db.select().from(routeStops).where(eq(routeStops.id, del1.stopId));

    // Reassign delivery -> superseded stop becomes 'rescheduled' with bumped version
    await assignDelivery(db, f.dispatcher, {
      orderId: f.orderId,
      shiftId: f.shiftId,
      key: `da2-${rid()}`,
    });
    const [afterReassign] = await db.select().from(routeStops).where(eq(routeStops.id, del1.stopId));
    expect(afterReassign.state).toBe("rescheduled");
    expect(afterReassign.version).toBe(beforeReassign.version + 1);

    await expect(recordDeliveryAttempt(db, f.courier, {
      stopId: del1.stopId,
      outcome: "delivered",
      recipientProof: { signature: "stale" },
      key: `stale-del-${rid()}`,
    })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  // --- 3. Evidence Security, Legal Holds & Populated-DB Backfill ---

  it("3a: loadOrderView hides tombstoned garment evidence; deleteEvidence blocks customer from deleting staff-uploaded evidence; recordIntake rejects foreign-order evidence; reopenClaim re-places legal holds", async () => {
    const f = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    const otherOrder = await seedFullOrder(db, { state: "pickup_assigned", tier: "protected" });
    // Put foreign evidence in the SAME organization for a different order
    const [foreignOrderRow] = await db.insert(orders).values({
      organizationId: f.organizationId,
      customerId: f.userId,
      addressId: (await db.select({ addressId: orders.addressId }).from(orders).where(eq(orders.id, f.orderId)))[0].addressId,
      quoteId: f.quoteId,
      publicNumber: `LA-FOREIGN-${rid().slice(0, 6)}`,
      lifecycleState: "scheduled",
      termsVersion: f.catalog.termsVersion,
      acceptedQuoteHash: "b".repeat(64),
    }).returning();
    const foreignEvId = await seedEvidence(db, f.organizationId, foreignOrderRow.id);
    void otherOrder;

    const seal = await seedSeal(db, f.organizationId);
    // Foreign-order evidence in same tenant MUST be rejected on recordIntake
    await expect(recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-FOR-${rid().slice(0, 6)}`, sealSerial: seal.serial, weightGrams: 1_000 }],
      items: [{
        itemCode: `IT-FOR-${rid().slice(0, 6)}`,
        category: "shirt",
        description: "Рубашка",
        evidenceAssetIds: [foreignEvId],
      }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-for-${rid()}`,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Register & upload customer evidence AND staff evidence on f.orderId
    const custBytes = Buffer.from("cust-photo-4b");
    const custReg = await registerEvidence(db, f.principal, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `evidence/${rid()}.jpg`,
      sha256: sha256Hex(custBytes),
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      key: `reg-c-${rid()}`,
    });
    await uploadEvidence(db, f.principal, {
      evidenceId: custReg.evidenceId,
      bytes: custBytes,
      mimeType: "image/jpeg",
      key: `up-c-${rid()}`,
    });

    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
    const staffBytes = Buffer.from("staff-photo-4b");
    const staffReg = await registerEvidence(db, support, {
      ownerType: "order",
      ownerId: f.orderId,
      objectKey: `evidence/${rid()}.jpg`,
      sha256: sha256Hex(staffBytes),
      purpose: "intake_condition",
      mimeType: "image/jpeg",
      key: `reg-s-${rid()}`,
    });
    await uploadEvidence(db, support, {
      evidenceId: staffReg.evidenceId,
      bytes: staffBytes,
      mimeType: "image/jpeg",
      key: `up-s-${rid()}`,
    });

    // Customer CANNOT delete staff-uploaded evidence
    await expect(deleteEvidence(db, f.principal, {
      evidenceId: staffReg.evidenceId,
      key: `del-staff-by-cust-${rid()}`,
    })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

    // Record intake linking both evidence assets to the garment
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "protected_items",
      bags: [{ containerCode: `BAG-OK-${rid().slice(0, 6)}`, sealSerial: seal.serial, weightGrams: 1_000 }],
      items: [{
        itemCode: `IT-OK-${rid().slice(0, 6)}`,
        category: "shirt",
        description: "Рубашка",
        evidenceAssetIds: [custReg.evidenceId, staffReg.evidenceId],
      }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-ok-${rid()}`,
    });
    expect(intake.state).toBe("picked_up");

    // Customer CAN delete their own uploaded evidence -> disappears from loadOrderView!
    await deleteEvidence(db, f.principal, { evidenceId: custReg.evidenceId, key: `del-own-${rid()}` });
    const viewAfterDelete = await loadOrderView(db, f.principal, f.orderId);
    expect((viewAfterDelete.garments[0] as { evidenceAssetIds?: string[] }).evidenceAssetIds).toEqual([staffReg.evidenceId]);

    // Open claim -> decide claim (releases hold) -> reopenClaim (re-places active legal hold!)
    const approver = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["claims_approver"]);
    const claim = await openClaim(db, f.principal, {
      orderId: f.orderId,
      claimType: "damage",
      description: "Проверка повторного открытия претензии",
      evidenceIds: [staffReg.evidenceId],
      key: `cl-reopen-${rid()}`,
    });
    await decideClaim(db, approver, {
      claimId: claim.claimId,
      outcome: "denied_with_reason",
      rationale: "Первичное отклонение по результатам проверки",
      key: `dec-reopen-${rid()}`,
    });
    let [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, staffReg.evidenceId));
    expect(asset.legalHoldCount).toBe(0);
    expect(asset.status).toBe("retained");

    const reopened = await reopenClaim(db, support, {
      claimId: claim.claimId,
      reason: "Поступили новые обстоятельства",
      key: `reopen-${rid()}`,
    });
    expect(reopened.state).toBe("reopened");
    expect(reopened.reheldCount).toBe(1);

    [asset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, staffReg.evidenceId));
    expect(asset.legalHoldCount).toBe(1);
    expect(asset.status).toBe("legal_hold");

    // Even support cannot delete while legal hold is re-placed
    await expect(deleteEvidence(db, support, { evidenceId: staffReg.evidenceId, key: `del-reheld-${rid()}` }))
      .rejects.toMatchObject({ code: "FINANCIAL_HOLD" });
  });

  it("3b: backfill migration 0024 idempotently reconciles legal_hold_count/status and marks pre-upgrade paid invoices", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const fin = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    // 1. Seed a drifted evidence asset (active hold exists, but legal_hold_count=0 and status='verified')
    const evId = await seedEvidence(db, f.organizationId, f.orderId);
    await db.insert(evidenceLegalHolds).values({
      organizationId: f.organizationId,
      assetId: evId,
      reason: "backfill test hold",
      placedBy: f.userId,
    });
    await db.update(evidenceAssets).set({ legalHoldCount: 0, status: "verified" }).where(eq(evidenceAssets.id, evId));

    // 2. Seed a drifted open customer_invoice whose order already has a captured payment_intent
    const inv = await createCustomerInvoice(db, fin, { orderId: f.orderId, key: `bf-inv-${rid()}` });
    await db.insert(paymentIntents).values({
      organizationId: f.organizationId,
      orderId: f.orderId,
      provider: "fake",
      amountKopeks: inv.totalKopeks,
      state: "captured",
      idempotencyKey: `bf-pi-${rid()}`,
    });

    const sqlText = readFileSync(
      resolve(process.cwd(), "drizzle/0024_backfill_legal_holds_and_paid_invoices.sql"),
      "utf8",
    );
    const statements = sqlText.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
    }

    const [reconciledAsset] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, evId));
    expect(reconciledAsset.legalHoldCount).toBe(1);
    expect(reconciledAsset.status).toBe("legal_hold");

    const [reconciledInv] = await db.select().from(customerInvoices).where(eq(customerInvoices.id, inv.invoiceId));
    expect(reconciledInv.state).toBe("paid");

    // Re-running is idempotent
    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
    }
    const [reconciledAsset2] = await db.select().from(evidenceAssets).where(eq(evidenceAssets.id, evId));
    expect(reconciledAsset2.legalHoldCount).toBe(1);
    expect(reconciledAsset2.status).toBe("legal_hold");
  });

  // --- 4. Payment Inbox, Outbox Stale-Processing Recovery & GET /orders Ordering ---

  it("4a: payment inbox does not let refunded overwrite disputed/chargeback_lost and reclaims stale processing rows", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const [disputedIntent] = await db.insert(paymentIntents).values({
      organizationId: f.organizationId,
      orderId: f.orderId,
      provider: "fake",
      amountKopeks: 50_000,
      state: "disputed",
      idempotencyKey: `pi-disp-${rid()}`,
    }).returning();
    await db.insert(refunds).values({
      organizationId: f.organizationId,
      paymentIntentId: disputedIntent.id,
      amountKopeks: 50_000,
      state: "completed",
      reason: "late refund webhook",
      idempotencyKey: `rf-disp-${rid()}`,
    });
    await handlePaymentWebhook(db, {
      provider: "fake",
      providerEventId: `evt-disp-ref-${rid()}`,
      eventType: "refunded",
      payload: { paymentIntentId: disputedIntent.id },
    });

    // Also seed a stale 'processing' event (older than 5 min) that should be reclaimed
    const [staleIntent] = await db.insert(paymentIntents).values({
      organizationId: f.organizationId,
      orderId: f.orderId,
      provider: "fake",
      amountKopeks: 10_000,
      state: "pending",
      idempotencyKey: `pi-stale-${rid()}`,
    }).returning();
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const [staleEvt] = await db.insert(paymentEvents).values({
      organizationId: f.organizationId,
      provider: "fake",
      providerEventId: `evt-stale-${rid()}`,
      paymentIntentId: staleIntent.id,
      eventType: "captured",
      payloadHash: "c".repeat(64),
      state: "processing",
      attempts: 1,
      receivedAt: tenMinAgo,
      processedAt: tenMinAgo,
    }).returning();

    await processPaymentInbox(db, { limit: 200 });

    const [afterDisputed] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, disputedIntent.id));
    expect(afterDisputed.state).toBe("disputed");

    const [afterStaleIntent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, staleIntent.id));
    expect(afterStaleIntent.state).toBe("captured");
    const [afterStaleEvt] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, staleEvt.id));
    expect(afterStaleEvt.state).toBe("processed");
  });

  it("4b: outbox reclaims stale processing rows older than lease timeout while leaving fresh processing rows alone", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const now = new Date();

    const [staleRow] = await db.insert(outboxEvents).values({
      organizationId: f.organizationId,
      aggregateType: "order",
      aggregateId: f.orderId,
      eventType: "order.confirmed",
      payloadJson: { test: "stale" },
      state: "processing",
      attempts: 1,
      availableAt: tenMinAgo,
      createdAt: tenMinAgo,
    }).returning();

    const [freshRow] = await db.insert(outboxEvents).values({
      organizationId: f.organizationId,
      aggregateType: "order",
      aggregateId: f.orderId,
      eventType: "order.confirmed",
      payloadJson: { test: "fresh" },
      state: "processing",
      attempts: 1,
      availableAt: now,
      createdAt: now,
    }).returning();

    const drained = await processOutbox(db, { organizationId: f.organizationId, now });
    expect(drained.processed).toBeGreaterThanOrEqual(1);

    const [afterStale] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, staleRow.id));
    expect(afterStale.state).toBe("processed");
    expect(afterStale.deliveryStatus).toBe("delivered");

    const [afterFresh] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, freshRow.id));
    expect(afterFresh.state).toBe("processing");
  });

  it("4c: GET /api/v1/orders returns orders ordered by createdAt DESC (newest first)", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const [addrRow] = await db.select({ addressId: orders.addressId }).from(orders).where(eq(orders.id, f.orderId));
    const olderAt = new Date("2026-01-01T10:00:00Z");
    const newerAt = new Date("2026-11-18T10:00:00Z");

    const [olderOrder] = await db.insert(orders).values({
      organizationId: f.organizationId,
      customerId: f.userId,
      addressId: addrRow.addressId,
      quoteId: f.quoteId,
      publicNumber: `LA-OLD-${rid().slice(0, 6)}`,
      lifecycleState: "scheduled",
      termsVersion: f.catalog.termsVersion,
      acceptedQuoteHash: "d".repeat(64),
      createdAt: olderAt,
    }).returning();
    const [newerOrder] = await db.insert(orders).values({
      organizationId: f.organizationId,
      customerId: f.userId,
      addressId: addrRow.addressId,
      quoteId: f.quoteId,
      publicNumber: `LA-NEW-${rid().slice(0, 6)}`,
      lifecycleState: "scheduled",
      termsVersion: f.catalog.termsVersion,
      acceptedQuoteHash: "e".repeat(64),
      createdAt: newerAt,
    }).returning();

    const session = await login(f.organizationId, f.phone, ["customer"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders",
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; createdAt: string }>;
    const idxNew = list.findIndex(o => o.id === newerOrder.id);
    const idxOld = list.findIndex(o => o.id === olderOrder.id);
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxOld).toBeGreaterThan(idxNew);
    void isNull;
    void proposeAdjustment;
  });
});
