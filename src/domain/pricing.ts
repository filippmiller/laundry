import { hashRequest } from "../core/idempotency.js";
import { assertKopeks } from "./money.js";
import type { DeclaredItem } from "../../shared/garment-taxonomy.js";

export type RoundingRule = "exact" | "gram_up_to_100" | "gram_up_to_1000";

export type ServiceLineInput = {
  serviceId: string;
  tier: "economy" | "protected";
  quantity: number;
  unit: "piece" | "gram";
  unitPriceKopeks: number;
  minQuantity?: number;
  roundingRule?: RoundingRule;
};

export type QuoteInput = {
  organizationId: string;
  customerId: string;
  addressId: string;
  tariffVersionId: string;
  termsVersion: string;
  lines: ServiceLineInput[];
  pickupShared: boolean;
  deliveryShared: boolean;
  offSchedulePickupKopeks: number;
  offScheduleDeliveryKopeks: number;
  sharedPickupFeeKopeks?: number;
  sharedDeliveryFeeKopeks?: number;
  expiresAt: string;
  /**
   * What the customer declared they were handing over. It rides inside the
   * immutable snapshot, so the courier's acceptance can be reconciled against
   * it later — the declaration can never be edited behind the customer's back.
   */
  declaredItems?: DeclaredItem[];
};

export type QuoteLine = {
  kind: "service" | "pickup_fee" | "delivery_fee";
  serviceId?: string;
  tier?: "economy" | "protected";
  description: string;
  quantity: number;
  unit: string;
  amountKopeks: number;
  source: "tariff" | "exception";
  tariffVersionId: string;
  /**
   * The price basis the line was priced with. It rides inside the immutable quote
   * snapshot so that a later recalculation — a weight variance, for instance — can be
   * priced by the very same formula instead of by today's tariff.
   */
  unitPriceKopeks?: number;
  roundingRule?: RoundingRule;
  minQuantity?: number;
};

/**
 * The one pricing formula of the platform: a piece is priced per piece; a gram-priced
 * line is priced either proportionally per kilogram (`exact`), rounded up to 100 g steps
 * (`gram_up_to_100`), or rounded up to whole kilograms (`gram_up_to_1000`).
 * Every amount that ever reaches a customer is produced here, so a recalculation of an
 * existing quote is guaranteed to agree with the original one.
 */
export function priceServiceAmount(input: {
  quantity: number;
  unit: "piece" | "gram";
  unitPriceKopeks: number;
  minQuantity?: number;
  roundingRule?: RoundingRule;
}): number {
  const quantity = Math.max(input.quantity, input.minQuantity ?? 1);
  if (input.unit === "gram") {
    if (input.roundingRule === "exact") {
      return assertKopeks(Math.round((quantity * input.unitPriceKopeks) / 1000));
    }
    const step = input.roundingRule === "gram_up_to_100" ? 100 : 1000;
    return assertKopeks(Math.ceil(quantity / step) * input.unitPriceKopeks);
  }
  return assertKopeks(Math.ceil(quantity * input.unitPriceKopeks));
}

export type QuoteResult = {
  lines: QuoteLine[];
  totalKopeks: number;
  quoteHash: string;
  snapshot: Record<string, unknown>;
};

/** Pure, deterministic pricing. Every rate comes from an immutable tariff snapshot. */
export function calculateQuote(input: QuoteInput): QuoteResult {
  if (!input.lines.length) throw new Error("NO_SERVICE_LINES");
  const lines: QuoteLine[] = input.lines.map(line => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error("INVALID_QUANTITY");
    assertKopeks(line.unitPriceKopeks, "unit_price");
    return {
      kind: "service",
      serviceId: line.serviceId,
      tier: line.tier,
      description: `${line.tier}:${line.serviceId}`,
      quantity: Math.max(line.quantity, line.minQuantity ?? 1),
      unit: line.unit,
      amountKopeks: priceServiceAmount(line),
      source: "tariff",
      tariffVersionId: input.tariffVersionId,
      unitPriceKopeks: line.unitPriceKopeks,
      roundingRule: line.roundingRule,
      minQuantity: line.minQuantity,
    };
  });

  const pickupFee = input.pickupShared
    ? assertKopeks(input.sharedPickupFeeKopeks ?? 0)
    : assertKopeks(input.offSchedulePickupKopeks);
  const deliveryFee = input.deliveryShared
    ? assertKopeks(input.sharedDeliveryFeeKopeks ?? 0)
    : assertKopeks(input.offScheduleDeliveryKopeks);
  lines.push({
    kind: "pickup_fee", description: input.pickupShared ? "Общий забор" : "Внеплановый забор",
    quantity: 1, unit: "service", amountKopeks: pickupFee,
    source: input.pickupShared ? "tariff" : "exception", tariffVersionId: input.tariffVersionId,
  });
  lines.push({
    kind: "delivery_fee", description: input.deliveryShared ? "Общая доставка" : "Внеплановая доставка",
    quantity: 1, unit: "service", amountKopeks: deliveryFee,
    source: input.deliveryShared ? "tariff" : "exception", tariffVersionId: input.tariffVersionId,
  });

  const totalKopeks = lines.reduce((sum, line) => sum + line.amountKopeks, 0);
  const snapshot = {
    organizationId: input.organizationId,
    customerId: input.customerId,
    addressId: input.addressId,
    tariffVersionId: input.tariffVersionId,
    termsVersion: input.termsVersion,
    expiresAt: input.expiresAt,
    lines,
    totalKopeks,
    currency: "RUB",
    declaredItems: input.declaredItems ?? [],
  };
  return { lines, totalKopeks, quoteHash: hashRequest(snapshot), snapshot };
}
