import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { customerAddresses, priceRules, quotes, services, serviceWindows } from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotency } from "../core/idempotency.js";
import { calculateQuote, type QuoteInput, type ServiceLineInput } from "../domain/pricing.js";
import { releaseHeldReservationsInTx } from "../domain/slot-reservation.js";
import { activeTariff, resolveAddress } from "./catalog.js";
import { normalizeDeclaredItems, type DeclaredItem } from "../../shared/garment-taxonomy.js";

export type QuoteLineInput = {
  serviceId: string;
  tier: "economy" | "protected";
  quantity: number;
  unit: "piece" | "gram";
};

/**
 * One declared piece of laundry, with the value the customer states for it.
 *
 * The value is optional: a customer may hand over things without stating what they are worth,
 * and the courier then leaves the field empty instead of inventing a number.
 */
export type DeclaredItemInput = {
  subtypeId: string;
  quantity: number;
  /** The declared value in kopeks. `null` means "not declared". */
  declaredValueKopeks?: number | null;
};

export type CreateQuoteInput = {
  organizationId?: string;
  customerId?: string;
  buildingId: string;
  addressId?: string;
  tariffVersionId?: string;
  lines: QuoteLineInput[];
  pickupWindowId: string;
  deliveryWindowId: string;
  offSchedulePickup?: boolean;
  offScheduleDelivery?: boolean;
  /**
   * What the customer says they are handing over. It is validated against the
   * shared taxonomy, folded into the immutable quote snapshot and therefore
   * into the quote hash: the declaration the courier reconciles against is the
   * one the customer actually accepted.
   */
  declaredItems?: DeclaredItemInput[];
  /**
   * Optional prior unattached held slot reservation IDs from an earlier quote attempt
   * that should be released atomically when the customer re-quotes after editing the form.
   */
  releaseReservationIds?: string[];
  key: string;
  now?: Date;
};

export async function createQuote(db: Db, principal: Principal, input: CreateQuoteInput) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher);
  const customerId = hasRole(principal, "customer") ? principal.userId : input.customerId;
  if (!customerId) throw errors.forbidden();
  const now = input.now ?? new Date();
  // Validated before the idempotency envelope is opened: an unknown subtype or
  // an out-of-range quantity is a client mistake, not a replay.
  const declared = normalizeDeclaredItems(
    input.declaredItems?.map(item => ({ subtypeId: item.subtypeId, quantity: item.quantity })),
  );
  if (!declared.ok) {
    throw new AppError("VALIDATION_ERROR", declared.error, declared.detail ?? {});
  }
  // The declared value is the customer's own statement about one piece. It is optional, and a
  // negative or fractional number is a client mistake rather than a value to reinterpret.
  const declaredValueBySubtype = new Map<string, number | null>();
  for (const item of input.declaredItems ?? []) {
    if (item.declaredValueKopeks === undefined || item.declaredValueKopeks === null) continue;
    if (!Number.isInteger(item.declaredValueKopeks) || item.declaredValueKopeks < 0) {
      throw new AppError("VALIDATION_ERROR", "DECLARED_VALUE_INVALID", {
        subtypeId: item.subtypeId,
        declaredValueKopeks: item.declaredValueKopeks,
      });
    }
    if (!declaredValueBySubtype.has(item.subtypeId)) {
      declaredValueBySubtype.set(item.subtypeId, item.declaredValueKopeks);
    }
  }
  // The taxonomy normalizes the declaration; the declared value rides along with its subtype so
  // that it lands in the immutable snapshot as well.
  const declaredWithValue = declared.items.map(item => ({
    ...item,
    declaredValueKopeks: declaredValueBySubtype.get(item.subtypeId) ?? null,
  }));
  // Эконом is a closed, weighed bag: the tariff promises no per-item inventory, so a
  // per-item list on such a quote would contradict what the customer was sold.
  if (declared.items.length > 0 && !input.lines.some(line => line.tier === "protected")) {
    throw new AppError("VALIDATION_ERROR", "DECLARATION_REQUIRES_PROTECTED_TIER");
  }
  const requestHash = hashRequest({ ...input, customerId, principalId: principal.userId });

  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "quote:create",
    key: input.key,
    actorId: principal.userId,
    requestHash,
  }, async tx => {
    await resolveAddress(tx as Db, principal, input.buildingId);
    let address: { id: string } | undefined;
    if (input.addressId) {
      [address] = await tx.select({ id: customerAddresses.id }).from(customerAddresses).where(and(
        eq(customerAddresses.id, input.addressId),
        eq(customerAddresses.organizationId, principal.organizationId),
        eq(customerAddresses.customerId, customerId),
        eq(customerAddresses.buildingId, input.buildingId),
      )).limit(1);
      if (!address) throw errors.notFound("address");
    } else {
      [address] = await tx.select({ id: customerAddresses.id }).from(customerAddresses).where(and(
        eq(customerAddresses.organizationId, principal.organizationId),
        eq(customerAddresses.customerId, customerId),
        eq(customerAddresses.buildingId, input.buildingId),
      )).limit(1);
      if (!address) throw new AppError("VALIDATION_ERROR", "CUSTOMER_ADDRESS_REQUIRED");
    }
    const tariff = await activeTariff(tx as Db, principal, input.tariffVersionId, now);
    const [pickupWindow] = await tx.select().from(serviceWindows).where(and(
      eq(serviceWindows.id, input.pickupWindowId),
      eq(serviceWindows.organizationId, principal.organizationId),
      eq(serviceWindows.buildingId, input.buildingId),
      eq(serviceWindows.kind, "pickup"),
      eq(serviceWindows.status, "open"),
    )).limit(1);
    const [deliveryWindow] = await tx.select().from(serviceWindows).where(and(
      eq(serviceWindows.id, input.deliveryWindowId),
      eq(serviceWindows.organizationId, principal.organizationId),
      eq(serviceWindows.buildingId, input.buildingId),
      eq(serviceWindows.kind, "delivery"),
      eq(serviceWindows.status, "open"),
    )).limit(1);
    if (!pickupWindow || !deliveryWindow) throw errors.notFound("window");

    const serviceIds = input.lines.map(line => line.serviceId);
    const serviceRows = await tx.select().from(services).where(and(
      eq(services.organizationId, principal.organizationId),
      // A service withdrawn from the catalogue must not stay purchasable.
      eq(services.active, true),
      inArray(services.id, serviceIds),
    ));
    const ruleRows = await tx.select().from(priceRules).where(eq(priceRules.tariffVersionId, tariff.id));
    const priced: ServiceLineInput[] = input.lines.map(line => {
      const service = serviceRows.find(row => row.id === line.serviceId);
      const rule = ruleRows.find(row => row.serviceId === line.serviceId && row.tier === line.tier && row.active);
      if (!service || !rule) throw new AppError("VALIDATION_ERROR", "SERVICE_NOT_AVAILABLE", { serviceId: line.serviceId });
      // The unit has to match the catalogue in both directions. Checking only "gram against a
      // piece service" let a client price three pieces of a gram-priced wash as three grams.
      if (line.unit !== service.unit) {
        throw new AppError("VALIDATION_ERROR", "UNIT_MISMATCH", {
          serviceId: line.serviceId, requested: line.unit, expected: service.unit,
        });
      }
      // `price_rules.rounding_rule` is free text without a database constraint. An unknown value
      // would fall through to the per-kilogram branch and quietly price the line ten times too
      // low, so it is rejected instead of reinterpreted.
      if (
        rule.roundingRule !== "exact"
        && rule.roundingRule !== "gram_up_to_100"
        && rule.roundingRule !== "gram_up_to_1000"
      ) {
        throw new AppError("VALIDATION_ERROR", "UNKNOWN_ROUNDING_RULE", {
          serviceId: line.serviceId, roundingRule: rule.roundingRule,
        });
      }
      return {
        serviceId: line.serviceId,
        tier: line.tier,
        quantity: line.quantity,
        unit: service.unit as "piece" | "gram",
        unitPriceKopeks: rule.unitPriceKopeks,
        minQuantity: rule.minQuantity,
        roundingRule: rule.roundingRule,
      };
    });

    const expiresAt = new Date(now.getTime() + tariff.quoteTtlMinutes * 60_000);
    const pricingInput: QuoteInput = {
      organizationId: principal.organizationId,
      customerId,
      addressId: address.id,
      tariffVersionId: tariff.id,
      termsVersion: tariff.termsVersion,
      lines: priced,
      pickupShared: !input.offSchedulePickup && pickupWindow.isShared,
      deliveryShared: !input.offScheduleDelivery && deliveryWindow.isShared,
      offSchedulePickupKopeks: tariff.offSchedulePickupKopeks,
      offScheduleDeliveryKopeks: tariff.offScheduleDeliveryKopeks,
      sharedPickupFeeKopeks: tariff.sharedPickupFeeKopeks,
      sharedDeliveryFeeKopeks: tariff.sharedDeliveryFeeKopeks,
      expiresAt: expiresAt.toISOString(),
      declaredItems: declaredWithValue,
    };
    const pricedQuote = calculateQuote(pricingInput);
    const [quote] = await tx.insert(quotes).values({
      organizationId: principal.organizationId,
      customerId,
      tariffVersionId: tariff.id,
      state: "active",
      snapshotJson: pricedQuote.snapshot,
      quoteHash: pricedQuote.quoteHash,
      totalKopeks: pricedQuote.totalKopeks,
      expiresAt,
    }).returning();
    const releasedReservationIds = input.releaseReservationIds?.length
      ? await releaseHeldReservationsInTx(tx, {
        principal,
        reservationIds: input.releaseReservationIds,
        reason: "Released on re-quote",
        ownerPrincipalId: customerId,
      })
      : [];
    await appendEvent(tx, {
      principal,
      aggregateType: "quote",
      aggregateId: quote.id,
      eventType: "quote.created",
      payload: {
        totalKopeks: quote.totalKopeks,
        quoteHash: quote.quoteHash,
        releasedReservationIds,
      },
    });
    return {
      id: quote.id,
      organizationId: quote.organizationId,
      customerId: quote.customerId,
      addressId: address.id,
      tariffVersionId: tariff.id,
      termsVersion: tariff.termsVersion,
      expiresAt: quote.expiresAt.toISOString(),
      quoteHash: quote.quoteHash,
      totalKopeks: quote.totalKopeks,
      lines: pricedQuote.lines,
      declaredItems: declaredWithValue,
      snapshot: pricedQuote.snapshot,
      releasedReservationIds,
    };
  });
  return { ...result.value, replayed: result.replayed };
}

export async function getQuote(db: Db, principal: Principal, quoteId: string) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance);
  const [quote] = await db.select().from(quotes).where(and(
    eq(quotes.id, quoteId),
    eq(quotes.organizationId, principal.organizationId),
  )).limit(1);
  if (!quote) throw errors.notFound("quote");
  if (hasRole(principal, "customer") && quote.customerId !== principal.userId) throw errors.notFound("quote");
  const snapshot = (quote.snapshotJson ?? {}) as {
    addressId?: string;
    termsVersion?: string;
    declaredItems?: Array<DeclaredItem & { declaredValueKopeks?: number | null }>;
  };
  return {
    ...quote,
    addressId: snapshot.addressId ?? null,
    termsVersion: snapshot.termsVersion ?? null,
    // The declaration is part of the immutable snapshot, so the value the customer stated
    // is readable together with the quote it belongs to — by the customer (who declared it)
    // and by the courier (who confirms it at intake).
    declaredItems: snapshot.declaredItems ?? [],
  };
}

export async function assertAcceptableQuote(
  db: Db,
  principal: Principal,
  quoteId: string,
  acceptedHash: string,
  now = new Date(),
) {
  const quote = await getQuote(db, principal, quoteId);
  if (quote.state !== "active") throw new AppError("CONFLICT_VERSION", "QUOTE_NOT_ACTIVE");
  if (quote.quoteHash !== acceptedHash) throw new AppError("CONFLICT_VERSION", "QUOTE_HASH_MISMATCH");
  if (quote.expiresAt <= now) throw new AppError("QUOTE_EXPIRED");
  return quote;
}
