import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orderLines, orders, partnerReceiptLines, partnerReceipts } from "../db/schema.js";
import { priceServiceAmount } from "../domain/pricing.js";

/**
 * "The laundry weighs more than the quote promised."
 *
 * The tariff of the «Эконом» tier is a weight tariff: the customer is charged for the
 * kilograms that were really washed. When the partner's own weighing at the handoff
 * disagrees with the quote by a noticeable margin, the difference is money, and money
 * is never taken from a customer without their consent. This service measures the
 * difference and proposes a change; the customer decides.
 *
 * Two thresholds have to be crossed at the same time, so that neither a rounding
 * artefact nor a slow drift of the estimate turns into a surcharge:
 *
 * - at least **300 grams** of difference, and
 * - at least **5%** of the quoted weight.
 *
 * The price of the difference is taken from the immutable quote line stored on the order
 * line — never from the current tariff — so a proposal can only ever cost what the
 * customer was originally quoted per kilogram.
 */

/** The absolute difference in grams that makes a proposal worth the customer's attention. */
export const WEIGHT_VARIANCE_MIN_GRAMS = 300;
/** The relative difference that makes a proposal worth the customer's attention. */
export const WEIGHT_VARIANCE_MIN_RATIO = 0.05;

export type GramLineBasis = {
  lineId: string;
  quotedGrams: number;
  quotedAmountKopeks: number;
  /** The tariff price of one tariff step; missing on lines quoted before the basis was kept. */
  unitPriceKopeks?: number;
  roundingRule?: "exact" | "gram_up_to_100";
  minQuantity?: number;
};

export type WeightVarianceLine = {
  lineId: string;
  quotedGrams: number;
  quotedAmountKopeks: number;
  actualGrams: number;
  deltaGrams: number;
  deltaKopeks: number;
};

export type WeightVariance = {
  quotedGrams: number;
  receivedGrams: number;
  deltaGrams: number;
  ratio: number;
  deltaKopeks: number;
  direction: "over" | "under" | "none";
  exceedsThreshold: boolean;
  lines: WeightVarianceLine[];
};

/**
 * The price of one line's difference in grams.
 *
 * When the tariff basis of the quote line is known, the difference is priced by the very
 * same formula the quote was priced with — including the rounding to a full tariff step,
 * so 1350 g cost exactly what 1400 g cost. When the basis is missing (a line quoted
 * before the platform kept it), the effective price of the quote is used instead: the
 * difference is charged proportionally to the amount the customer already accepted.
 */
function priceLineDelta(line: GramLineBasis, actualGrams: number): number {
  if (typeof line.unitPriceKopeks === "number" && Number.isFinite(line.unitPriceKopeks)) {
    const basis = {
      unit: "gram" as const,
      unitPriceKopeks: line.unitPriceKopeks,
      roundingRule: line.roundingRule,
      minQuantity: line.minQuantity,
    };
    return priceServiceAmount({ ...basis, quantity: actualGrams })
      - priceServiceAmount({ ...basis, quantity: line.quotedGrams });
  }
  const deltaGrams = actualGrams - line.quotedGrams;
  if (line.quotedGrams <= 0) return 0;
  return Math.ceil((deltaGrams * line.quotedAmountKopeks) / line.quotedGrams);
}

/**
 * Measures the difference between the quoted weight and the weight that was really
 * received, and decides whether it is worth the customer's attention.
 *
 * The received weight is spread over the quoted lines proportionally to their quoted
 * weight: when a customer hands over three t-shirts and two shirts, nobody knows which
 * of them got heavier, and splitting the difference by the quoted weight is the only
 * split that cannot favour anybody.
 */
export function evaluateWeightVariance(input: {
  quotedGrams: number;
  receivedGrams: number;
  lines: GramLineBasis[];
}): WeightVariance {
  const lines = input.lines.filter(line => line.quotedGrams > 0);
  const quotedGrams = lines.reduce((sum, line) => sum + line.quotedGrams, 0);
  const deltaGrams = input.receivedGrams - quotedGrams;
  const ratio = quotedGrams > 0 ? deltaGrams / quotedGrams : 0;
  const direction = deltaGrams > 0 ? "over" : deltaGrams < 0 ? "under" : "none";

  let allocated = 0;
  const perLine: WeightVarianceLine[] = lines.map((line, index) => {
    const actualGrams = index === lines.length - 1
      ? input.receivedGrams - allocated
      : Math.round((input.receivedGrams * line.quotedGrams) / quotedGrams);
    allocated += actualGrams;
    return {
      lineId: line.lineId,
      quotedGrams: line.quotedGrams,
      quotedAmountKopeks: line.quotedAmountKopeks,
      actualGrams,
      deltaGrams: actualGrams - line.quotedGrams,
      deltaKopeks: priceLineDelta(line, actualGrams),
    };
  });

  const deltaKopeks = perLine.reduce((sum, line) => sum + line.deltaKopeks, 0);
  const exceedsThreshold = direction === "over"
    && deltaGrams >= WEIGHT_VARIANCE_MIN_GRAMS
    && ratio >= WEIGHT_VARIANCE_MIN_RATIO
    && deltaKopeks > 0;

  return {
    quotedGrams,
    receivedGrams: input.receivedGrams,
    deltaGrams,
    ratio,
    deltaKopeks,
    direction,
    exceedsThreshold,
    lines: perLine,
  };
}

/** The basis of a quoted gram line, read back from the immutable snapshot of the quote. */
function lineBasis(line: {
  id: string;
  quotedQuantity: number;
  quotedAmountKopeks: number;
  tariffSnapshotJson: unknown;
}): GramLineBasis {
  const snapshot = (line.tariffSnapshotJson ?? {}) as {
    line?: { unitPriceKopeks?: number; roundingRule?: "exact" | "gram_up_to_100"; minQuantity?: number };
  };
  return {
    lineId: line.id,
    quotedGrams: line.quotedQuantity,
    quotedAmountKopeks: line.quotedAmountKopeks,
    unitPriceKopeks: snapshot.line?.unitPriceKopeks,
    roundingRule: snapshot.line?.roundingRule,
    minQuantity: snapshot.line?.minQuantity,
  };
}

/**
 * Measures the weight variance of an order from what the database knows: the gram-priced
 * lines of the quote and the weight the partner actually received at the handoff.
 */
export async function measureOrderWeightVariance(db: Db, orderId: string, organizationId: string) {
  const [order] = await db.select({ id: orders.id }).from(orders).where(and(
    eq(orders.id, orderId), eq(orders.organizationId, organizationId),
  )).limit(1);
  if (!order) return null;

  const lines = await db.select({
    id: orderLines.id,
    quotedQuantity: orderLines.quotedQuantity,
    quotedAmountKopeks: orderLines.quotedAmountKopeks,
    tariffSnapshotJson: orderLines.tariffSnapshotJson,
  }).from(orderLines).where(and(
    eq(orderLines.orderId, orderId), eq(orderLines.unit, "gram"),
  ));

  const receipts = await db.select({ actualWeightGrams: partnerReceiptLines.actualWeightGrams })
    .from(partnerReceiptLines)
    .innerJoin(partnerReceipts, eq(partnerReceipts.id, partnerReceiptLines.receiptId))
    .where(and(
      eq(partnerReceipts.organizationId, organizationId),
      eq(partnerReceipts.orderId, orderId),
    ));

  const receivedGrams = receipts.reduce((sum, row) => sum + (row.actualWeightGrams ?? 0), 0);
  const quotedGrams = lines.reduce((sum, line) => sum + line.quotedQuantity, 0);

  const variance = evaluateWeightVariance({
    quotedGrams,
    receivedGrams,
    lines: lines.map(lineBasis),
  });
  return { variance, lines };
}

/** The Russian reason the customer reads when the proposal reaches them. */
export function describeWeightVariance(variance: WeightVariance): string {
  const percent = Math.round(variance.ratio * 100);
  const over = variance.deltaGrams;
  return `Фактический вес ${variance.receivedGrams} г против расчётных ${variance.quotedGrams} г: `
    + `перебор ${over} г (${percent}%). Доплата рассчитана по цене котировки и требует вашего согласия.`;
}
