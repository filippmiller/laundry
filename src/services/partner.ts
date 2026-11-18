import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  batches, batchItems, containerAssignments, containers, custodyDiscrepancies, custodyEvents,
  customerApprovals, customerInvoiceLines, customerInvoices, garments, intakeManifests,
  orderAdjustments, orderLines, orders, partnerContracts, partners, partnerReceiptLines,
  partnerReceipts, partnerServiceAccruals, paymentIntents, processingOperations, qualityChecks, seals,
  serviceWindows, slotReservations,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotency, withIdempotencyFlat } from "../core/idempotency.js";
import { nextState, type OrderState } from "../domain/order-state.js";

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
  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "partner:receipt",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
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

    for (const bag of input.actual) {
      const expectedBag = expected.find(row => row.containerCode === bag.containerCode);
      const [container] = await tx.select().from(containers).where(eq(containers.code, bag.containerCode)).limit(1);
      const [seal] = await tx.select().from(seals).where(eq(seals.serialNumber, bag.sealSerial)).limit(1);
      if (!seal || seal.state !== "assigned") {
        throw new AppError("CUSTODY_CONFLICT", "SEAL_NOT_INTACT", { serial: bag.sealSerial, state: seal?.state ?? "unknown" });
      }
      await tx.insert(partnerReceiptLines).values({
        receiptId: receipt.id,
        containerId: container.id,
        expectedSealId: seal?.id ?? null,
        actualSealId: seal?.id ?? null,
        expectedWeightGrams: manifest.weightGrams,
        actualWeightGrams: bag.actualWeightGrams,
        status: "matched",
      });
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
    await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));

    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, input.orderId));
    const [contract] = await tx.select().from(partnerContracts).where(eq(partnerContracts.partnerId, principal.partnerId!)).limit(1);
    if (contract) {
      // The wholesale rate comes from the signed contract, not from a constant in the code.
      // `wholesalePerKgKopeks` is the price of one kilogram in kopeks; a gram-priced line is
      // billed per kilogram, a piece-priced line per piece. A line whose unit the contract does
      // not price yet accrues nothing rather than a nonsensical amount.
      const terms = (contract.termsJson ?? {}) as {
        wholesalePerKgKopeks?: number;
        wholesalePerPieceKopeks?: number;
      };
      const wholesalePerKgKopeks = terms.wholesalePerKgKopeks ?? DEFAULT_WHOLESALE_PER_KG_KOPEKS;
      const wholesalePerPieceKopeks = terms.wholesalePerPieceKopeks ?? DEFAULT_WHOLESALE_PER_PIECE_KOPEKS;
      for (const line of lines) {
        const amountKopeks = line.unit === "gram"
          ? Math.ceil(line.quotedQuantity * wholesalePerKgKopeks / 1000)
          : line.quotedQuantity * wholesalePerPieceKopeks;
        await tx.insert(partnerServiceAccruals).values({
          organizationId: principal.organizationId,
          partnerId: principal.partnerId!,
          orderLineId: line.id,
          contractId: contract.id,
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
    return { status: "accepted" as const, incidentId: null, receiptId: receipt.id };
  });
  return { ...result.value, replayed: result.replayed };
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
    return { orderId: order.id, state: to };
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

    await tx.update(orderAdjustments).set({ state: input.accept ? "accepted" : "declined" })
      .where(eq(orderAdjustments.id, adjustment.id));
    const [approval] = await tx.insert(customerApprovals).values({
      organizationId: principal.organizationId,
      orderId: order.id,
      adjustmentId: adjustment.id,
      quoteHash: order.acceptedQuoteHash,
      actorId: principal.userId,
      method: input.accept ? "web_accept" : "web_decline",
    }).returning();

    if (input.accept) {
      const to = nextState(order.lifecycleState as "awaiting_approval", "approve_change", principal);
      await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
      const [openInvoice] = await tx.select().from(customerInvoices).where(and(
        eq(customerInvoices.organizationId, principal.organizationId),
        eq(customerInvoices.orderId, order.id),
        eq(customerInvoices.state, "open"),
      )).limit(1);
      if (openInvoice) {
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
        await tx.update(customerInvoices).set({
          totalKopeks: openInvoice.totalKopeks + adjustment.deltaKopeks,
        }).where(eq(customerInvoices.id, openInvoice.id));
      }
      await appendEvent(tx, {
        principal, aggregateType: "order", aggregateId: order.id,
        eventType: "order.approve_change",
        payload: { adjustmentId: adjustment.id, deltaKopeks: adjustment.deltaKopeks, approvalId: approval.id },
      });
      return { orderId: order.id, adjustmentId: adjustment.id, state: to };
    }

    const inspected = nextState(order.lifecycleState as "awaiting_approval", "decline_change", principal);
    if (input.returnUnprocessed === true) {
      const hubState = nextState(inspected, "return_unprocessed");
      const readyState = nextState(hubState, "ready_for_return");
      const reason = "Отказ клиента: возврат без обработки";
      await tx.update(orders).set({
        lifecycleState: readyState,
        returnReason: reason,
        version: order.version + 1,
      }).where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
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
        payload: { adjustmentId: adjustment.id, from: inspected, to: readyState },
      });
      return { orderId: order.id, adjustmentId: adjustment.id, state: readyState };
    }

    const declineReason = "Отказ клиента от доплаты";
    await tx.update(orders).set({
      lifecycleState: inspected,
      returnReason: declineReason,
      version: order.version + 1,
    }).where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
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
    // Nothing will be delivered, so the capacity held for this order is released again.
    const liveReservations = await tx.select({
      id: slotReservations.id,
      windowId: slotReservations.windowId,
      capacityUnits: slotReservations.capacityUnits,
    }).from(slotReservations).where(and(
      eq(slotReservations.organizationId, principal.organizationId),
      eq(slotReservations.orderId, order.id),
      inArray(slotReservations.state, ["held", "confirmed"]),
    ));
    for (const reservation of liveReservations) {
      await tx.update(slotReservations).set({ state: "released" })
        .where(eq(slotReservations.id, reservation.id));
      await tx.update(serviceWindows).set({
        reservedOrders: sql`GREATEST(${serviceWindows.reservedOrders} - ${reservation.capacityUnits}, 0)`,
        version: sql`${serviceWindows.version} + 1`,
      }).where(and(
        eq(serviceWindows.id, reservation.windowId),
        gte(serviceWindows.reservedOrders, reservation.capacityUnits),
      ));
    }
    const hubState = nextState("inspection", "return_unprocessed");
    const readyState = nextState(hubState, "ready_for_return");
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
        releasedReservations: liveReservations.length, voidedInvoices: openInvoices.length,
      },
    });
    return {
      orderId: order.id,
      state: readyState,
      returnReason: input.reason,
      releasedReservations: liveReservations.length,
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
      finalState = nextState("quality_check", "rewash");
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
      declaredValueKopeks: garments.declaredValueKopeks,
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
