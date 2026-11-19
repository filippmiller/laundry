import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  batches, batchItems, containerAssignments, containers, custodyDiscrepancies, custodyEvents,
  customerApprovals, customerInvoiceLines, customerInvoices, garments, intakeManifestLines, intakeManifests,
  orderAdjustments, orderLines, orders, partnerContracts, partnerCreditNotes, partnerInvoiceLines,
  partnerPriceVersions, partners, partnerReceiptLines, partnerReceipts, partnerServiceAccruals,
  paymentIntents, processingOperations, qualityChecks, routeStops, seals, slotReservations,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotency, withIdempotencyFlat } from "../core/idempotency.js";
import { nextState, nextStateAsSystem, type OrderState } from "../domain/order-state.js";
import { releaseSlot } from "../domain/slot-reservation.js";
import {
  describeWeightVariance, measureOrderWeightVariance,
  WEIGHT_VARIANCE_MIN_GRAMS, WEIGHT_VARIANCE_MIN_RATIO,
} from "./weight-variance.js";

export type ActualBag = { containerCode: string; sealSerial: string; actualWeightGrams: number };

/**
 * Fallback wholesale rates when a contract does not carry them.
 *
 * 600 ₽ per kilogram is the figure the operating documents use for a partner's wholesale price.
 * A piece-priced service has no agreed default: a flat rate for ironing and for dry cleaning
 * would be wrong in both directions, so the fallback is zero and the line accrues nothing until
 * the contract states a rate.
 */
const DEFAULT_WHOLESALE_PER_KG_KOPEKS = 60_000;
const DEFAULT_WHOLESALE_PER_PIECE_KOPEKS = 0;

type WholesaleTerms = {
  wholesalePerKgKopeks?: number;
  wholesalePerPieceKopeks?: number;
};

/**
 * Selects the latest active, signed wholesale contract for a partner and its active
 * `partner_price_versions` row (if any). Unsigned, future, and expired contracts are excluded.
 */
async function resolveActivePartnerContract(tx: Tx, partnerId: string, now = new Date()) {
  const [contract] = await tx.select().from(partnerContracts).where(and(
    eq(partnerContracts.partnerId, partnerId),
    eq(partnerContracts.signed, true),
    lte(partnerContracts.effectiveFrom, now),
    or(isNull(partnerContracts.effectiveTo), gte(partnerContracts.effectiveTo, now)),
  )).orderBy(desc(partnerContracts.version), desc(partnerContracts.effectiveFrom)).limit(1);
  if (!contract) return null;

  const [priceVersion] = await tx.select().from(partnerPriceVersions).where(and(
    eq(partnerPriceVersions.contractId, contract.id),
    lte(partnerPriceVersions.effectiveFrom, now),
  )).orderBy(desc(partnerPriceVersions.effectiveFrom), desc(partnerPriceVersions.version)).limit(1);

  const priceTerms = (priceVersion?.pricesJson ?? {}) as WholesaleTerms;
  const contractTerms = (contract.termsJson ?? {}) as WholesaleTerms;
  return {
    contract,
    priceVersion: priceVersion ?? null,
    wholesalePerKgKopeks: priceTerms.wholesalePerKgKopeks
      ?? contractTerms.wholesalePerKgKopeks
      ?? DEFAULT_WHOLESALE_PER_KG_KOPEKS,
    wholesalePerPieceKopeks: priceTerms.wholesalePerPieceKopeks
      ?? contractTerms.wholesalePerPieceKopeks
      ?? DEFAULT_WHOLESALE_PER_PIECE_KOPEKS,
  };
}

async function resolveWholesaleRatesForAccrual(
  tx: Tx,
  contractId: string,
  contractPriceVersionId: string | null,
) {
  const [contract] = await tx.select().from(partnerContracts)
    .where(eq(partnerContracts.id, contractId)).limit(1);
  const [priceVersion] = contractPriceVersionId
    ? await tx.select().from(partnerPriceVersions)
      .where(eq(partnerPriceVersions.id, contractPriceVersionId)).limit(1)
    : [undefined];
  const priceTerms = (priceVersion?.pricesJson ?? {}) as WholesaleTerms;
  const contractTerms = (contract?.termsJson ?? {}) as WholesaleTerms;
  return {
    wholesalePerKgKopeks: priceTerms.wholesalePerKgKopeks
      ?? contractTerms.wholesalePerKgKopeks
      ?? DEFAULT_WHOLESALE_PER_KG_KOPEKS,
    wholesalePerPieceKopeks: priceTerms.wholesalePerPieceKopeks
      ?? contractTerms.wholesalePerPieceKopeks
      ?? DEFAULT_WHOLESALE_PER_PIECE_KOPEKS,
  };
}

/**
 * Reconciles `partner_service_accruals` for gram-priced order lines once actual received weight
 * is finalized. Unbilled accruals are updated in place; already-invoiced accruals receive a
 * delta accrual row so partner settlement matches the actual weighed quantity.
 */
async function reconcilePartnerAccrualsForOrder(tx: Tx, organizationId: string, orderId: string) {
  const lines = await tx.select().from(orderLines).where(and(
    eq(orderLines.orderId, orderId),
    eq(orderLines.unit, "gram"),
  ));
  for (const line of lines) {
    if (line.actualQuantity == null) continue;
    const accruals = await tx.select().from(partnerServiceAccruals).where(and(
      eq(partnerServiceAccruals.organizationId, organizationId),
      eq(partnerServiceAccruals.orderLineId, line.id),
      ne(partnerServiceAccruals.status, "voided"),
    ));
    if (!accruals.length) continue;

    const primary = accruals[0];
    const rates = await resolveWholesaleRatesForAccrual(
      tx,
      primary.contractId,
      primary.contractPriceVersionId,
    );
    const targetAmountKopeks = Math.ceil((line.actualQuantity * rates.wholesalePerKgKopeks) / 1000);
    const currentTotalAmount = accruals.reduce((sum, row) => sum + row.amountKopeks, 0);
    const currentTotalQty = accruals.reduce((sum, row) => sum + row.quantity, 0);
    if (targetAmountKopeks === currentTotalAmount && line.actualQuantity === currentTotalQty) {
      continue;
    }

    const hasInvoiced = accruals.some(row => row.status === "accrued");
    if (!hasInvoiced) {
      const updated = await tx.update(partnerServiceAccruals).set({
        quantity: line.actualQuantity,
        amountKopeks: targetAmountKopeks,
      }).where(and(
        eq(partnerServiceAccruals.id, primary.id),
        eq(partnerServiceAccruals.status, "estimated"),
      )).returning({ id: partnerServiceAccruals.id });
      if (updated.length) continue;
    }
    const deltaAmountKopeks = targetAmountKopeks - currentTotalAmount;
    const deltaQuantity = line.actualQuantity - currentTotalQty;
    if (deltaAmountKopeks !== 0) {
      await tx.insert(partnerServiceAccruals).values({
        organizationId,
        partnerId: primary.partnerId,
        orderLineId: line.id,
        contractId: primary.contractId,
        contractPriceVersionId: primary.contractPriceVersionId,
        quantity: deltaQuantity,
        amountKopeks: deltaAmountKopeks,
        status: "estimated",
      });
    }
  }
}

/**
 * Voids unbilled partner accruals when an order is returned unprocessed, and creates an
 * offsetting credit accrual (and partner credit note when an invoice line exists) for any
 * accrual that was already billed on a partner invoice.
 */
async function voidPartnerAccrualsForOrder(
  tx: Tx,
  organizationId: string,
  orderId: string,
  reason: string,
) {
  const lines = await tx.select({ id: orderLines.id }).from(orderLines)
    .where(eq(orderLines.orderId, orderId));
  if (!lines.length) return { voidedAccruals: 0, creditedAccruals: 0 };

  const lineIds = lines.map(row => row.id);
  const accruals = await tx.select().from(partnerServiceAccruals).where(and(
    eq(partnerServiceAccruals.organizationId, organizationId),
    inArray(partnerServiceAccruals.orderLineId, lineIds),
    ne(partnerServiceAccruals.status, "voided"),
  ));

  let voidedAccruals = 0;
  let creditedAccruals = 0;
  for (const accrual of accruals) {
    if (accrual.status === "estimated") {
      const voided = await tx.update(partnerServiceAccruals).set({
        status: "voided",
        amountKopeks: 0,
      }).where(and(
        eq(partnerServiceAccruals.id, accrual.id),
        eq(partnerServiceAccruals.status, "estimated"),
      )).returning({ id: partnerServiceAccruals.id });
      if (voided.length) {
        voidedAccruals += 1;
        continue;
      }
    }
    if (accrual.amountKopeks !== 0) {
      const [invoiceLine] = await tx.select().from(partnerInvoiceLines)
        .where(eq(partnerInvoiceLines.accrualId, accrual.id)).limit(1);
      if (invoiceLine && accrual.amountKopeks > 0) {
        await tx.insert(partnerCreditNotes).values({
          organizationId,
          invoiceId: invoiceLine.invoiceId,
          originalLineId: invoiceLine.id,
          amountKopeks: accrual.amountKopeks,
          reason,
          state: "draft",
        });
      }
      await tx.insert(partnerServiceAccruals).values({
        organizationId,
        partnerId: accrual.partnerId,
        orderLineId: accrual.orderLineId,
        contractId: accrual.contractId,
        contractPriceVersionId: accrual.contractPriceVersionId,
        quantity: -accrual.quantity,
        amountKopeks: -accrual.amountKopeks,
        status: "estimated",
      });
      creditedAccruals += 1;
    }
  }
  return { voidedAccruals, creditedAccruals };
}

/**
 * Partner actions are only valid for the partner that custody was assigned to. An unassigned
 * order is never implicitly claimed by the partner making the request.
 */
function assertAssignedPartner(order: { assignedPartnerId: string | null }, principal: Principal) {
  if (!principal.partnerId) throw errors.forbidden("partner scope required");
  if (!order.assignedPartnerId || order.assignedPartnerId !== principal.partnerId) {
    throw errors.notFound("order");
  }
}

export async function assignOrderToPartner(
  db: Db,
  principal: Principal,
  input: { orderId: string; partnerId: string; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "order:assign_partner", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    const [partner] = await tx.select({ id: partners.id }).from(partners).where(and(
      eq(partners.id, input.partnerId), eq(partners.organizationId, principal.organizationId),
    )).limit(1);
    if (!partner) throw errors.notFound("partner");
    if (order.assignedPartnerId && order.assignedPartnerId !== partner.id) {
      throw new AppError("CUSTODY_CONFLICT", "ORDER_ALREADY_ASSIGNED", { partnerId: order.assignedPartnerId });
    }
    if (["partner_received", "inspection", "processing", "quality_check", "ready"].includes(order.lifecycleState)) {
      throw errors.transition(order.lifecycleState, "assign_partner");
    }
    await tx.update(orders).set({ assignedPartnerId: partner.id, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: "order.partner_assigned", payload: { partnerId: partner.id },
    });
    return { orderId: order.id, partnerId: partner.id };
  });
}

export async function receiveHandoff(
  db: Db,
  principal: Principal,
  input: { orderId: string; manifestId: string; actual: ActualBag[]; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.partner);
  try {
    const result = await withIdempotency(db, {
      organizationId: principal.organizationId,
      scope: "partner:receipt",
      key: input.key,
      actorId: principal.userId,
      requestHash: hashRequest({ ...input, actorId: principal.userId }),
    }, async tx => {
      await tx.execute(sql`
        SELECT id FROM orders WHERE id = ${input.orderId} AND organization_id = ${principal.organizationId} FOR UPDATE
      `);
      const [order] = await tx.select().from(orders).where(and(
        eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
      )).limit(1);
      if (!order) throw errors.notFound("order");
      assertAssignedPartner(order, principal);
      if (!["picked_up", "at_hub"].includes(order.lifecycleState)) {
        throw new AppError("INVALID_TRANSITION", "ORDER_NOT_AWAITING_RECEIPT", { state: order.lifecycleState });
      }
      const [manifest] = await tx.select().from(intakeManifests).where(and(
        eq(intakeManifests.id, input.manifestId),
        eq(intakeManifests.organizationId, principal.organizationId),
        eq(intakeManifests.orderId, input.orderId),
      )).limit(1);
      if (!manifest) throw errors.notFound("manifest");

      const expected = await tx.select({
        containerCode: containers.code,
        sealSerial: seals.serialNumber,
      }).from(containerAssignments)
        .innerJoin(containers, eq(containerAssignments.containerId, containers.id))
        .innerJoin(seals, eq(containerAssignments.sealId, seals.id))
        .where(and(
          eq(containerAssignments.organizationId, principal.organizationId),
          eq(containerAssignments.orderId, input.orderId),
        ));
      const expectedKeys = expected.map(row => `${row.containerCode}:${row.sealSerial}`).sort();
      const actualKeys = input.actual.map(row => `${row.containerCode}:${row.sealSerial}`).sort();
      const expectedHash = hashRequest(expectedKeys);
      const actualHash = hashRequest(actualKeys);
      const mismatch = expectedHash !== actualHash;

      const [receipt] = await tx.insert(partnerReceipts).values({
        organizationId: principal.organizationId,
        partnerId: principal.partnerId!,
        orderId: input.orderId,
        manifestId: input.manifestId,
        expectedHash,
        actualHash,
        state: mismatch ? "discrepancy" : "accepted",
        receivedBy: principal.userId,
        receivedAt: new Date(),
      }).returning();

      let incidentId: string | null = null;
      if (mismatch) {
        const [incident] = await tx.insert(custodyDiscrepancies).values({
          organizationId: principal.organizationId,
          orderId: input.orderId,
          kind: "manifest_mismatch",
          detailsJson: { expectedKeys, actualKeys },
          openedBy: principal.userId,
        }).returning();
        incidentId = incident.id;
        await tx.update(partnerReceipts).set({ discrepancyId: incident.id }).where(eq(partnerReceipts.id, receipt.id));
        await appendEvent(tx, {
          principal, aggregateType: "order", aggregateId: input.orderId,
          eventType: "custody.discrepancy", reason: "manifest mismatch",
          payload: { incidentId, expectedHash, actualHash },
        });
        return { status: "discrepancy" as const, incidentId, receiptId: receipt.id };
      }

      const manifestBagWeights = await tx.select({
        description: intakeManifestLines.description,
        weightGrams: intakeManifestLines.weightGrams,
      }).from(intakeManifestLines).where(eq(intakeManifestLines.manifestId, manifest.id));
      // Every bag has its own weight in the manifest; the manifest total is only the sum
      // of them, so a receipt line must never claim the whole order's weight.
      const expectedWeightByCode = new Map(
        manifestBagWeights
          .filter(line => line.description.startsWith("bag:"))
          .map(line => [line.description.slice(4), line.weightGrams]),
      );

      for (const bag of input.actual) {
        const expectedBag = expected.find(row => row.containerCode === bag.containerCode);
        const [container] = await tx.select().from(containers).where(and(
          eq(containers.organizationId, principal.organizationId),
          eq(containers.code, bag.containerCode),
        )).limit(1);
        const [seal] = await tx.select().from(seals).where(and(
          eq(seals.organizationId, principal.organizationId),
          eq(seals.serialNumber, bag.sealSerial),
        )).limit(1);
        if (!seal || seal.state !== "assigned") {
          throw new AppError("CUSTODY_CONFLICT", "SEAL_NOT_INTACT", {
            containerCode: bag.containerCode,
            serial: bag.sealSerial,
            state: seal?.state ?? "unknown",
          });
        }
        const expectedWeightGrams = expectedWeightByCode.get(bag.containerCode)
          ?? (input.actual.length > 0 && manifest.weightGrams != null
            ? Math.round(manifest.weightGrams / input.actual.length)
            : manifest.weightGrams);
        const absDiff = expectedWeightGrams != null
          ? Math.abs(bag.actualWeightGrams - expectedWeightGrams)
          : 0;
        const weightMismatch = expectedWeightGrams != null
          && expectedWeightGrams > 0
          && absDiff >= WEIGHT_VARIANCE_MIN_GRAMS
          && absDiff / expectedWeightGrams >= WEIGHT_VARIANCE_MIN_RATIO;

        await tx.insert(partnerReceiptLines).values({
          receiptId: receipt.id,
          containerId: container.id,
          expectedSealId: seal.id,
          actualSealId: seal.id,
          expectedWeightGrams,
          actualWeightGrams: bag.actualWeightGrams,
          status: weightMismatch ? "weight_mismatch" : "matched",
        });

        if (weightMismatch) {
          const [incident] = await tx.insert(custodyDiscrepancies).values({
            organizationId: principal.organizationId,
            orderId: input.orderId,
            kind: "weight_mismatch",
            detailsJson: {
              containerCode: bag.containerCode,
              expectedWeightGrams,
              actualWeightGrams: bag.actualWeightGrams,
              deltaGrams: bag.actualWeightGrams - expectedWeightGrams,
            },
            openedBy: principal.userId,
          }).returning();
          if (!incidentId) {
            incidentId = incident.id;
            await tx.update(partnerReceipts).set({ discrepancyId: incident.id })
              .where(eq(partnerReceipts.id, receipt.id));
          }
          await appendEvent(tx, {
            principal, aggregateType: "order", aggregateId: input.orderId,
            eventType: "custody.discrepancy", reason: "weight mismatch on partner receipt",
            payload: {
              incidentId: incident.id,
              containerCode: bag.containerCode,
              expectedWeightGrams,
              actualWeightGrams: bag.actualWeightGrams,
            },
          });
        }
        void expectedBag;
      }

      await tx.insert(custodyEvents).values({
        organizationId: principal.organizationId,
        orderId: input.orderId,
        fromParty: "courier",
        toParty: "partner",
        actorId: principal.userId,
        manifestId: input.manifestId,
        manifestHash: manifest.manifestHash,
      });

      const to = nextState(order.lifecycleState as "picked_up" | "at_hub", "partner_receive", principal);
      const [advanced] = await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
        .returning({ version: orders.version });
      if (!advanced) throw errors.version(order.version);

      // Complete the pickup courier's active pickup stop once custody transfers to the partner,
      // revoking post-handoff ABAC read/scan access on this order.
      await tx.update(routeStops).set({
        state: "completed",
        version: sql`${routeStops.version} + 1`,
      }).where(and(
        eq(routeStops.organizationId, principal.organizationId),
        eq(routeStops.orderId, order.id),
        eq(routeStops.kind, "pickup"),
        inArray(routeStops.state, ["pending", "en_route", "arrived"]),
      ));

      const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, input.orderId));
      const resolvedContract = await resolveActivePartnerContract(tx, principal.partnerId!);
      if (resolvedContract) {
        const { contract, priceVersion, wholesalePerKgKopeks, wholesalePerPieceKopeks } = resolvedContract;
        for (const line of lines) {
          const amountKopeks = line.unit === "gram"
            ? Math.ceil(line.quotedQuantity * wholesalePerKgKopeks / 1000)
            : line.quotedQuantity * wholesalePerPieceKopeks;
          await tx.insert(partnerServiceAccruals).values({
            organizationId: principal.organizationId,
            partnerId: principal.partnerId!,
            orderLineId: line.id,
            contractId: contract.id,
            contractPriceVersionId: priceVersion?.id ?? null,
            quantity: line.quotedQuantity,
            amountKopeks,
            status: "estimated",
          });
        }
      }

      await appendEvent(tx, {
        principal, aggregateType: "order", aggregateId: input.orderId,
        eventType: "order.partner_receive", payload: { receiptId: receipt.id, manifestHash: manifest.manifestHash },
      });
      return { status: "accepted" as const, incidentId, receiptId: receipt.id };
    });
    return { ...result.value, replayed: result.replayed };
  } catch (error) {
    // A broken/void seal rolls back the custody transfer so the partner never accepts
    // tampered bags, but the custody discrepancy incident must survive the rollback.
    if (error instanceof AppError && error.code === "CUSTODY_CONFLICT" && error.message === "SEAL_NOT_INTACT") {
      await db.transaction(async incidentTx => {
        const [incident] = await incidentTx.insert(custodyDiscrepancies).values({
          organizationId: principal.organizationId,
          orderId: input.orderId,
          kind: "seal_not_intact",
          detailsJson: error.details ?? {},
          openedBy: principal.userId,
        }).returning();
        await appendEvent(incidentTx, {
          principal,
          aggregateType: "order",
          aggregateId: input.orderId,
          eventType: "custody.discrepancy",
          reason: "seal not intact on partner receipt",
          payload: { incidentId: incident.id, ...(error.details ?? {}) },
        });
      });
    }
    throw error;
  }
}

export async function reportSealBroken(
  db: Db,
  principal: Principal,
  input: { orderId: string; sealSerial: string; reason: string; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.partner, "hub_worker", ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "custody:seal_broken",
    key: input.key, actorId: principal.userId, requestHash: hashRequest(input),
  }, async tx => {
    const [seal] = await tx.select().from(seals).where(and(
      eq(seals.serialNumber, input.sealSerial),
      eq(seals.organizationId, principal.organizationId),
    )).limit(1);
    if (!seal) throw errors.notFound("seal");
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    if (hasRole(principal, ...ROLE_GROUPS.partner)) assertAssignedPartner(order, principal);
    await tx.update(seals).set({ state: "broken" }).where(eq(seals.id, seal.id));
    const [incident] = await tx.insert(custodyDiscrepancies).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      kind: "seal_broken",
      detailsJson: { sealSerial: input.sealSerial },
      openedBy: principal.userId,
    }).returning();
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: "custody.seal_broken", reason: input.reason,
      payload: { incidentId: incident.id, sealSerial: input.sealSerial },
    });
    return { incidentId: incident.id, state: "broken" as const };
  });
}

/**
 * Records what was really received on the order lines and, when the weighing disagrees
 * with the quote by enough to matter, proposes the difference to the customer.
 *
 * The proposal is never applied on the spot: a weight difference is money, and money is
 * only taken from a customer with their consent. The partner only says what the scales
 * said; the customer decides what to pay.
 */
async function proposeWeightAdjustment(
  tx: Db,
  principal: Principal,
  order: { id: string; customerId: string; organizationId: string },
) {
  const measurement = await measureOrderWeightVariance(tx, order.id, principal.organizationId);
  if (!measurement) return null;
  const { variance } = measurement;

  for (const line of variance.lines) {
    await tx.update(orderLines).set({
      actualQuantity: line.actualGrams,
      finalAmountKopeks: line.quotedAmountKopeks,
      status: "measured",
    }).where(eq(orderLines.id, line.lineId));
  }

  if (!variance.exceedsThreshold) return null;

  const reason = describeWeightVariance(variance);
  const [adjustment] = await tx.insert(orderAdjustments).values({
    organizationId: principal.organizationId,
    orderId: order.id,
    proposedBy: principal.userId,
    reason,
    deltaKopeks: variance.deltaKopeks,
    detailsJson: {
      kind: "weight_variance",
      quotedGrams: variance.quotedGrams,
      receivedGrams: variance.receivedGrams,
      deltaGrams: variance.deltaGrams,
      lines: variance.lines.map(line => ({
        lineId: line.lineId,
        actualGrams: line.actualGrams,
        deltaGrams: line.deltaGrams,
        deltaKopeks: line.deltaKopeks,
      })),
    },
  }).returning();
  return { adjustmentId: adjustment.id, deltaKopeks: variance.deltaKopeks, reason };
}

/**
 * Writes the customer's decision into the order lines: on acceptance the line is worth
 * what the weighing showed, on a refusal it stays worth the quote the customer accepted.
 */
async function applyWeightDecision(tx: Db, adjustment: { detailsJson: unknown }, accept: boolean) {
  const details = (adjustment.detailsJson ?? {}) as {
    kind?: string;
    lines?: Array<{ lineId: string; deltaKopeks: number }>;
  };
  if (details.kind !== "weight_variance" || !details.lines?.length) return;
  for (const line of details.lines) {
    const [row] = await tx.select().from(orderLines).where(eq(orderLines.id, line.lineId)).limit(1);
    if (!row) continue;
    await tx.update(orderLines).set({
      finalAmountKopeks: accept ? row.quotedAmountKopeks + line.deltaKopeks : row.quotedAmountKopeks,
    }).where(eq(orderLines.id, row.id));
  }
}

export async function startInspection(db: Db, principal: Principal, input: { orderId: string; key: string }) {
  assertRole(principal, ...ROLE_GROUPS.partner);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "partner:inspection", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    assertAssignedPartner(order, principal);
    const to = nextState(order.lifecycleState as "partner_received", "inspect", principal);
    await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await appendEvent(tx, { principal, aggregateType: "order", aggregateId: order.id, eventType: "order.inspect" });

    // The partner's own scales may disagree with the quote. When they do, the customer
    // gets a proposal instead of a surprise on the invoice.
    const proposal = await proposeWeightAdjustment(tx as Db, principal, order);
    if (!proposal) {
      await reconcilePartnerAccrualsForOrder(tx, principal.organizationId, order.id);
      return { orderId: order.id, state: to, adjustment: null };
    }

    const awaiting = nextState("inspection", "propose_change", principal);
    await tx.update(orders).set({ lifecycleState: awaiting, version: order.version + 2 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version + 1)));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.propose_change",
      payload: { adjustmentId: proposal.adjustmentId, deltaKopeks: proposal.deltaKopeks, source: "weight_variance" },
    });
    return { orderId: order.id, state: awaiting, adjustment: proposal };
  });
}

export async function proposeAdjustment(
  db: Db,
  principal: Principal,
  input: { orderId: string; deltaKopeks: number; reason: string; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.partner);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "partner:adjustment", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    assertAssignedPartner(order, principal);
    if (order.lifecycleState !== "inspection") throw errors.transition(order.lifecycleState, "propose_change");
    const [adjustment] = await tx.insert(orderAdjustments).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      proposedBy: principal.userId,
      reason: input.reason,
      deltaKopeks: input.deltaKopeks,
    }).returning();
    const to = nextState("inspection", "propose_change", principal);
    await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.propose_change",
      payload: { adjustmentId: adjustment.id, deltaKopeks: input.deltaKopeks },
    });
    return { adjustmentId: adjustment.id, state: to };
  });
}

export async function decideAdjustment(
  db: Db,
  principal: Principal,
  input: { adjustmentId: string; accept: boolean; quoteHash: string; returnUnprocessed?: boolean; key: string },
) {
  assertRole(principal, "customer", ...ROLE_GROUPS.admin);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "adjustment:decision", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [adjRef] = await tx.select({ orderId: orderAdjustments.orderId }).from(orderAdjustments).where(and(
      eq(orderAdjustments.id, input.adjustmentId),
      eq(orderAdjustments.organizationId, principal.organizationId),
    )).limit(1);
    if (!adjRef) throw errors.notFound("adjustment");
    // Serialize adjustment decisions with concurrent captures, cancellations, and sibling decisions.
    await tx.execute(sql`
      SELECT id FROM orders WHERE id = ${adjRef.orderId} AND organization_id = ${principal.organizationId} FOR UPDATE
    `);
    const [adjustment] = await tx.select().from(orderAdjustments).where(and(
      eq(orderAdjustments.id, input.adjustmentId),
      eq(orderAdjustments.organizationId, principal.organizationId),
    )).limit(1);
    if (!adjustment) throw errors.notFound("adjustment");
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, adjustment.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    if (order.customerId !== principal.userId && !principal.roles.includes("platform_admin")) {
      throw errors.notFound("adjustment");
    }
    if (adjustment.state !== "proposed") throw new AppError("CONFLICT_VERSION", "ADJUSTMENT_NOT_OPEN");
    if (order.acceptedQuoteHash !== input.quoteHash) throw new AppError("CONFLICT_VERSION", "QUOTE_HASH_MISMATCH");

    const [decided] = await tx.update(orderAdjustments).set({ state: input.accept ? "accepted" : "declined" })
      .where(and(eq(orderAdjustments.id, adjustment.id), eq(orderAdjustments.state, "proposed")))
      .returning({ id: orderAdjustments.id });
    if (!decided) throw new AppError("CONFLICT_VERSION", "ADJUSTMENT_NOT_OPEN");
    const [approval] = await tx.insert(customerApprovals).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      adjustmentId: adjustment.id,
      quoteHash: order.acceptedQuoteHash,
      actorId: principal.userId,
      method: input.accept ? "web_accept" : "web_decline",
    }).returning();

    if (input.accept) {
      await applyWeightDecision(tx as Db, adjustment, true);
      await reconcilePartnerAccrualsForOrder(tx, principal.organizationId, order.id);
      const to = nextState(order.lifecycleState as "awaiting_approval", "approve_change", principal);
      const [advanced] = await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
        .returning({ version: orders.version });
      if (!advanced) throw errors.version(order.version);
      const existingInvoices = await tx.select().from(customerInvoices).where(and(
        eq(customerInvoices.organizationId, principal.organizationId),
        eq(customerInvoices.orderId, order.id),
        ne(customerInvoices.state, "cancelled"),
      ));
      const openInvoice = existingInvoices.find(inv => inv.state === "open");
      const hasPaidInvoice = existingInvoices.some(inv => inv.state === "paid");
      const captured = await tx.select({ id: paymentIntents.id }).from(paymentIntents).where(and(
        eq(paymentIntents.organizationId, principal.organizationId),
        eq(paymentIntents.orderId, order.id),
        inArray(paymentIntents.state, ["captured", "partially_refunded", "refunded"]),
      )).limit(1);

      let supplementalInvoiceId: string | null = null;
      let updatedOpenInvoice = false;
      if (openInvoice && !captured.length) {
        const [updatedInv] = await tx.update(customerInvoices).set({
          totalKopeks: openInvoice.totalKopeks + adjustment.deltaKopeks,
        }).where(and(
          eq(customerInvoices.id, openInvoice.id),
          eq(customerInvoices.state, "open"),
        )).returning({ id: customerInvoices.id });
        if (updatedInv) {
          updatedOpenInvoice = true;
          await tx.insert(customerInvoiceLines).values({
            invoiceId: openInvoice.id,
            kind: "adjustment",
            description: adjustment.reason,
            quantity: 1,
            amountKopeks: adjustment.deltaKopeks,
            tariffVersionId: null,
            taxMode: "none",
            source: "adjustment",
            consentId: approval.id,
            actorId: principal.userId,
          });
        }
      }
      if (!updatedOpenInvoice && (hasPaidInvoice || openInvoice) && adjustment.deltaKopeks > 0) {
        // The original invoice is already settled (or was concurrently paid): never mutate its total in place.
        // Issue a separate open supplemental invoice so the delta can be collected cleanly.
        const [supplemental] = await tx.insert(customerInvoices).values({
          organizationId: principal.organizationId,
          orderId: order.id,
          number: `INV-${order.publicNumber}-ADJ-${adjustment.id.slice(0, 8)}`,
          totalKopeks: adjustment.deltaKopeks,
          state: "open",
        }).returning();
        supplementalInvoiceId = supplemental.id;
        await tx.insert(customerInvoiceLines).values({
          invoiceId: supplemental.id,
          kind: "adjustment",
          description: adjustment.reason,
          quantity: 1,
          amountKopeks: adjustment.deltaKopeks,
          tariffVersionId: null,
          taxMode: "none",
          source: "adjustment",
          consentId: approval.id,
          actorId: principal.userId,
        });
        await appendEvent(tx, {
          principal, aggregateType: "invoice", aggregateId: supplemental.id,
          eventType: "invoice.created",
          payload: { orderId: order.id, totalKopeks: adjustment.deltaKopeks, adjustmentId: adjustment.id, supplemental: true },
        });
      }
      await appendEvent(tx, {
        principal, aggregateType: "order", aggregateId: order.id,
        eventType: "order.approve_change",
        payload: {
          adjustmentId: adjustment.id,
          deltaKopeks: adjustment.deltaKopeks,
          approvalId: approval.id,
          supplementalInvoiceId,
        },
      });
      return { orderId: order.id, adjustmentId: adjustment.id, state: to, supplementalInvoiceId };
    }

    const inspected = nextState(order.lifecycleState as "awaiting_approval", "decline_change", principal);
    await applyWeightDecision(tx as Db, adjustment, false);
    if (input.returnUnprocessed === true) {
      const captured = await tx.select({ id: paymentIntents.id }).from(paymentIntents).where(and(
        eq(paymentIntents.organizationId, principal.organizationId),
        eq(paymentIntents.orderId, order.id),
        inArray(paymentIntents.state, ["captured", "partially_refunded", "refunded"]),
      )).limit(1);
      if (captured.length) {
        throw new AppError("FINANCIAL_HOLD", "ORDER_ALREADY_CHARGED", { orderId: order.id });
      }
      const openInvoices = await tx.select({ id: customerInvoices.id }).from(customerInvoices).where(and(
        eq(customerInvoices.organizationId, principal.organizationId),
        eq(customerInvoices.orderId, order.id),
        eq(customerInvoices.state, "open"),
      ));
      for (const invoice of openInvoices) {
        await tx.update(customerInvoices).set({ state: "cancelled" }).where(and(
          eq(customerInvoices.id, invoice.id),
          eq(customerInvoices.state, "open"),
        ));
      }
      const hubState = nextStateAsSystem(inspected, "return_unprocessed", {
        systemActor: "decideAdjustment",
        reason: "customer declined adjustment and requested unprocessed return",
      });
      const readyState = nextStateAsSystem(hubState, "ready_for_return", {
        systemActor: "decideAdjustment",
        reason: "customer declined adjustment and requested unprocessed return",
      });
      const reason = "Отказ клиента: возврат без обработки";
      const { voidedAccruals, creditedAccruals } = await voidPartnerAccrualsForOrder(
        tx,
        principal.organizationId,
        order.id,
        reason,
      );
      const liveReservations = await tx.select({ id: slotReservations.id }).from(slotReservations).where(and(
        eq(slotReservations.organizationId, principal.organizationId),
        eq(slotReservations.orderId, order.id),
        inArray(slotReservations.state, ["held", "confirmed"]),
      ));
      let releasedReservations = 0;
      for (const reservation of liveReservations) {
        const released = await releaseSlot(tx as Db, {
          principal,
          reservationId: reservation.id,
          reason,
          key: `return-adj-${input.key}-${reservation.id}`,
        });
        if (released.changed) releasedReservations += 1;
      }
      const [advanced] = await tx.update(orders).set({
        lifecycleState: readyState,
        returnReason: reason,
        version: order.version + 1,
      }).where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
        .returning({ version: orders.version });
      if (!advanced) throw errors.version(order.version);
      await tx.update(garments).set({ status: "returned_unprocessed" }).where(and(
        eq(garments.organizationId, principal.organizationId),
        eq(garments.orderId, order.id),
      ));
      await appendEvent(tx, {
        principal, aggregateType: "order", aggregateId: order.id,
        eventType: "order.decline_change",
        reason,
        payload: { adjustmentId: adjustment.id, deltaKopeks: adjustment.deltaKopeks, returnUnprocessed: true },
      });
      await appendEvent(tx, {
        principal, aggregateType: "order", aggregateId: order.id,
        eventType: "order.return_unprocessed",
        reason,
        payload: {
          adjustmentId: adjustment.id,
          from: inspected,
          to: readyState,
          releasedReservations,
          voidedInvoices: openInvoices.length,
          voidedAccruals,
          creditedAccruals,
        },
      });
      return { orderId: order.id, adjustmentId: adjustment.id, state: readyState, releasedReservations };
    }

    const declineReason = "Отказ клиента от доплаты";
    const [advanced] = await tx.update(orders).set({
      lifecycleState: inspected,
      returnReason: declineReason,
      version: order.version + 1,
    }).where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
      .returning({ version: orders.version });
    if (!advanced) throw errors.version(order.version);
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: "order.decline_change",
      reason: declineReason,
      payload: { adjustmentId: adjustment.id, deltaKopeks: adjustment.deltaKopeks },
    });
    return { orderId: order.id, adjustmentId: adjustment.id, state: inspected };
  });
}

export async function returnUnprocessedOrder(
  db: Db,
  principal: Principal,
  input: { orderId: string; reason: string; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.partner, ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "order:return_unprocessed", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    if (hasRole(principal, ...ROLE_GROUPS.partner) && !hasRole(principal, ...ROLE_GROUPS.dispatcher)) {
      assertAssignedPartner(order, principal);
    }
    if (order.lifecycleState !== "inspection") {
      throw errors.transition(order.lifecycleState, "return_unprocessed");
    }
    // An order that was never processed must never leave the customer payable: an existing capture
    // is refused so finance resolves the money explicitly, and an open invoice is voided.
    const captured = await tx.select({ id: paymentIntents.id }).from(paymentIntents).where(and(
      eq(paymentIntents.organizationId, principal.organizationId),
      eq(paymentIntents.orderId, order.id),
      inArray(paymentIntents.state, ["captured", "partially_refunded", "refunded"]),
    )).limit(1);
    if (captured.length) {
      throw new AppError("FINANCIAL_HOLD", "ORDER_ALREADY_CHARGED", { orderId: order.id });
    }
    const openInvoices = await tx.select({ id: customerInvoices.id }).from(customerInvoices).where(and(
      eq(customerInvoices.organizationId, principal.organizationId),
      eq(customerInvoices.orderId, order.id),
      eq(customerInvoices.state, "open"),
    ));
    for (const invoice of openInvoices) {
      await tx.update(customerInvoices).set({ state: "cancelled" }).where(eq(customerInvoices.id, invoice.id));
    }
    const { voidedAccruals, creditedAccruals } = await voidPartnerAccrualsForOrder(
      tx,
      principal.organizationId,
      order.id,
      input.reason,
    );
    // Nothing will be delivered, so the capacity held for this order is released again.
    const liveReservations = await tx.select({ id: slotReservations.id }).from(slotReservations).where(and(
      eq(slotReservations.organizationId, principal.organizationId),
      eq(slotReservations.orderId, order.id),
      inArray(slotReservations.state, ["held", "confirmed"]),
    ));
    let releasedReservations = 0;
    for (const reservation of liveReservations) {
      const released = await releaseSlot(tx as Db, {
        principal,
        reservationId: reservation.id,
        reason: input.reason,
        key: `return-${input.key}-${reservation.id}`,
      });
      if (released.changed) releasedReservations += 1;
    }
    const hubState = nextStateAsSystem("inspection", "return_unprocessed", {
      systemActor: "returnUnprocessedOrder",
      reason: input.reason,
    });
    const readyState = nextStateAsSystem(hubState, "ready_for_return", {
      systemActor: "returnUnprocessedOrder",
      reason: input.reason,
    });
    await tx.update(orders).set({
      lifecycleState: readyState,
      returnReason: input.reason,
      version: order.version + 1,
    }).where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await tx.update(garments).set({ status: "returned_unprocessed" }).where(and(
      eq(garments.organizationId, principal.organizationId),
      eq(garments.orderId, order.id),
    ));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: "order.return_unprocessed",
      reason: input.reason,
      payload: {
        from: order.lifecycleState, to: readyState, reason: input.reason,
        releasedReservations, voidedInvoices: openInvoices.length,
        voidedAccruals, creditedAccruals,
      },
    });
    return {
      orderId: order.id,
      state: readyState,
      returnReason: input.reason,
      releasedReservations,
    };
  });
}

export async function startProcessing(db: Db, principal: Principal, input: { orderId: string; processType: string; key: string }) {
  assertRole(principal, ...ROLE_GROUPS.partner);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "partner:batch", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    assertAssignedPartner(order, principal);
    if (!["inspection", "processing"].includes(order.lifecycleState)) throw errors.transition(order.lifecycleState, "start_processing");
    const [batch] = await tx.insert(batches).values({
      organizationId: principal.organizationId,
      partnerId: principal.partnerId!,
      processType: input.processType,
      state: "processing",
      createdBy: principal.userId,
    }).returning();
    const items = await tx.select().from(garments).where(and(
      eq(garments.organizationId, principal.organizationId), eq(garments.orderId, order.id),
    ));
    for (const item of items) {
      await tx.insert(batchItems).values({ batchId: batch.id, garmentId: item.id, status: "processing" });
      await tx.insert(processingOperations).values({
        organizationId: principal.organizationId,
        batchId: batch.id,
        operation: input.processType,
        actorId: principal.userId,
      });
    }
    if (!items.length) {
      await tx.insert(processingOperations).values({
        organizationId: principal.organizationId,
        batchId: batch.id,
        operation: `${input.processType}:bag`,
        actorId: principal.userId,
      });
    }
    const to = nextState(order.lifecycleState as "inspection" | "processing", "start_processing", principal);
    if (order.lifecycleState !== to) {
      await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    }
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.start_processing",
      payload: { batchId: batch.id, itemCount: items.length },
    });
    return { batchId: batch.id, state: to, itemCount: items.length };
  });
}

export async function recordQualityCheck(
  db: Db,
  principal: Principal,
  input: { orderId: string; results: Array<{ garmentId: string; passed: boolean; note?: string }>; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.partner);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "partner:qc", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    assertAssignedPartner(order, principal);
    if (order.lifecycleState !== "processing") throw errors.transition(order.lifecycleState, "qc_start");
    const garmentRows = await tx.select({ id: garments.id }).from(garments).where(and(
      eq(garments.organizationId, principal.organizationId), eq(garments.orderId, order.id),
    ));
    // Economy bags have no per-item inventory, so QC is recorded at bag level.
    if (garmentRows.length && !input.results.length) throw new AppError("VALIDATION_ERROR", "QC_RESULTS_REQUIRED");
    const garmentIds = input.results.map(result => result.garmentId);
    const owned = await tx.select({ id: garments.id }).from(garments).where(and(
      eq(garments.organizationId, principal.organizationId),
      eq(garments.orderId, order.id),
      inArray(garments.id, garmentIds),
    ));
    if (owned.length !== new Set(garmentIds).size) throw errors.notFound("garment");
    // QC must cover every accepted garment of the order exactly once.
    if (garmentRows.length) {
      const covered = new Set(garmentIds);
      if (covered.size !== garmentRows.length || !garmentRows.every(row => covered.has(row.id))) {
        throw new AppError("VALIDATION_ERROR", "QC_INCOMPLETE_COVERAGE", {
          required: garmentRows.length, covered: covered.size,
        });
      }
    }
    for (const result of input.results) {
      await tx.insert(qualityChecks).values({
        organizationId: principal.organizationId,
        orderId: order.id,
        garmentId: result.garmentId,
        result: result.passed ? "passed" : "failed",
        note: result.note ?? null,
        actorId: principal.userId,
      });
    }
    const allPassed = input.results.every(result => result.passed);
    const to = nextState("processing", allPassed ? "qc_start" : "qc_start", principal);
    let finalState: OrderState = to;
    await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    if (allPassed) {
      finalState = nextState("quality_check", "pack", principal);
      await tx.update(orders).set({ lifecycleState: finalState, version: order.version + 2 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version + 1)));
    } else {
      // A QC failure is a rewash, never a delivery and never a customer surcharge.
      // The escalation itself is automatic, so it is not blocked by supervisor-only command roles.
      finalState = nextStateAsSystem("quality_check", "rewash", {
        systemActor: "recordQualityCheck",
        reason: "automatic rewash after quality check failure",
      });
      await tx.update(orders).set({ lifecycleState: finalState, version: order.version + 2 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version + 1)));
    }
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: allPassed ? "order.qc_passed" : "order.qc_failed",
      payload: { results: input.results, state: finalState },
    });
    return { orderId: order.id, state: finalState, allPassed };
  });
}

const ACTIVE_PARTNER_STATES: OrderState[] = [
  "picked_up",
  "at_hub",
  "partner_received",
  "inspection",
  "awaiting_approval",
  "processing",
  "quality_check",
  "ready",
];

export async function partnerWorkspace(db: Db, principal: Principal) {
  assertRole(principal, ...ROLE_GROUPS.partner);
  if (!principal.partnerId) return { orders: [] };

  const orderRows = await db.select().from(orders).where(and(
    eq(orders.organizationId, principal.organizationId),
    eq(orders.assignedPartnerId, principal.partnerId),
    inArray(orders.lifecycleState, ACTIVE_PARTNER_STATES),
  )).orderBy(desc(orders.createdAt));

  if (!orderRows.length) return { orders: [] };

  const orderIds = orderRows.map(order => order.id);
  const [manifestRows, containerRows, garmentRows, adjustmentRows] = await Promise.all([
    db.select().from(intakeManifests).where(and(
      eq(intakeManifests.organizationId, principal.organizationId),
      inArray(intakeManifests.orderId, orderIds),
    )).orderBy(desc(intakeManifests.createdAt)),
    db.select({
      orderId: containerAssignments.orderId,
      containerId: containers.id,
      containerCode: containers.code,
      sealSerial: seals.serialNumber,
    }).from(containerAssignments)
      .innerJoin(containers, eq(containerAssignments.containerId, containers.id))
      .leftJoin(seals, eq(containerAssignments.sealId, seals.id))
      .where(and(
        eq(containerAssignments.organizationId, principal.organizationId),
        inArray(containerAssignments.orderId, orderIds),
      )),
    db.select({
      id: garments.id,
      orderId: garments.orderId,
      itemCode: garments.itemCode,
      category: garments.category,
      description: garments.description,
      status: garments.status,
      brandMark: garments.brandMark,
    }).from(garments).where(and(
      eq(garments.organizationId, principal.organizationId),
      inArray(garments.orderId, orderIds),
    )),
    db.select({
      id: orderAdjustments.id,
      orderId: orderAdjustments.orderId,
      reason: orderAdjustments.reason,
      deltaKopeks: orderAdjustments.deltaKopeks,
      state: orderAdjustments.state,
      createdAt: orderAdjustments.createdAt,
    }).from(orderAdjustments).where(and(
      eq(orderAdjustments.organizationId, principal.organizationId),
      inArray(orderAdjustments.orderId, orderIds),
    )).orderBy(desc(orderAdjustments.createdAt)),
  ]);

  const latestManifestByOrder = new Map<string, typeof intakeManifests.$inferSelect>();
  const weightByOrderContainer = new Map<string, number>();
  for (const manifest of manifestRows) {
    if (!latestManifestByOrder.has(manifest.orderId)) {
      latestManifestByOrder.set(manifest.orderId, manifest);
    }
    if (manifest.containerId) {
      const key = `${manifest.orderId}:${manifest.containerId}`;
      if (!weightByOrderContainer.has(key)) {
        weightByOrderContainer.set(key, manifest.weightGrams);
      }
    }
  }

  const containersByOrder = new Map<string, Array<{ containerCode: string; sealSerial: string | null; weightGrams: number }>>();
  for (const row of containerRows) {
    const list = containersByOrder.get(row.orderId) ?? [];
    const weightGrams = weightByOrderContainer.get(`${row.orderId}:${row.containerId}`)
      ?? latestManifestByOrder.get(row.orderId)?.weightGrams
      ?? 0;
    list.push({
      containerCode: row.containerCode,
      sealSerial: row.sealSerial ?? null,
      weightGrams,
    });
    containersByOrder.set(row.orderId, list);
  }

  const garmentsByOrder = new Map<string, typeof garmentRows>();
  for (const row of garmentRows) {
    const list = garmentsByOrder.get(row.orderId) ?? [];
    list.push(row);
    garmentsByOrder.set(row.orderId, list);
  }

  const adjustmentsByOrder = new Map<string, typeof adjustmentRows>();
  for (const row of adjustmentRows) {
    const list = adjustmentsByOrder.get(row.orderId) ?? [];
    list.push(row);
    adjustmentsByOrder.set(row.orderId, list);
  }

  return {
    orders: orderRows.map(order => ({
      id: order.id,
      orderId: order.id,
      publicNumber: order.publicNumber,
      lifecycleState: order.lifecycleState,
      returnReason: order.returnReason,
      createdAt: order.createdAt,
      manifestId: latestManifestByOrder.get(order.id)?.id ?? null,
      containers: containersByOrder.get(order.id) ?? [],
      garments: garmentsByOrder.get(order.id) ?? [],
      adjustments: adjustmentsByOrder.get(order.id) ?? [],
    })),
  };
}
