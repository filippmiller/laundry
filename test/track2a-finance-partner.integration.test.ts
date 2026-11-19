import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import {
  custodyDiscrepancies, customerInvoiceLines, customerInvoices, membershipRoles, memberships,
  orderLines, orders, partnerContracts, partnerPriceVersions, partnerReceiptLines, partners,
  partnerServiceAccruals,
} from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "./operations-fixtures.js";
import { recordIntake } from "../src/services/intake.js";
import {
  assignOrderToPartner, decideAdjustment, receiveHandoff, returnUnprocessedOrder, startInspection,
} from "../src/services/partner.js";
import { capturePayment, createCustomerInvoice, createPartnerInvoice } from "../src/services/finance.js";
import { customerFinance } from "../src/services/customer-finance.js";
import { financeAnalytics } from "../src/services/finance-analytics.js";

const uniq = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

describe.skipIf(!process.env.TEST_DATABASE_URL)("Track 2A: Pricing, Invoicing, Weight Variance & Partner Accruals/Receipts", () => {
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

  async function receiveAtPartner(input: {
    intakeWeightGrams?: number;
    actualWeightGrams: number;
    partnerOverride?: { partnerId: string; principal: ReturnType<typeof makePrincipal> };
  }) {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = input.partnerOverride
      ? (await assignOrderToPartner(db, f.dispatcher, {
        orderId: f.orderId,
        partnerId: input.partnerOverride.partnerId,
        key: uniq("assign"),
      }), input.partnerOverride)
      : await seedPartnerForOrder(db, f);

    const bag = uniq("BAG-2A");
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId,
      mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: input.intakeWeightGrams ?? 1_000 }],
      customerConfirmation: true,
      courierConfirmation: true,
      key: uniq("intake"),
    });
    const receipt = await receiveHandoff(db, partner.principal, {
      orderId: f.orderId,
      manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams: input.actualWeightGrams }],
      key: uniq("receipt"),
    });
    return { f, partner, seal, bag, intake, receipt };
  }

  it("lnd-irv: accepted adjustment on already-paid invoice issues a collectible supplemental invoice with zero phantom receivable", async () => {
    const { f, partner } = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_400 });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    // 1. Create and capture the original invoice before inspection/adjustment.
    const originalInv = await createCustomerInvoice(db, finance, { orderId: f.orderId, key: uniq("inv") });
    const firstCapture = await capturePayment(db, finance, {
      orderId: f.orderId,
      amountKopeks: originalInv.totalKopeks,
      key: uniq("cap1"),
    });
    expect(firstCapture.state).toBe("captured");

    const [paidOriginal] = await db.select().from(customerInvoices)
      .where(eq(customerInvoices.id, originalInv.invoiceId));
    expect(paidOriginal.state).toBe("paid");
    expect(paidOriginal.totalKopeks).toBe(originalInv.totalKopeks);

    // 2. Inspection proposes the 40-kopek weight variance adjustment; customer accepts.
    const inspection = await startInspection(db, partner.principal, { orderId: f.orderId, key: uniq("inspect") });
    expect(inspection.state).toBe("awaiting_approval");
    expect(inspection.adjustment?.deltaKopeks).toBe(40);

    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const decision = await decideAdjustment(db, f.principal, {
      adjustmentId: inspection.adjustment!.adjustmentId,
      accept: true,
      quoteHash: order.acceptedQuoteHash,
      key: uniq("decide"),
    });
    expect(decision.state).toBe("processing");
    expect(decision.supplementalInvoiceId).toBeTruthy();

    // 3. Original invoice was NOT mutated; supplemental invoice is open for the delta.
    const allInvoices = await db.select().from(customerInvoices)
      .where(eq(customerInvoices.orderId, f.orderId))
      .orderBy(asc(customerInvoices.createdAt));
    expect(allInvoices).toHaveLength(2);
    expect(allInvoices[0].id).toBe(originalInv.invoiceId);
    expect(allInvoices[0].state).toBe("paid");
    expect(allInvoices[0].totalKopeks).toBe(originalInv.totalKopeks);

    const supplemental = allInvoices[1];
    expect(supplemental.id).toBe(decision.supplementalInvoiceId);
    expect(supplemental.state).toBe("open");
    expect(supplemental.totalKopeks).toBe(40);

    const suppLines = await db.select().from(customerInvoiceLines)
      .where(eq(customerInvoiceLines.invoiceId, supplemental.id));
    expect(suppLines).toHaveLength(1);
    expect(suppLines[0].kind).toBe("adjustment");
    expect(suppLines[0].amountKopeks).toBe(40);

    // Before capturing supplemental invoice, receivable is exactly 40 kopeks.
    const custBefore = await customerFinance(db, f.principal);
    expect(custBefore.totals.outstandingKopeks).toBe(40);

    // 4. Capture the open supplemental invoice.
    const secondCapture = await capturePayment(db, finance, {
      orderId: f.orderId,
      amountKopeks: 40,
      key: uniq("cap2"),
    });
    expect(secondCapture.state).toBe("captured");

    const [paidSupplemental] = await db.select().from(customerInvoices)
      .where(eq(customerInvoices.id, supplemental.id));
    expect(paidSupplemental.state).toBe("paid");

    // 5. Zero phantom receivable and zero phantom credit in both customerFinance and financeAnalytics.
    const custAfter = await customerFinance(db, f.principal);
    expect(custAfter.totals.chargedKopeks).toBe(originalInv.totalKopeks + 40);
    expect(custAfter.totals.netPaidKopeks).toBe(originalInv.totalKopeks + 40);
    expect(custAfter.totals.outstandingKopeks).toBe(0);
    expect(custAfter.totals.creditKopeks).toBe(0);

    const analyticsAfter = await financeAnalytics(db, finance);
    expect(analyticsAfter.receivables.invoicedKopeks).toBe(originalInv.totalKopeks + 40);
    expect(analyticsAfter.receivables.netCollectedKopeks).toBe(originalInv.totalKopeks + 40);
    expect(analyticsAfter.receivables.receivableKopeks).toBe(0);
    expect(analyticsAfter.receivables.creditKopeks).toBe(0);
  });

  it("lnd-5or: returnUnprocessedOrder voids unbilled partner accruals so createPartnerInvoice produces 0", async () => {
    const { f, partner } = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_000 });
    const finance = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["platform_finance"]);

    const beforeAccruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, partner.partnerId));
    expect(beforeAccruals).toHaveLength(1);
    expect(beforeAccruals[0].amountKopeks).toBe(600);
    expect(beforeAccruals[0].status).toBe("estimated");

    await startInspection(db, partner.principal, { orderId: f.orderId, key: uniq("inspect") });
    await returnUnprocessedOrder(db, partner.principal, {
      orderId: f.orderId,
      reason: "Невозможно обработать",
      key: uniq("return"),
    });

    const afterAccruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, partner.partnerId));
    expect(afterAccruals).toHaveLength(1);
    expect(afterAccruals[0].status).toBe("voided");
    expect(afterAccruals[0].amountKopeks).toBe(0);

    const partnerInv = await createPartnerInvoice(db, finance, {
      partnerId: partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: uniq("pinv"),
    });
    expect(partnerInv.totalKopeks).toBe(0);
    expect(partnerInv.lineCount).toBe(0);
  });

  it("lnd-nuq: partner accrual reconciles to actual weight after weight variance acceptance (unbilled and already-invoiced)", async () => {
    // Case A: unbilled accrual updated in place on acceptance
    const { f, partner } = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_400 });
    const [line] = await db.select().from(orderLines).where(eq(orderLines.orderId, f.orderId));
    const [initialAccrual] = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.orderLineId, line.id));
    expect(initialAccrual.quantity).toBe(1_000);
    expect(initialAccrual.amountKopeks).toBe(600); // 1000g * 600 kopeks/kg

    const inspection = await startInspection(db, partner.principal, { orderId: f.orderId, key: uniq("inspect") });
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    await decideAdjustment(db, f.principal, {
      adjustmentId: inspection.adjustment!.adjustmentId,
      accept: true,
      quoteHash: order.acceptedQuoteHash,
      key: uniq("decide"),
    });

    const [reconciled] = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.orderLineId, line.id));
    expect(reconciled.quantity).toBe(1_400);
    expect(reconciled.amountKopeks).toBe(840); // ceil(1400 * 600 / 1000)

    // Case B: already-invoiced accrual gets a delta accrual row
    const caseB = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 1_500 });
    const financeB = makePrincipal(caseB.f.organizationId, await seedUser(db, caseB.f.organizationId), ["platform_finance"]);
    const firstInv = await createPartnerInvoice(db, financeB, {
      partnerId: caseB.partner.partnerId,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      key: uniq("pinv-b1"),
    });
    expect(firstInv.totalKopeks).toBe(600);

    const inspB = await startInspection(db, caseB.partner.principal, { orderId: caseB.f.orderId, key: uniq("inspect-b") });
    const [orderB] = await db.select().from(orders).where(eq(orders.id, caseB.f.orderId));
    await decideAdjustment(db, caseB.f.principal, {
      adjustmentId: inspB.adjustment!.adjustmentId,
      accept: true,
      quoteHash: orderB.acceptedQuoteHash,
      key: uniq("decide-b"),
    });

    const [lineB] = await db.select().from(orderLines).where(eq(orderLines.orderId, caseB.f.orderId));
    const accrualsB = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.orderLineId, lineB.id))
      .orderBy(asc(partnerServiceAccruals.createdAt));
    expect(accrualsB).toHaveLength(2);
    expect(accrualsB[0].status).toBe("accrued");
    expect(accrualsB[0].amountKopeks).toBe(600);
    expect(accrualsB[1].status).toBe("estimated");
    expect(accrualsB[1].quantity).toBe(500);
    expect(accrualsB[1].amountKopeks).toBe(300); // ceil(1500*600/1000) - 600
  });

  it("lnd-5zs: a 50% lighter bag records weight_mismatch on partner_receipt_lines and opens a custody_discrepancies incident", async () => {
    const { f, receipt } = await receiveAtPartner({ intakeWeightGrams: 1_000, actualWeightGrams: 500 });

    const receiptLines = await db.select().from(partnerReceiptLines)
      .where(eq(partnerReceiptLines.receiptId, receipt.receiptId));
    expect(receiptLines).toHaveLength(1);
    expect(receiptLines[0].expectedWeightGrams).toBe(1_000);
    expect(receiptLines[0].actualWeightGrams).toBe(500);
    expect(receiptLines[0].status).toBe("weight_mismatch");

    const incidents = await db.select().from(custodyDiscrepancies).where(and(
      eq(custodyDiscrepancies.orderId, f.orderId),
      eq(custodyDiscrepancies.kind, "weight_mismatch"),
    ));
    expect(incidents).toHaveLength(1);
    expect(incidents[0].detailsJson).toMatchObject({
      expectedWeightGrams: 1_000,
      actualWeightGrams: 500,
      deltaGrams: -500,
    });
  });

  it("lnd-epd: rejects unsigned/expired contracts and selects the latest active signed version with partner_price_versions", async () => {
    // 1. Partner with only unsigned and expired contracts -> no accrual booked
    const f1 = await seedFullOrder(db, { state: "pickup_assigned" });
    const [badPartner] = await db.insert(partners).values({ organizationId: f1.organizationId, name: "Без контракта" }).returning();
    const badUser = await seedUser(db, f1.organizationId);
    const [badMembership] = await db.insert(memberships).values({
      organizationId: f1.organizationId, userId: badUser, partnerId: badPartner.id,
    }).returning();
    await db.insert(membershipRoles).values({ membershipId: badMembership.id, role: "laundry_operator" });
    await db.insert(partnerContracts).values([
      {
        partnerId: badPartner.id,
        version: "v1-expired",
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        effectiveTo: new Date("2025-12-31T23:59:59Z"),
        signed: true,
        termsJson: { wholesalePerKgKopeks: 500 },
      },
      {
        partnerId: badPartner.id,
        version: "v2-unsigned",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        signed: false,
        termsJson: { wholesalePerKgKopeks: 700 },
      },
    ]);
    const badPrincipal = makePrincipal(f1.organizationId, badUser, ["laundry_operator"], { partnerId: badPartner.id });
    await assignOrderToPartner(db, f1.dispatcher, { orderId: f1.orderId, partnerId: badPartner.id, key: uniq("assign-bad") });
    const seal1 = await seedSeal(db, f1.organizationId);
    const bag1 = uniq("BAG-BAD");
    const intake1 = await recordIntake(db, f1.courier, {
      orderId: f1.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag1, sealSerial: seal1.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: uniq("intake-bad"),
    });
    await receiveHandoff(db, badPrincipal, {
      orderId: f1.orderId, manifestId: intake1.manifestId,
      actual: [{ containerCode: bag1, sealSerial: seal1.serial, actualWeightGrams: 1_000 }],
      key: uniq("receipt-bad"),
    });
    const badAccruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, badPartner.id));
    expect(badAccruals).toHaveLength(0);

    // 2. Multi-version selection: v1 active signed, v2 active signed (with price version), v3 unsigned, v4 expired
    const f2 = await seedFullOrder(db, { state: "pickup_assigned" });
    const [multiPartner] = await db.insert(partners).values({ organizationId: f2.organizationId, name: "Мульти-версия" }).returning();
    const multiUser = await seedUser(db, f2.organizationId);
    const [multiMembership] = await db.insert(memberships).values({
      organizationId: f2.organizationId, userId: multiUser, partnerId: multiPartner.id,
    }).returning();
    await db.insert(membershipRoles).values({ membershipId: multiMembership.id, role: "laundry_operator" });
    const insertedContracts = await db.insert(partnerContracts).values([
      {
        partnerId: multiPartner.id,
        version: "v1",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        signed: true,
        termsJson: { wholesalePerKgKopeks: 50_000 },
      },
      {
        partnerId: multiPartner.id,
        version: "v2",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        signed: true,
        termsJson: { wholesalePerKgKopeks: 65_000 },
      },
      {
        partnerId: multiPartner.id,
        version: "v3",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        signed: false,
        termsJson: { wholesalePerKgKopeks: 99_000 },
      },
      {
        partnerId: multiPartner.id,
        version: "v4",
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        effectiveTo: new Date("2025-06-01T00:00:00Z"),
        signed: true,
        termsJson: { wholesalePerKgKopeks: 88_000 },
      },
    ]).returning();
    const v2Contract = insertedContracts.find(c => c.version === "v2")!;
    const [v2PriceVersion] = await db.insert(partnerPriceVersions).values({
      contractId: v2Contract.id,
      version: "p2",
      effectiveFrom: new Date("2026-02-01T00:00:00Z"),
      pricesJson: { wholesalePerKgKopeks: 72_000 },
    }).returning();

    const multiPrincipal = makePrincipal(f2.organizationId, multiUser, ["laundry_operator"], { partnerId: multiPartner.id });
    await assignOrderToPartner(db, f2.dispatcher, { orderId: f2.orderId, partnerId: multiPartner.id, key: uniq("assign-multi") });
    const seal2 = await seedSeal(db, f2.organizationId);
    const bag2 = uniq("BAG-MULTI");
    const intake2 = await recordIntake(db, f2.courier, {
      orderId: f2.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag2, sealSerial: seal2.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: uniq("intake-multi"),
    });
    await receiveHandoff(db, multiPrincipal, {
      orderId: f2.orderId, manifestId: intake2.manifestId,
      actual: [{ containerCode: bag2, sealSerial: seal2.serial, actualWeightGrams: 1_000 }],
      key: uniq("receipt-multi"),
    });

    const multiAccruals = await db.select().from(partnerServiceAccruals)
      .where(eq(partnerServiceAccruals.partnerId, multiPartner.id));
    expect(multiAccruals).toHaveLength(1);
    expect(multiAccruals[0].contractId).toBe(v2Contract.id);
    expect(multiAccruals[0].contractPriceVersionId).toBe(v2PriceVersion.id);
    expect(multiAccruals[0].amountKopeks).toBe(72_000);
  });
});
