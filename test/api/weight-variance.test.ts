import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { customerInvoiceLines, customerInvoices, orderAdjustments, orderLines, orders } from "../../src/db/schema.js";
import { evaluateWeightVariance } from "../../src/services/weight-variance.js";
import { recordIntake } from "../../src/services/intake.js";
import { decideAdjustment, receiveHandoff, startInspection } from "../../src/services/partner.js";
import { seedFullOrder, seedPartnerForOrder, seedSeal } from "../operations-fixtures.js";

const bagCode = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2)}`;

describe("The weight variance", () => {
  it("keeps quiet when the received weight matches the quote", () => {
    const variance = evaluateWeightVariance({
      quotedGrams: 1_000, receivedGrams: 1_000,
      lines: [{ lineId: "l1", quotedGrams: 1_000, quotedAmountKopeks: 100, unitPriceKopeks: 10, roundingRule: "gram_up_to_100" }],
    });
    expect(variance.exceedsThreshold).toBe(false);
    expect(variance.deltaGrams).toBe(0);
    expect(variance.direction).toBe("none");
  });

  it("keeps quiet when the difference is under three hundred grams", () => {
    const variance = evaluateWeightVariance({
      quotedGrams: 1_000, receivedGrams: 1_200,
      lines: [{ lineId: "l1", quotedGrams: 1_000, quotedAmountKopeks: 100, unitPriceKopeks: 10, roundingRule: "gram_up_to_100" }],
    });
    expect(variance.exceedsThreshold).toBe(false);
    expect(variance.deltaGrams).toBe(200);
  });

  it("keeps quiet when the difference is under five percent of the quote", () => {
    const variance = evaluateWeightVariance({
      quotedGrams: 10_000, receivedGrams: 10_400,
      lines: [{ lineId: "l1", quotedGrams: 10_000, quotedAmountKopeks: 1_000, unitPriceKopeks: 10, roundingRule: "gram_up_to_100" }],
    });
    expect(variance.exceedsThreshold).toBe(false);
    expect(variance.ratio).toBeCloseTo(0.04, 5);
  });

  it("proposes the доплата when both thresholds are crossed", () => {
    const variance = evaluateWeightVariance({
      quotedGrams: 1_000, receivedGrams: 1_400,
      lines: [{ lineId: "l1", quotedGrams: 1_000, quotedAmountKopeks: 100, unitPriceKopeks: 10, roundingRule: "gram_up_to_100" }],
    });
    expect(variance.exceedsThreshold).toBe(true);
    expect(variance.direction).toBe("over");
    expect(variance.deltaGrams).toBe(400);
    // 1000 g are ten tariff steps of 100 g at 10 kopeks, 1400 g are fourteen: 4 x 10.
    expect(variance.deltaKopeks).toBe(40);
  });

  it("never proposes a negative delta: a short receipt is not a доплата", () => {
    const variance = evaluateWeightVariance({
      quotedGrams: 1_000, receivedGrams: 800,
      lines: [{ lineId: "l1", quotedGrams: 1_000, quotedAmountKopeks: 100, unitPriceKopeks: 10, roundingRule: "gram_up_to_100" }],
    });
    expect(variance.exceedsThreshold).toBe(false);
    expect(variance.direction).toBe("under");
  });

  it("prices the delta by the tariff formula and not proportionally", () => {
    const variance = evaluateWeightVariance({
      quotedGrams: 1_000, receivedGrams: 1_350,
      lines: [{ lineId: "l1", quotedGrams: 1_000, quotedAmountKopeks: 100, unitPriceKopeks: 10, roundingRule: "gram_up_to_100" }],
    });
    // The tariff rounds up to a full 100 g step, so 1350 g cost the same as 1400 g.
    expect(variance.deltaKopeks).toBe(40);
  });

  it("falls back to the effective price of the quote when the tariff basis is missing", () => {
    const variance = evaluateWeightVariance({
      quotedGrams: 1_000, receivedGrams: 1_400,
      lines: [{ lineId: "l1", quotedGrams: 1_000, quotedAmountKopeks: 10_000 }],
    });
    expect(variance.deltaKopeks).toBe(4_000);
  });

  it("never proposes anything for a piece-priced order", () => {
    const variance = evaluateWeightVariance({ quotedGrams: 0, receivedGrams: 1_400, lines: [] });
    expect(variance.exceedsThreshold).toBe(false);
    expect(variance.deltaKopeks).toBe(0);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("The automatic weight adjustment", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => { await close(); });

  /** Drives an order from pickup to the partner's desk and returns the partner's view. */
  async function toInspection(actualWeightGrams: number) {
    const f = await seedFullOrder(db, { state: "pickup_assigned" });
    const seal = await seedSeal(db, f.organizationId);
    const partner = await seedPartnerForOrder(db, f);
    const bag = bagCode("BAG-VAR");
    const intake = await recordIntake(db, f.courier, {
      orderId: f.orderId, mode: "economy_bag",
      bags: [{ containerCode: bag, sealSerial: seal.serial, weightGrams: 1_000 }],
      customerConfirmation: true, courierConfirmation: true, key: `intake-${bag}`,
    });
    await receiveHandoff(db, partner.principal, {
      orderId: f.orderId, manifestId: intake.manifestId,
      actual: [{ containerCode: bag, sealSerial: seal.serial, actualWeightGrams }],
      key: `receipt-${bag}`,
    });
    const inspection = await startInspection(db, partner.principal, { orderId: f.orderId, key: `inspect-${bag}` });
    return { f, partner, inspection };
  }

  it("proposes the доплата on the partner's inspection without billing anything", async () => {
    const { f, inspection } = await toInspection(1_400);
    expect(inspection.state).toBe("awaiting_approval");
    expect(inspection.adjustment).toMatchObject({ deltaKopeks: 40 });

    const adjustments = await db.select().from(orderAdjustments).where(eq(orderAdjustments.orderId, f.orderId));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].state).toBe("proposed");
    expect(adjustments[0].reason).toContain("1400");

    // Nothing is billed before the customer agrees.
    const invoices = await db.select().from(customerInvoices).where(eq(customerInvoices.orderId, f.orderId));
    expect(invoices).toHaveLength(0);
    const lines = await db.select().from(customerInvoiceLines);
    expect(lines.filter(line => line.kind === "adjustment")).toHaveLength(0);
  });

  it("writes the actual weight on the order line", async () => {
    const { f } = await toInspection(1_400);
    const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, f.orderId));
    expect(lines).toHaveLength(1);
    expect(lines[0].actualQuantity).toBe(1_400);
  });

  it("keeps quiet when the difference is too small", async () => {
    const { f, inspection } = await toInspection(1_200);
    expect(inspection.state).toBe("inspection");
    expect(inspection.adjustment).toBeNull();
    const adjustments = await db.select().from(orderAdjustments).where(eq(orderAdjustments.orderId, f.orderId));
    expect(adjustments).toHaveLength(0);
  });

  it("bills the доплата only after the customer accepts it", async () => {
    const { f, inspection } = await toInspection(1_400);
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const [invoice] = await db.insert(customerInvoices).values({
      organizationId: f.organizationId, orderId: f.orderId, number: `INV-${Math.random().toString(36).slice(2)}`,
      totalKopeks: 100, state: "open",
    }).returning();

    const result = await decideAdjustment(db, f.principal, {
      adjustmentId: inspection.adjustment!.adjustmentId, accept: true, quoteHash: order.acceptedQuoteHash, key: `accept-${invoice.id}`,
    });
    expect(result.state).toBe("processing");

    const lines = await db.select().from(customerInvoiceLines).where(eq(customerInvoiceLines.invoiceId, invoice.id));
    expect(lines).toHaveLength(1);
    expect(lines[0].amountKopeks).toBe(40);
    expect(lines[0].kind).toBe("adjustment");
  });
  it("bills nothing when the customer declines the доплата", async () => {
    const { f, inspection } = await toInspection(1_400);
    const [order] = await db.select().from(orders).where(eq(orders.id, f.orderId));
    const [invoice] = await db.insert(customerInvoices).values({
      organizationId: f.organizationId, orderId: f.orderId, number: `INV-${Math.random().toString(36).slice(2)}`,
      totalKopeks: 100, state: "open",
    }).returning();
    const result = await decideAdjustment(db, f.principal, {
      adjustmentId: inspection.adjustment!.adjustmentId, accept: false, quoteHash: order.acceptedQuoteHash, key: `decline-${invoice.id}`,
    });
    expect(result.state).toBe("inspection");
    const lines = await db.select().from(customerInvoiceLines).where(eq(customerInvoiceLines.invoiceId, invoice.id));
    expect(lines.filter(line => line.kind === "adjustment")).toHaveLength(0);
  });
});
