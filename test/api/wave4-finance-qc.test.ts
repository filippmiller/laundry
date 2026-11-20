import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import {
  customerInvoices, garments, intakeManifests, ledgerJournals, orderLines,
  partnerContracts, partnerCreditNotes, partnerInvoices, partnerPayouts, partnerServiceAccruals,
  paymentIntents, qualityChecks, refunds,
} from "../../src/db/schema.js";
import { makePrincipal, seedUser } from "../fixtures.js";
import { seedFullOrder, seedPartner, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";
import { login, seedOrder, seedTenant, uniquePhone } from "./_fixtures.js";
import { recordIntake } from "../../src/services/intake.js";
import {
  partnerWorkspace, receiveHandoff, recordQualityCheck, returnUnprocessedOrder,
  startInspection, startProcessing,
} from "../../src/services/partner.js";
import {
  approvePartnerPayout, capturePayment, createCustomerInvoice, createPartnerPayout,
  processPendingRefunds, refundPayment,
} from "../../src/services/finance.js";
import { cancelOrder, loadOrderView } from "../../src/services/orders.js";
import { customerFinance } from "../../src/services/customer-finance.js";
import { financeAnalytics } from "../../src/services/finance-analytics.js";
import { paymentDrift } from "../../src/services/payment-inbox.js";
import { itemMix } from "../../src/services/item-mix.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 4 Track 2: Finance obligations, payouts, QC, ItemMix, DeclaredValue & Pagination", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
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

  async function receiveEconomyOrder(intakeWeightGrams = 1_000) {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = `BAG-W4-${rid().slice(0, 6)}`;
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: intakeWeightGrams }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: `intake-${rid()}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: intakeWeightGrams }],
      key: `receipt-${rid()}`,
    });
    return { f, partner, seal, bag, intake };
  }

  async function seedPartnerAccrual(organizationId: string, partnerId: string, amountKopeks: number) {
    const tenantUser = await seedUser(db, organizationId);
    const tenant = await seedTenant(db);
    // Use existing org's partner + a fresh order line in this org.
    const f = await seedFullOrder(db, { state: "scheduled" });
    void tenantUser;
    void tenant;
    const [line] = await db.select().from(orderLines).where(eq(orderLines.orderId, f.orderId)).limit(1);
    const [contract] = await db.insert(partnerContracts).values({
      partnerId,
      version: "1.0",
      effectiveFrom: new Date(Date.now() - 86_400_000),
      signed: true,
    }).returning();
    const [accrual] = await db.insert(partnerServiceAccruals).values({
      organizationId,
      partnerId,
      orderLineId: line.id,
      contractId: contract.id,
      quantity: 1_000,
      amountKopeks,
      status: "accrued",
    }).returning();
    return accrual;
  }

  // =========================================================================
  // 1. FP-N06 + FP-N11: Money movement vs service obligation & concurrency
  // =========================================================================

  describe("FP-N06 / FP-N11: Refunds, unprocessed return, captured-order cancellation & concurrency", () => {
    it("invoice 100 -> capture 100 -> refund 100 -> return-unprocessed voids obligation (0 receivable in customer & finance, no debtor)", async () => {
      const { f, partner } = await receiveEconomyOrder(1_000);
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

      const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-${rid()}` });
      expect(inv.totalKopeks).toBe(100);
      const cap = await capturePayment(db, finance, { orderId: f.orderId, amountKopeks: 100, key: `cap-${rid()}` });
      await refundPayment(db, finance, {
        paymentIntentId: cap.paymentIntentId,
        amountKopeks: 100,
        reason: "Полный возврат перед возвратом без обработки",
        key: `ref-${rid()}`,
      });

      await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-${rid()}` });
      const ret = await returnUnprocessedOrder(db, partner.principal, {
        orderId: f.orderId,
        reason: "Возврат без обработки после возврата денег",
        key: `ret-${rid()}`,
      });
      expect(ret.state).toBe("ready");

      const [invAfter] = await db.select().from(customerInvoices).where(eq(customerInvoices.id, inv.invoiceId)).limit(1);
      expect(invAfter.state).toBe("cancelled");

      const [custFin, finAn] = await Promise.all([
        customerFinance(db, f.principal),
        financeAnalytics(db, finance),
      ]);
      expect(custFin.totals.chargedKopeks).toBe(0);
      expect(custFin.totals.outstandingKopeks).toBe(0);
      expect(custFin.totals.creditKopeks).toBe(0);
      expect(custFin.totals.netPaidKopeks).toBe(0);

      expect(finAn.receivables.receivableKopeks).toBe(0);
      expect(finAn.receivables.creditKopeks).toBe(0);
      expect(finAn.receivables.topDebtors).toHaveLength(0);
      expect(finAn.receivables.openInvoices).toHaveLength(0);
    });

    it("captured 100 -> cancel before services rendered voids obligation and refunds 100 without silent retention", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

      const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-c-${rid()}` });
      expect(inv.totalKopeks).toBe(100);
      const cap = await capturePayment(db, finance, { orderId: f.orderId, amountKopeks: 100, key: `cap-c-${rid()}` });

      const cancelled = await cancelOrder(db, f.principal, {
        orderId: f.orderId,
        reason: "Клиент отменил оплаченный заказ до оказания услуг",
        key: `can-${rid()}`,
      });
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.owedRefundKopeks).toBe(100);
      expect(cancelled.refundSettlementState).toBe("completed");
      expect(cancelled.refundIds).toHaveLength(1);

      const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, cap.paymentIntentId)).limit(1);
      expect(intent.state).toBe("refunded");
      const [invRow] = await db.select().from(customerInvoices).where(eq(customerInvoices.id, inv.invoiceId)).limit(1);
      expect(invRow.state).toBe("cancelled");

      const [custFin, finAn, drift] = await Promise.all([
        customerFinance(db, f.principal),
        financeAnalytics(db, finance),
        paymentDrift(db, finance),
      ]);
      expect(custFin.totals.outstandingKopeks).toBe(0);
      expect(custFin.totals.creditKopeks).toBe(0);
      expect(custFin.totals.refundedKopeks).toBe(100);
      expect(finAn.receivables.receivableKopeks).toBe(0);
      expect(finAn.receivables.creditKopeks).toBe(0);
      expect(drift).toHaveLength(0);
    });

    it("deferred refund obligation transitions pending -> error (on handler failure) -> completed on retry without duplicate journals", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

      const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-def-${rid()}` });
      await capturePayment(db, finance, { orderId: f.orderId, amountKopeks: inv.totalKopeks, key: `cap-def-${rid()}` });

      const cancelled = await cancelOrder(db, f.principal, {
        orderId: f.orderId,
        reason: "Отмена с отложенным урегулированием",
        deferRefundSettlement: true,
        key: `can-def-${rid()}`,
      });
      expect(cancelled.refundSettlementState).toBe("pending");
      expect(cancelled.refundIds).toHaveLength(1);
      const refundId = cancelled.refundIds[0];

      // Before settlement: both customerFinance and financeAnalytics show visible owed refund (credit = 100, pending = 100)
      const [custPending, finPending] = await Promise.all([
        customerFinance(db, f.principal),
        financeAnalytics(db, finance),
      ]);
      expect(custPending.totals.outstandingKopeks).toBe(0);
      expect(custPending.totals.creditKopeks).toBe(100);
      expect(custPending.totals.pendingRefundKopeks).toBe(100);
      expect(finPending.receivables.receivableKopeks).toBe(0);
      expect(finPending.receivables.creditKopeks).toBe(100);
      expect(finPending.receivables.pendingRefundKopeks).toBe(100);

      // First processor run fails after apply -> transaction rolls back and marks refund `error`
      const failRun = await processPendingRefunds(db, finance, {
        refundId,
        afterApply: async () => { throw new Error("SIMULATED_PROVIDER_TIMEOUT"); },
      });
      expect(failRun).toEqual({ scanned: 1, completed: 0, errored: 1 });
      const [erroredRefund] = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
      expect(erroredRefund.state).toBe("error");
      const journalsAfterFail = await db.select().from(ledgerJournals).where(and(
        eq(ledgerJournals.organizationId, f.organizationId),
        eq(ledgerJournals.sourceType, "refund"),
        eq(ledgerJournals.sourceId, refundId),
      ));
      expect(journalsAfterFail).toHaveLength(0);

      // Retry converges cleanly to completed
      const retryRun = await processPendingRefunds(db, finance, { refundId });
      expect(retryRun).toEqual({ scanned: 1, completed: 1, errored: 0 });
      // Second retry is an idempotent no-op
      const replayRun = await processPendingRefunds(db, finance, { refundId });
      expect(replayRun).toEqual({ scanned: 0, completed: 0, errored: 0 });

      const journalsAfterRetry = await db.select().from(ledgerJournals).where(and(
        eq(ledgerJournals.organizationId, f.organizationId),
        eq(ledgerJournals.sourceType, "refund"),
        eq(ledgerJournals.sourceId, refundId),
      ));
      expect(journalsAfterRetry).toHaveLength(1);

      const [custDone, finDone] = await Promise.all([
        customerFinance(db, f.principal),
        financeAnalytics(db, finance),
      ]);
      expect(custDone.totals.outstandingKopeks).toBe(0);
      expect(custDone.totals.creditKopeks).toBe(0);
      expect(custDone.totals.pendingRefundKopeks).toBe(0);
      expect(finDone.receivables.receivableKopeks).toBe(0);
      expect(finDone.receivables.creditKopeks).toBe(0);
      expect(finDone.receivables.pendingRefundKopeks).toBe(0);
    });

    it("partial service retention on cancel retains only the agreed amount (30) and refunds the rest (70)", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

      const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-part-${rid()}` });
      await capturePayment(db, finance, { orderId: f.orderId, amountKopeks: inv.totalKopeks, key: `cap-part-${rid()}` });

      // Customer cannot specify retainedKopeks > 0
      await expect(cancelOrder(db, f.principal, {
        orderId: f.orderId,
        reason: "Попытка клиента задать удержание",
        retainedKopeks: 30,
        key: `can-cust-ret-${rid()}`,
      })).rejects.toMatchObject({ code: "FORBIDDEN" });

      const res = await cancelOrder(db, f.dispatcher, {
        orderId: f.orderId,
        reason: "Согласованное удержание за выезд курьера",
        retainedKopeks: 30,
        key: `can-part-${rid()}`,
      });
      expect(res.retainedKopeks).toBe(30);
      expect(res.owedRefundKopeks).toBe(70);
      expect(res.refundSettlementState).toBe("completed");

      const [custFin, finAn, drift] = await Promise.all([
        customerFinance(db, f.principal),
        financeAnalytics(db, finance),
        paymentDrift(db, finance),
      ]);
      expect(custFin.totals.chargedKopeks).toBe(30);
      expect(custFin.totals.netPaidKopeks).toBe(30);
      expect(custFin.totals.refundedKopeks).toBe(70);
      expect(custFin.totals.outstandingKopeks).toBe(0);
      expect(custFin.totals.creditKopeks).toBe(0);
      expect(finAn.receivables.invoicedKopeks).toBe(30);
      expect(finAn.receivables.netCollectedKopeks).toBe(30);
      expect(finAn.receivables.receivableKopeks).toBe(0);
      expect(finAn.receivables.creditKopeks).toBe(0);
      expect(drift).toHaveLength(0);
    });

    it("deterministic concurrency: capturePayment vs cancelOrder serializes on order lock with zero silent retention", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
      const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-race-${rid()}` });

      const [capResult, cancelResult] = await Promise.allSettled([
        capturePayment(db, finance, { orderId: f.orderId, amountKopeks: inv.totalKopeks, key: `cap-race-${rid()}` }),
        cancelOrder(db, f.principal, { orderId: f.orderId, reason: "Гонка отмены и оплаты", key: `can-race-${rid()}` }),
      ]);

      expect(cancelResult.status).toBe("fulfilled");
      if (capResult.status === "rejected") {
        // Cancel won first -> capture rejected with ORDER_CANCELLED
        expect(capResult.reason).toMatchObject({ code: "INVALID_TRANSITION", message: "ORDER_CANCELLED" });
      } else {
        // Capture won first -> cancel refunded 100 and voided invoice
        expect(cancelResult.status === "fulfilled" && cancelResult.value.owedRefundKopeks).toBe(100);
      }

      const [custFin, finAn] = await Promise.all([
        customerFinance(db, f.principal),
        financeAnalytics(db, finance),
      ]);
      expect(custFin.totals.outstandingKopeks).toBe(0);
      expect(custFin.totals.creditKopeks).toBe(0);
      expect(custFin.totals.netPaidKopeks).toBe(0);
      expect(finAn.receivables.receivableKopeks).toBe(0);
      expect(finAn.receivables.creditKopeks).toBe(0);
    });

    it("deterministic concurrency: refundPayment vs returnUnprocessedOrder serializes on order lock", async () => {
      const { f, partner } = await receiveEconomyOrder(1_000);
      const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
      const inv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: `inv-rr-${rid()}` });
      const cap = await capturePayment(db, finance, { orderId: f.orderId, amountKopeks: inv.totalKopeks, key: `cap-rr-${rid()}` });
      await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-rr-${rid()}` });

      const [refRes, retRes] = await Promise.allSettled([
        refundPayment(db, finance, {
          paymentIntentId: cap.paymentIntentId,
          amountKopeks: inv.totalKopeks,
          reason: "Конкурентный возврат",
          key: `ref-rr-${rid()}`,
        }),
        returnUnprocessedOrder(db, partner.principal, {
          orderId: f.orderId,
          reason: "Конкурентный возврат без обработки",
          key: `ret-rr-${rid()}`,
        }),
      ]);

      expect(refRes.status).toBe("fulfilled");
      if (retRes.status === "rejected") {
        // Return ran before refund -> refused with ORDER_ALREADY_CHARGED
        expect(retRes.reason).toMatchObject({ code: "FINANCIAL_HOLD", message: "ORDER_ALREADY_CHARGED" });
      } else {
        // Refund ran before return -> return succeeded and voided paid invoice (0 receivable)
        const finAn = await financeAnalytics(db, finance);
        expect(finAn.receivables.receivableKopeks).toBe(0);
      }
    });
  });

  // =========================================================================
  // 2. FP-N07: Partner payout available payable guard, concurrency & analytics
  // =========================================================================

  describe("FP-N07: Partner payout available payable lock, concurrency & ledger-reconciled analytics", () => {
    it("rejects 1200 payout against 600 debt, prevents two concurrent 400 payouts from exceeding 600, and reconciles analytics", async () => {
      const f = await seedFullOrder(db, { state: "scheduled" });
      const partner = await seedPartner(db, f.organizationId);
      const finance1 = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);
      const finance2 = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

      await seedPartnerAccrual(f.organizationId, partner.partnerId, 600);

      // 600 debt -> 1200 payout rejected
      await expect(createPartnerPayout(db, finance1, {
        partnerId: partner.partnerId,
        amountKopeks: 1_200,
        reference: "OVERPAY-1200",
        key: `over-${rid()}`,
      })).rejects.toMatchObject({ code: "FINANCIAL_HOLD", message: "PAYOUT_EXCEEDS_PAYABLE" });

      // Two concurrent 400 payouts against 600 debt -> exactly 1 succeeds, 1 rejected
      const [p1, p2] = await Promise.allSettled([
        createPartnerPayout(db, finance1, {
          partnerId: partner.partnerId,
          amountKopeks: 400,
          reference: "RACE-400-A",
          key: `race-a-${rid()}`,
        }),
        createPartnerPayout(db, finance1, {
          partnerId: partner.partnerId,
          amountKopeks: 400,
          reference: "RACE-400-B",
          key: `race-b-${rid()}`,
        }),
      ]);
      const fulfilled = [p1, p2].filter(r => r.status === "fulfilled");
      const rejected = [p1, p2].filter(r => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "FINANCIAL_HOLD",
        message: "PAYOUT_EXCEEDS_PAYABLE",
      });
      const winningPayoutId = (fulfilled[0] as PromiseFulfilledResult<{ payoutId: string }>).value.payoutId;

      // Analytics before approval shows reserved=400, payable=600, availablePayable=200, advance=0
      const analyticsBefore = await financeAnalytics(db, finance1);
      const partnerRowBefore = analyticsBefore.payables.partners.find(p => p.partnerId === partner.partnerId)!;
      expect(partnerRowBefore.accruedKopeks).toBe(600);
      expect(partnerRowBefore.reservedKopeks).toBe(400);
      expect(partnerRowBefore.paidKopeks).toBe(0);
      expect(partnerRowBefore.payableKopeks).toBe(600);
      expect(partnerRowBefore.availablePayableKopeks).toBe(200);
      expect(partnerRowBefore.advanceKopeks).toBe(0);

      // Creator cannot self-approve
      await expect(approvePartnerPayout(db, finance1, {
        payoutId: winningPayoutId,
        key: `self-app-${rid()}`,
      })).rejects.toMatchObject({ code: "FORBIDDEN", message: "DUAL_CONTROL_REQUIRED" });

      // Second approver approves; duplicate approval with different key keeps exactly ONE journal
      const [app1, app2] = await Promise.all([
        approvePartnerPayout(db, finance2, { payoutId: winningPayoutId, key: `app1-${rid()}` }),
        approvePartnerPayout(db, finance2, { payoutId: winningPayoutId, key: `app2-${rid()}` }),
      ]);
      expect(app1.state).toBe("approved");
      expect(app2.state).toBe("approved");

      const journals = await db.select().from(ledgerJournals).where(and(
        eq(ledgerJournals.organizationId, f.organizationId),
        eq(ledgerJournals.sourceType, "partner_payout"),
        eq(ledgerJournals.sourceId, winningPayoutId),
      ));
      expect(journals).toHaveLength(1);

      // Analytics after approval: paid=400, reserved=0, payable=200, availablePayable=200
      const analyticsAfter = await financeAnalytics(db, finance1);
      const partnerRowAfter = analyticsAfter.payables.partners.find(p => p.partnerId === partner.partnerId)!;
      expect(partnerRowAfter.paidKopeks).toBe(400);
      expect(partnerRowAfter.reservedKopeks).toBe(0);
      expect(partnerRowAfter.payableKopeks).toBe(200);
      expect(partnerRowAfter.availablePayableKopeks).toBe(200);
      expect(partnerRowAfter.advanceKopeks).toBe(0);

      // Verify negative payable (advance/overpayment) is NEVER silently clamped to 0 in analytics
      await db.insert(partnerPayouts).values({
        organizationId: f.organizationId,
        partnerId: partner.partnerId,
        amountKopeks: 500,
        state: "paid",
        reference: "HISTORICAL-ADVANCE",
        createdBy: finance1.userId,
        approvedBy: finance2.userId,
      });
      const analyticsAdvance = await financeAnalytics(db, finance1);
      const partnerRowAdv = analyticsAdvance.payables.partners.find(p => p.partnerId === partner.partnerId)!;
      expect(partnerRowAdv.paidKopeks).toBe(900);
      expect(partnerRowAdv.payableKopeks).toBe(0);
      expect(partnerRowAdv.advanceKopeks).toBe(300);
      expect(partnerRowAdv.payableKopeks - partnerRowAdv.advanceKopeks).toBe(
        partnerRowAdv.accruedKopeks - partnerRowAdv.disputedKopeks - partnerRowAdv.paidKopeks,
      );
    });
  });

  // =========================================================================
  // 3. FP-N05: Explicit Economy QC & exact Garment QC coverage
  // =========================================================================

  describe("FP-N05: Economy QC explicit decision & Garment QC exact coverage", () => {
    it("economy QC rejects missing bagPassed, records fail->rework, and passes on second QC with full history", async () => {
      const { f, partner } = await receiveEconomyOrder(1_000);
      await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-eco-${rid()}` });
      await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash_40c", key: `proc-eco-${rid()}` });

      // Missing bagPassed MUST be rejected without inserting QC row or advancing to ready
      await expect(recordQualityCheck(db, partner.principal, {
        orderId: f.orderId,
        results: [],
        key: `qc-missing-${rid()}`,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "QC_DECISION_REQUIRED" });

      const rowsAfterReject = await db.select().from(qualityChecks).where(eq(qualityChecks.orderId, f.orderId));
      expect(rowsAfterReject).toHaveLength(0);

      // Explicit FAIL -> stays in processing (rework), records note/actor/timestamp
      const failedQc = await recordQualityCheck(db, partner.principal, {
        orderId: f.orderId,
        results: [],
        bagPassed: false,
        note: "Пятно не отошло — повторная стирка",
        key: `qc-fail-${rid()}`,
      });
      expect(failedQc.allPassed).toBe(false);
      expect(failedQc.state).toBe("processing");

      // Explicit PASS after rework -> ready, preserves both QC history rows
      const passedQc = await recordQualityCheck(db, partner.principal, {
        orderId: f.orderId,
        results: [],
        bagPassed: true,
        note: "Повторная стирка пройдена",
        key: `qc-pass-${rid()}`,
      });
      expect(passedQc.allPassed).toBe(true);
      expect(passedQc.state).toBe("ready");

      const qcHistory = await db.select().from(qualityChecks).where(eq(qualityChecks.orderId, f.orderId));
      expect(qcHistory).toHaveLength(2);
      expect(qcHistory.map(r => r.result).sort()).toEqual(["failed", "passed"]);
      expect(qcHistory.every(r => r.actorId === partner.userId && r.occurredAt instanceof Date)).toBe(true);
    });

    it("garment QC rejects empty, incomplete, duplicate, and foreign garment sets; accepts exact full coverage", async () => {
      const { f, partner } = await receiveEconomyOrder(1_000);
      await startInspection(db, partner.principal, { orderId: f.orderId, key: `insp-g-${rid()}` });
      await startProcessing(db, partner.principal, { orderId: f.orderId, processType: "wash_40c", key: `proc-g-${rid()}` });

      const [g1, g2] = await db.insert(garments).values([
        { organizationId: f.organizationId, orderId: f.orderId, itemCode: `G1-${rid().slice(0, 8)}`, category: "shirt", description: "Рубашка 1" },
        { organizationId: f.organizationId, orderId: f.orderId, itemCode: `G2-${rid().slice(0, 8)}`, category: "shirt", description: "Рубашка 2" },
      ]).returning();

      const foreignOrder = await seedFullOrder(db, { state: "scheduled" });
      const [foreignGarment] = await db.insert(garments).values({
        organizationId: foreignOrder.organizationId,
        orderId: foreignOrder.orderId,
        itemCode: `GF-${rid().slice(0, 8)}`,
        category: "shirt",
        description: "Чужая рубашка",
      }).returning();

      // Empty
      await expect(recordQualityCheck(db, partner.principal, {
        orderId: f.orderId, results: [], key: `qc-e-${rid()}`,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "QC_RESULTS_REQUIRED" });

      // Incomplete
      await expect(recordQualityCheck(db, partner.principal, {
        orderId: f.orderId, results: [{ garmentId: g1.id, passed: true }], key: `qc-inc-${rid()}`,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "QC_INCOMPLETE_COVERAGE" });

      // Duplicate (same garment twice instead of full unique set)
      await expect(recordQualityCheck(db, partner.principal, {
        orderId: f.orderId,
        results: [
          { garmentId: g1.id, passed: true },
          { garmentId: g1.id, passed: true },
        ],
        key: `qc-dup-${rid()}`,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "QC_DUPLICATE_GARMENT" });

      // Duplicate even when all garments are present (3 rows for 2 garments)
      await expect(recordQualityCheck(db, partner.principal, {
        orderId: f.orderId,
        results: [
          { garmentId: g1.id, passed: true },
          { garmentId: g2.id, passed: true },
          { garmentId: g1.id, passed: true },
        ],
        key: `qc-dup3-${rid()}`,
      })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "QC_DUPLICATE_GARMENT" });

      // Foreign garment
      await expect(recordQualityCheck(db, partner.principal, {
        orderId: f.orderId,
        results: [
          { garmentId: g1.id, passed: true },
          { garmentId: foreignGarment.id, passed: true },
        ],
        key: `qc-for-${rid()}`,
      })).rejects.toMatchObject({ code: "NOT_FOUND" });

      // Exact coverage passes
      const ok = await recordQualityCheck(db, partner.principal, {
        orderId: f.orderId,
        results: [
          { garmentId: g1.id, passed: true },
          { garmentId: g2.id, passed: true },
        ],
        key: `qc-ok-${rid()}`,
      });
      expect(ok.state).toBe("ready");
      expect(ok.allPassed).toBe(true);
    });
  });

  // =========================================================================
  // 4. FP-N08: ItemMix actual intake cohort only
  // =========================================================================

  describe("FP-N08: ItemMix weight variance cohort excludes scheduled/cancelled without intake", () => {
    it("scheduled and cancelled orders without intake do not produce false under-weight; actual intake 700g vs 1000g gives under=1, delta=-300", async () => {
      const tenant = await seedTenant(db);
      const dispatcher = makePrincipal(tenant.organizationId, await seedUser(db, tenant.organizationId), ["dispatcher"]);

      // 1. Scheduled order with 1000g quote, NO intake
      const { order: schedOrder } = await seedOrder(db, {
        organizationId: tenant.organizationId,
        customerId: tenant.userId,
        addressId: tenant.addressId,
        tariffVersionId: tenant.catalog.tariffVersionId,
        termsVersion: tenant.catalog.termsVersion,
        publicNumber: `MIX-SCHED-${rid().slice(0, 6)}`,
        lifecycleState: "scheduled",
      });
      await db.insert(orderLines).values({
        orderId: schedOrder.id,
        serviceId: tenant.catalog.serviceId,
        tier: "economy",
        quotedQuantity: 1_000,
        unit: "gram",
        quotedAmountKopeks: 5_000,
        tariffSnapshotJson: {},
      });

      // 2. Cancelled order with 1000g quote, NO intake
      const { order: cancelOrderRow } = await seedOrder(db, {
        organizationId: tenant.organizationId,
        customerId: tenant.userId,
        addressId: tenant.addressId,
        tariffVersionId: tenant.catalog.tariffVersionId,
        termsVersion: tenant.catalog.termsVersion,
        publicNumber: `MIX-CANC-${rid().slice(0, 6)}`,
        lifecycleState: "cancelled",
      });
      await db.insert(orderLines).values({
        orderId: cancelOrderRow.id,
        serviceId: tenant.catalog.serviceId,
        tier: "economy",
        quotedQuantity: 1_000,
        unit: "gram",
        quotedAmountKopeks: 5_000,
        tariffSnapshotJson: {},
      });

      const beforeIntake = await itemMix(db, dispatcher, { days: 30 });
      expect(beforeIntake.weight.ordersWithIntake).toBe(0);
      expect(beforeIntake.weight.ordersWithUnderReceipt).toBe(0);
      expect(beforeIntake.weight.ordersWithOverReceipt).toBe(0);
      expect(beforeIntake.weight.deltaGrams).toBe(0);
      expect(beforeIntake.weight.ordersWithoutIntake).toBe(1);
      expect(beforeIntake.weight.quotedGramsPendingIntake).toBe(1_000);
      expect(beforeIntake.weight.cancelledWithoutIntake).toBe(1);

      // 3. Order with 1000g quote + 700g actual intake
      const { order: intakeOrder } = await seedOrder(db, {
        organizationId: tenant.organizationId,
        customerId: tenant.userId,
        addressId: tenant.addressId,
        tariffVersionId: tenant.catalog.tariffVersionId,
        termsVersion: tenant.catalog.termsVersion,
        publicNumber: `MIX-INT-${rid().slice(0, 6)}`,
        lifecycleState: "picked_up",
      });
      await db.insert(orderLines).values({
        orderId: intakeOrder.id,
        serviceId: tenant.catalog.serviceId,
        tier: "economy",
        quotedQuantity: 1_000,
        unit: "gram",
        quotedAmountKopeks: 5_000,
        tariffSnapshotJson: {},
      });
      await db.insert(intakeManifests).values({
        organizationId: tenant.organizationId,
        orderId: intakeOrder.id,
        mode: "economy_bag",
        count: 1,
        weightGrams: 700,
        manifestHash: "h".repeat(64),
        state: "accepted",
      });

      const afterIntake = await itemMix(db, dispatcher, { days: 30 });
      expect(afterIntake.weight.ordersWithIntake).toBe(1);
      expect(afterIntake.weight.ordersWithUnderReceipt).toBe(1);
      expect(afterIntake.weight.quotedGrams).toBe(1_000);
      expect(afterIntake.weight.receivedGrams).toBe(700);
      expect(afterIntake.weight.deltaGrams).toBe(-300);
      expect(afterIntake.weight.ordersWithoutIntake).toBe(1);
      expect(afterIntake.weight.cancelledWithoutIntake).toBe(1);
    });
  });

  // =========================================================================
  // 5. FP-N10: declaredValueKopeks in scoped order & partner workspace DTOs
  // =========================================================================

  describe("FP-N10: declaredValueKopeks exposed in scoped DTOs with null preserved", () => {
    it("exposes 100000 and null declaredValueKopeks to owner customer and assigned partner, and hides from foreign actors", async () => {
      const { f, partner } = await receiveEconomyOrder(1_000);
      const [gValued, gUnknown] = await db.insert(garments).values([
        {
          organizationId: f.organizationId,
          orderId: f.orderId,
          itemCode: `DV-1-${rid().slice(0, 6)}`,
          category: "coat",
          description: "Пальто",
          declaredValueKopeks: 100_000,
        },
        {
          organizationId: f.organizationId,
          orderId: f.orderId,
          itemCode: `DV-2-${rid().slice(0, 6)}`,
          category: "shirt",
          description: "Рубашка без оценки",
          declaredValueKopeks: null,
        },
      ]).returning();

      const partnerView = await loadOrderView(db, partner.principal, f.orderId);
      expect(partnerView.garments.find(g => g.id === gValued.id)?.declaredValueKopeks).toBe(100_000);
      expect(partnerView.garments.find(g => g.id === gUnknown.id)?.declaredValueKopeks).toBeNull();

      const ws = await partnerWorkspace(db, partner.principal);
      const wsOrder = ws.orders.find(o => o.orderId === f.orderId)!;
      expect(wsOrder.garments.find(g => g.id === gValued.id)?.declaredValueKopeks).toBe(100_000);
      expect(wsOrder.garments.find(g => g.id === gUnknown.id)?.declaredValueKopeks).toBeNull();

      const customerView = await loadOrderView(db, f.principal, f.orderId);
      expect(customerView.garments.find(g => g.id === gValued.id)?.declaredValueKopeks).toBe(100_000);
      expect(customerView.garments.find(g => g.id === gUnknown.id)?.declaredValueKopeks).toBeNull();

      // Foreign customer and foreign partner cannot read the order
      const foreignCustomer = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
      await expect(loadOrderView(db, foreignCustomer, f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      const otherPartner = await seedPartner(db, f.organizationId);
      await expect(loadOrderView(db, otherPartner.principal, f.orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  // =========================================================================
  // 6. W2-FP-02: Separated active/history queues + stable cursor pagination
  // =========================================================================

  describe("W2-FP-02: >50 active & >50 historical payouts/credit notes cursor pagination", () => {
    it("navigates all 55 active and 55 historical payouts & credit notes with identical timestamps and mid-pagination inserts", async () => {
      const tenant = await seedTenant(db);
      const foreignTenant = await seedTenant(db);
      const partnerA = await seedPartner(db, tenant.organizationId);
      const foreignPartner = await seedPartner(db, foreignTenant.organizationId);

      const sameTs = new Date(Date.now() - 5 * 86_400_000);
      const activePayoutRows = Array.from({ length: 55 }, (_, i) => ({
        organizationId: tenant.organizationId,
        partnerId: partnerA.partnerId,
        amountKopeks: 1_000 + i,
        state: "scheduled",
        reference: `ACT-PAY-${i}`,
        createdBy: tenant.userId,
        // Give first 10 rows identical timestamps to test stable ID tie-breaker
        createdAt: i < 10 ? sameTs : new Date(sameTs.getTime() + i * 1_000),
      }));
      const histPayoutRows = Array.from({ length: 55 }, (_, i) => ({
        organizationId: tenant.organizationId,
        partnerId: partnerA.partnerId,
        amountKopeks: 2_000 + i,
        state: i % 2 === 0 ? "approved" : "paid",
        reference: `HIST-PAY-${i}`,
        createdBy: tenant.userId,
        createdAt: i < 10 ? sameTs : new Date(sameTs.getTime() + i * 1_000),
      }));
      const insertedActivePayouts = await db.insert(partnerPayouts).values(activePayoutRows).returning({ id: partnerPayouts.id });
      const insertedHistPayouts = await db.insert(partnerPayouts).values(histPayoutRows).returning({ id: partnerPayouts.id });
      // Foreign tenant payout (must never appear)
      const [foreignPayout] = await db.insert(partnerPayouts).values({
        organizationId: foreignTenant.organizationId,
        partnerId: foreignPartner.partnerId,
        amountKopeks: 9_999,
        state: "scheduled",
        reference: "FOREIGN-PAY",
        createdBy: foreignTenant.userId,
      }).returning({ id: partnerPayouts.id });

      const [partnerInv] = await db.insert(partnerInvoices).values({
        organizationId: tenant.organizationId,
        partnerId: partnerA.partnerId,
        number: `PINV-PAG-${rid().slice(0, 8)}`,
        periodStart: new Date(Date.now() - 86_400_000),
        periodEnd: new Date(),
        totalKopeks: 1_000_000,
      }).returning();
      const activeCnRows = Array.from({ length: 55 }, (_, i) => ({
        organizationId: tenant.organizationId,
        invoiceId: partnerInv.id,
        amountKopeks: 500 + i,
        reason: `ACT-CN-${i}`,
        state: "draft",
        createdAt: i < 10 ? sameTs : new Date(sameTs.getTime() + i * 1_000),
      }));
      const histCnRows = Array.from({ length: 55 }, (_, i) => ({
        organizationId: tenant.organizationId,
        invoiceId: partnerInv.id,
        amountKopeks: 600 + i,
        reason: `HIST-CN-${i}`,
        state: "approved",
        approvedBy: tenant.userId,
        createdAt: i < 10 ? sameTs : new Date(sameTs.getTime() + i * 1_000),
      }));
      const insertedActiveCn = await db.insert(partnerCreditNotes).values(activeCnRows).returning({ id: partnerCreditNotes.id });
      const insertedHistCn = await db.insert(partnerCreditNotes).values(histCnRows).returning({ id: partnerCreditNotes.id });

      const finance = await login(app, {
        organizationId: tenant.organizationId,
        phone: uniquePhone(),
        roles: ["platform_finance"],
      });

      // Traverse ALL active payouts in pages of 25, inserting a newer payout between page 1 and page 2
      const seenActivePayouts: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url = `/api/v1/finance/partner-payouts?bucket=active&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await app.inject({ method: "GET", url, headers: { cookie: finance.cookie } });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean; totalCount: number };
        if (pages === 0) {
          expect(body.totalCount).toBe(55);
          // Insert a brand-new active payout between page 1 and page 2 (must NOT cause duplicates/skips)
          await db.insert(partnerPayouts).values({
            organizationId: tenant.organizationId,
            partnerId: partnerA.partnerId,
            amountKopeks: 777,
            state: "scheduled",
            reference: "MID-INSERT",
            createdBy: tenant.userId,
            createdAt: new Date(Date.now() + 60_000),
          });
        }
        seenActivePayouts.push(...body.items.map(i => i.id));
        cursor = body.hasMore ? body.nextCursor : null;
        pages += 1;
      } while (cursor);

      expect(new Set(seenActivePayouts).size).toBe(55);
      expect(seenActivePayouts).toHaveLength(55);
      for (const row of insertedActivePayouts) {
        expect(seenActivePayouts).toContain(row.id);
      }
      expect(seenActivePayouts).not.toContain(foreignPayout.id);

      // Traverse ALL historical payouts
      const seenHistPayouts: string[] = [];
      cursor = null;
      do {
        const url = `/api/v1/finance/partner-payouts?bucket=history&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await app.inject({ method: "GET", url, headers: { cookie: finance.cookie } });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean; totalCount: number };
        expect(body.totalCount).toBe(55);
        seenHistPayouts.push(...body.items.map(i => i.id));
        cursor = body.hasMore ? body.nextCursor : null;
      } while (cursor);
      expect(new Set(seenHistPayouts).size).toBe(55);
      for (const row of insertedHistPayouts) expect(seenHistPayouts).toContain(row.id);

      // Traverse ALL active & historical credit notes
      const seenActiveCn: string[] = [];
      cursor = null;
      do {
        const url = `/api/v1/finance/partner-credit-notes?bucket=active&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await app.inject({ method: "GET", url, headers: { cookie: finance.cookie } });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean; totalCount: number };
        expect(body.totalCount).toBe(55);
        seenActiveCn.push(...body.items.map(i => i.id));
        cursor = body.hasMore ? body.nextCursor : null;
      } while (cursor);
      expect(new Set(seenActiveCn).size).toBe(55);
      for (const row of insertedActiveCn) expect(seenActiveCn).toContain(row.id);

      const seenHistCn: string[] = [];
      cursor = null;
      do {
        const url = `/api/v1/finance/partner-credit-notes?bucket=history&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await app.inject({ method: "GET", url, headers: { cookie: finance.cookie } });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean; totalCount: number };
        expect(body.totalCount).toBe(55);
        seenHistCn.push(...body.items.map(i => i.id));
        cursor = body.hasMore ? body.nextCursor : null;
      } while (cursor);
      expect(new Set(seenHistCn).size).toBe(55);
      for (const row of insertedHistCn) expect(seenHistCn).toContain(row.id);
    });
  });
});
