import { randomBytes, randomInt } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  containerAssignments, containers, customerAddresses, documentVersions, garments,
  intakeManifestLines, intakeManifests, orderAdjustments, orderLines, orders, quotes,
  routeStops, seals, serviceWindows, slotReservations,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotency, withIdempotencyFlat } from "../core/idempotency.js";
import { nextState, type OrderState } from "../domain/order-state.js";
import { confirmSlot, releaseSlot } from "../domain/slot-reservation.js";
import { assertAcceptableQuote } from "./quotes.js";
import type { DeclaredItem } from "../../shared/garment-taxonomy.js";

type QuoteSnapshot = {
  addressId?: string;
  lines: Array<{ kind: string; serviceId?: string; tier?: "economy" | "protected"; quantity: number; unit: string; amountKopeks: number }>;
  declaredItems?: DeclaredItem[];
};

export async function createOrder(
  db: Db,
  principal: Principal,
  input: { quoteId: string; acceptedQuoteHash: string; termsVersion: string; key: string; now?: Date },
) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher);
  const now = input.now ?? new Date();
  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "order:create",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, principalId: principal.userId }),
  }, async tx => {
    const quote = await assertAcceptableQuote(tx as Db, principal, input.quoteId, input.acceptedQuoteHash, now);
    const [document] = await tx.select().from(documentVersions).where(and(
      eq(documentVersions.organizationId, principal.organizationId),
      eq(documentVersions.kind, "offer"),
      eq(documentVersions.version, input.termsVersion),
    )).limit(1);
    if (!document?.publishedAt) throw new AppError("VALIDATION_ERROR", "TERMS_NOT_PUBLISHED");
    const snapshot = quote.snapshotJson as QuoteSnapshot;
    const serviceLines = snapshot.lines.filter(line => line.kind === "service");
    if (!serviceLines.length) throw new AppError("VALIDATION_ERROR", "NO_SERVICE_LINES");

    const publicNumber = `LA-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex").toUpperCase()}`;
    const handoffCode = randomInt(100000, 1000000).toString();
    const [order] = await tx.insert(orders).values({
      organizationId: principal.organizationId,
      customerId: quote.customerId,
      addressId: (() => {
        const addressId = (quote.snapshotJson as QuoteSnapshot).addressId;
        if (!addressId) throw new AppError("VALIDATION_ERROR", "CUSTOMER_ADDRESS_REQUIRED");
        return addressId;
      })(),
      quoteId: quote.id,
      publicNumber,
      lifecycleState: "draft",
      termsVersion: input.termsVersion,
      acceptedQuoteHash: input.acceptedQuoteHash,
      handoffCode,
    }).returning();

    await tx.insert(orderLines).values(serviceLines.map(line => ({
      orderId: order.id,
      serviceId: line.serviceId!,
      tier: line.tier!,
      quotedQuantity: line.quantity,
      unit: line.unit,
      quotedAmountKopeks: line.amountKopeks,
      tariffSnapshotJson: { quoteId: quote.id, tariffVersionId: quote.tariffVersionId, line },
    })));

    await tx.update(orders).set({ lifecycleState: nextState("draft", "confirm", principal), version: sql`${orders.version} + 1` })
      .where(eq(orders.id, order.id));
    await tx.update(quotes).set({ state: "accepted" }).where(eq(quotes.id, quote.id));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.confirmed",
      payload: { quoteId: quote.id, totalKopeks: quote.totalKopeks, termsVersion: input.termsVersion },
    });
    return {
      id: order.id,
      publicNumber: order.publicNumber,
      organizationId: order.organizationId,
      customerId: order.customerId,
      state: "confirmed" as const,
      totalKopeks: quote.totalKopeks,
      quoteId: quote.id,
    };
  });
  return { ...result.value, replayed: result.replayed };
}

export async function scheduleOrder(
  db: Db,
  principal: Principal,
  input: { orderId: string; pickupReservationId?: string; deliveryReservationId?: string; key: string; now?: Date },
) {
  assertRole(principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher);
  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "order:schedule",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
    replayGuard: async tx => { await loadOrder(tx as Db, principal, input.orderId); },
  }, async tx => {
    const order = await loadOrder(tx as Db, principal, input.orderId);
    if (order.lifecycleState !== "confirmed") throw errors.transition(order.lifecycleState, "reserve_pickup");
    if (!input.pickupReservationId || !input.deliveryReservationId) {
      throw new AppError("VALIDATION_ERROR", "BOTH_RESERVATIONS_REQUIRED");
    }
    const [address] = await tx.select({ buildingId: customerAddresses.buildingId }).from(customerAddresses).where(and(
      eq(customerAddresses.id, order.addressId),
      eq(customerAddresses.organizationId, principal.organizationId),
    )).limit(1);
    if (!address) throw errors.notFound("address");

    // Each leg must be the order customer's own held capacity for the order's building and kind.
    await confirmLeg(tx as Db, principal, order, address.buildingId, input.pickupReservationId, "pickup", input.key, input.now);
    await confirmLeg(tx as Db, principal, order, address.buildingId, input.deliveryReservationId, "delivery", input.key, input.now);
    await tx.update(orders).set({
      lifecycleState: "scheduled",
      version: sql`${orders.version} + 1`,
    }).where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.scheduled",
      payload: { pickupReservationId: input.pickupReservationId, deliveryReservationId: input.deliveryReservationId },
    });
    return { id: order.id, state: "scheduled" as const };
  });
  return { ...result.value, replayed: result.replayed };
}

type OrderRow = Awaited<ReturnType<typeof loadOrder>>;

async function confirmLeg(
  tx: Db,
  principal: Principal,
  order: OrderRow,
  buildingId: string,
  reservationId: string,
  kind: "pickup" | "delivery",
  key: string,
  now?: Date,
) {
  const [reservation] = await tx.select().from(slotReservations).where(and(
    eq(slotReservations.id, reservationId),
    eq(slotReservations.organizationId, principal.organizationId),
  )).limit(1);
  if (!reservation) throw errors.notFound("reservation");
  if (reservation.orderId && reservation.orderId !== order.id) throw errors.notFound("reservation");
  if (reservation.quoteId && reservation.quoteId !== order.quoteId) throw errors.notFound("reservation");
  if (reservation.principalId !== order.customerId) throw errors.notFound("reservation");
  if (reservation.state !== "held") {
    throw new AppError("INVALID_TRANSITION", "RESERVATION_NOT_CONFIRMABLE", { state: reservation.state });
  }
  const [window] = await tx.select().from(serviceWindows).where(and(
    eq(serviceWindows.id, reservation.windowId),
    eq(serviceWindows.organizationId, principal.organizationId),
    eq(serviceWindows.buildingId, buildingId),
    eq(serviceWindows.kind, kind),
  )).limit(1);
  if (!window) throw errors.notFound("window");
  await confirmSlot(tx, {
    principal, reservationId, key: `schedule-${key}-${reservationId}`, now,
  });
  await tx.update(slotReservations).set({ orderId: order.id }).where(eq(slotReservations.id, reservationId));
}

async function orderBuildingId(tx: Db, principal: Principal, order: OrderRow) {
  const [address] = await tx.select({ buildingId: customerAddresses.buildingId }).from(customerAddresses).where(and(
    eq(customerAddresses.id, order.addressId),
    eq(customerAddresses.organizationId, principal.organizationId),
  )).limit(1);
  if (!address) throw errors.notFound("address");
  return address.buildingId;
}

/** Releases every live hold of the order so a cancel/reschedule cannot strand capacity. */
async function releaseOrderReservations(tx: Db, principal: Principal, orderId: string, reason: string, key: string) {
  const live = await tx.select({ id: slotReservations.id }).from(slotReservations).where(and(
    eq(slotReservations.organizationId, principal.organizationId),
    eq(slotReservations.orderId, orderId),
    inArray(slotReservations.state, ["held", "confirmed"]),
  ));
  for (const reservation of live) {
    await releaseSlot(tx, {
      principal, reservationId: reservation.id, reason, key: `${key}-${reservation.id}`,
    });
  }
  return live.length;
}

export async function cancelOrder(
  db: Db,
  principal: Principal,
  input: { orderId: string; reason: string; key: string },
) {
  assertRole(principal, "customer", ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.admin);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "order:cancel", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
    replayGuard: async tx => { await loadOrder(tx as Db, principal, input.orderId); },
  }, async tx => {
    const order = await loadOrder(tx, principal, input.orderId);
    if (order.lifecycleState === "cancelled") {
      return { orderId: order.id, state: "cancelled" as const, releasedReservations: 0 };
    }
    // nextState enforces both the lifecycle edge and the role allowed to take it.
    nextState(order.lifecycleState as OrderState, "cancel", principal);
    const released = await releaseOrderReservations(tx, principal, order.id, input.reason, input.key);
    await tx.update(orders).set({
      lifecycleState: "cancelled", version: sql`${orders.version} + 1`,
    }).where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.cancelled",
      payload: { from: order.lifecycleState, releasedReservations: released }, reason: input.reason,
    });
    return { orderId: order.id, state: "cancelled" as const, releasedReservations: released };
  });
}

export async function rescheduleOrder(
  db: Db,
  principal: Principal,
  input: { orderId: string; pickupReservationId: string; deliveryReservationId: string; key: string; now?: Date },
) {
  assertRole(principal, "customer", ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "order:reschedule", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
    replayGuard: async tx => { await loadOrder(tx as Db, principal, input.orderId); },
  }, async tx => {
    const order = await loadOrder(tx, principal, input.orderId);
    if (order.lifecycleState !== "scheduled") {
      throw new AppError("INVALID_TRANSITION", "ORDER_NOT_RESCHEDULABLE", { state: order.lifecycleState });
    }
    const buildingId = await orderBuildingId(tx, principal, order);
    await releaseOrderReservations(tx, principal, order.id, "reschedule", `reschedule-${input.key}`);
    await confirmLeg(tx, principal, order, buildingId, input.pickupReservationId, "pickup", input.key, input.now);
    await confirmLeg(tx, principal, order, buildingId, input.deliveryReservationId, "delivery", input.key, input.now);
    await tx.update(orders).set({ version: sql`${orders.version} + 1` })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.rescheduled",
      payload: { pickupReservationId: input.pickupReservationId, deliveryReservationId: input.deliveryReservationId },
    });
    return { orderId: order.id, state: "scheduled" as const };
  });
}

export async function loadOrder(db: Db, principal: Principal, orderId: string) {
  const [order] = await db.select().from(orders).where(and(
    eq(orders.id, orderId),
    eq(orders.organizationId, principal.organizationId),
  )).limit(1);
  if (!order) throw errors.notFound("order");
  if (hasRole(principal, "customer") && order.customerId !== principal.userId) throw errors.notFound("order");
  return order;
}

/**
 * Read projection for `GET /orders/:id`. Staff see the business fields without the accepted
 * terms hash; a partner sees only orders assigned to it; a courier only stops assigned to them.
 * Customer addresses, lead contact data and evidence are never part of this projection.
 */
export async function loadOrderView(db: Db, principal: Principal, orderId: string) {
  const order = await loadOrder(db, principal, orderId);
  const staff = hasRole(
    principal,
    ...ROLE_GROUPS.admin, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.support,
  );
  const isOwnerCustomer = hasRole(principal, "customer") && order.customerId === principal.userId;

  if (!staff && !isOwnerCustomer) {
    if (hasRole(principal, ...ROLE_GROUPS.partner)) {
      if (!principal.partnerId || order.assignedPartnerId !== principal.partnerId) throw errors.notFound("order");
    } else if (hasRole(principal, "courier")) {
      const [stop] = await db.select({ id: routeStops.id }).from(routeStops).where(and(
        eq(routeStops.organizationId, principal.organizationId),
        eq(routeStops.orderId, order.id),
        eq(routeStops.assignedCourierId, principal.userId),
      )).limit(1);
      if (!stop) throw errors.notFound("order");
    } else {
      throw errors.forbidden("no order view for this role");
    }
  }

  const [quoteRows, adjustmentRows, garmentRows, assignmentRows, manifestLines] = await Promise.all([
    db.select({ totalKopeks: quotes.totalKopeks, snapshotJson: quotes.snapshotJson }).from(quotes).where(and(
      eq(quotes.id, order.quoteId),
      eq(quotes.organizationId, principal.organizationId),
    )).limit(1),
    db.select({
      id: orderAdjustments.id,
      proposedBy: orderAdjustments.proposedBy,
      reason: orderAdjustments.reason,
      deltaKopeks: orderAdjustments.deltaKopeks,
      state: orderAdjustments.state,
      version: orderAdjustments.version,
      detailsJson: orderAdjustments.detailsJson,
      createdAt: orderAdjustments.createdAt,
    }).from(orderAdjustments).where(and(
      eq(orderAdjustments.organizationId, principal.organizationId),
      eq(orderAdjustments.orderId, order.id),
    )).orderBy(asc(orderAdjustments.createdAt)),
    db.select({
      id: garments.id,
      itemCode: garments.itemCode,
      category: garments.category,
      description: garments.description,
      brandMark: garments.brandMark,
      declaredValueKopeks: garments.declaredValueKopeks,
      conditionJson: garments.conditionJson,
      status: garments.status,
      version: garments.version,
      createdAt: garments.createdAt,
    }).from(garments).where(and(
      eq(garments.organizationId, principal.organizationId),
      eq(garments.orderId, order.id),
    )).orderBy(asc(garments.createdAt)),
    db.select({
      id: containers.id,
      code: containers.code,
      kind: containers.kind,
      sealSerial: seals.serialNumber,
    }).from(containerAssignments)
      .innerJoin(containers, eq(containers.id, containerAssignments.containerId))
      .leftJoin(seals, eq(seals.id, containerAssignments.sealId))
      .where(and(
        eq(containerAssignments.organizationId, principal.organizationId),
        eq(containerAssignments.orderId, order.id),
        isNull(containerAssignments.unassignedAt),
      ))
      .orderBy(asc(containerAssignments.assignedAt)),
    db.select({
      containerId: intakeManifests.containerId,
      manifestWeightGrams: intakeManifests.weightGrams,
      description: intakeManifestLines.description,
      weightGrams: intakeManifestLines.weightGrams,
    }).from(intakeManifestLines)
      .innerJoin(intakeManifests, eq(intakeManifests.id, intakeManifestLines.manifestId))
      .where(and(
        eq(intakeManifests.organizationId, principal.organizationId),
        eq(intakeManifests.orderId, order.id),
      )),
  ]);

  const acceptedDelta = adjustmentRows
    .filter(adj => adj.state === "accepted")
    .reduce((sum, adj) => sum + Number(adj.deltaKopeks), 0);
  const totalKopeks = Number(quoteRows[0]?.totalKopeks ?? 0) + acceptedDelta;

  // What the customer declared at handover, straight out of the immutable quote
  // snapshot. The courier reconciles the accepted garments against this list.
  const quoteSnapshot = (quoteRows[0]?.snapshotJson ?? null) as QuoteSnapshot | null;
  const declaredItems: DeclaredItem[] = quoteSnapshot?.declaredItems ?? [];

  const weightByCode = new Map<string, number>();
  const weightByContainerId = new Map<string, number>();
  for (const line of manifestLines) {
    if (line.description.startsWith("bag:")) {
      const code = line.description.slice(4);
      weightByCode.set(code, (weightByCode.get(code) ?? 0) + line.weightGrams);
    }
    if (line.containerId && line.manifestWeightGrams > 0) {
      weightByContainerId.set(line.containerId, line.manifestWeightGrams);
    }
  }
  const containersView = assignmentRows.map(row => ({
    id: row.id,
    code: row.code,
    kind: row.kind,
    sealSerial: row.sealSerial ?? null,
    weightGrams: weightByCode.get(row.code) ?? weightByContainerId.get(row.id) ?? 0,
  }));

  const canSeeHandoff = isOwnerCustomer
    || hasRole(principal, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.support, ...ROLE_GROUPS.admin);

  // A weight proposal carries its own arithmetic, so the customer can see why the
  // difference is what it is instead of taking the number on faith.
  const adjustments = adjustmentRows.map(adj => {
    const details = (adj.detailsJson ?? {}) as {
      kind?: string;
      quotedGrams?: number;
      receivedGrams?: number;
      deltaGrams?: number;
    };
    return {
      id: adj.id,
      proposedBy: adj.proposedBy,
      reason: adj.reason,
      deltaKopeks: adj.deltaKopeks,
      state: adj.state,
      version: adj.version,
      createdAt: adj.createdAt,
      ...(details.kind === "weight_variance"
        ? {
          weight: {
            quotedGrams: details.quotedGrams ?? 0,
            receivedGrams: details.receivedGrams ?? 0,
            deltaGrams: details.deltaGrams ?? 0,
          },
        }
        : {}),
    };
  });

  return {
    id: order.id,
    publicNumber: order.publicNumber,
    lifecycleState: order.lifecycleState,
    version: order.version,
    customerId: order.customerId,
    assignedPartnerId: order.assignedPartnerId,
    termsVersion: order.termsVersion,
    returnReason: order.returnReason ?? null,
    totalKopeks,
    garments: garmentRows,
    declaredItems,
    containers: containersView,
    adjustments,
    createdAt: order.createdAt,
    ...(isOwnerCustomer ? { acceptedQuoteHash: order.acceptedQuoteHash } : {}),
    ...(canSeeHandoff
      ? {
        handoffCode: order.handoffCode ?? null,
        qrPayload: order.handoffCode ? `LND1:ORD:${order.id}:${order.handoffCode}` : null,
      }
      : {}),
  };
}

/**
 * "The same order again."
 *
 * A customer who ordered a wash of five kilograms last week usually wants the same
 * thing next week. This service hands the customer back the service lines of a past
 * order so that a new quote can be requested in one tap. It creates nothing: the price
 * is recalculated, the slots are booked anew and the customer confirms again — a repeat
 * order is a new order, never a silent copy.
 */
export async function repeatOrder(db: Db, principal: Principal, orderId: string) {
  const order = await loadOrder(db, principal, orderId);
  if (!hasRole(principal, "customer", ...ROLE_GROUPS.dispatcher)) throw errors.forbidden("repeat is a customer action");
  if (order.customerId !== principal.userId && !hasRole(principal, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.admin)) {
    throw errors.notFound("order");
  }

  const [quote] = await db.select({ snapshotJson: quotes.snapshotJson }).from(quotes).where(and(
    eq(quotes.id, order.quoteId),
    eq(quotes.organizationId, principal.organizationId),
  )).limit(1);
  if (!quote) throw errors.notFound("quote");

  const snapshot = (quote.snapshotJson ?? {}) as QuoteSnapshot;
  const lines = (snapshot.lines ?? [])
    .filter(line => line.kind === "service")
    .map(line => ({
      serviceId: line.serviceId ?? "",
      tier: line.tier ?? "economy",
      quantity: line.quantity,
      unit: line.unit,
    }));

  const [address] = await db.select({ buildingId: customerAddresses.buildingId }).from(customerAddresses).where(and(
    eq(customerAddresses.id, order.addressId),
    eq(customerAddresses.organizationId, principal.organizationId),
  )).limit(1);

  return {
    sourceOrderId: order.id,
    publicNumber: order.publicNumber,
    buildingId: address?.buildingId ?? null,
    lines,
    declaredItems: snapshot.declaredItems ?? [],
    note: "Повтор заказа — это новая котировка с новой ценой и новыми слотами. Старый заказ не меняется.",
  };
}

export async function transitionOrder(
  db: Db,
  principal: Principal,
  input: { orderId: string; command: string; reason?: string; key: string },
) {
  const result = await withIdempotency(db, {
    organizationId: principal.organizationId,
    scope: "order:transition",
    key: input.key,
    actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const order = await loadOrder(tx as Db, principal, input.orderId);
    const to = nextState(order.lifecycleState as OrderState, input.command, principal);
    const updated = await tx.update(orders).set({
      lifecycleState: to,
      version: sql`${orders.version} + 1`,
    }).where(and(eq(orders.id, order.id), eq(orders.version, order.version))).returning({ version: orders.version });
    if (!updated.length) throw errors.version(order.version);
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: `order.${input.command}`, reason: input.reason,
      payload: { from: order.lifecycleState, to, version: updated[0].version },
    });
    return { id: order.id, from: order.lifecycleState, to, version: updated[0].version };
  });
  return { ...result.value, replayed: result.replayed };
}

const SENSITIVE_TIMELINE_KEY = /(kopek|amount|price|tariff|quote|terms|invoice|payment|refund|payout|billing|fee|handoff|qr_?payload)/i;

function sanitizeTimelinePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTimelinePayload);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_TIMELINE_KEY.test(k)) continue;
      out[k] = sanitizeTimelinePayload(v);
    }
    return out;
  }
  return value;
}

export async function getOrderTimeline(db: Db, principal: Principal, orderId: string) {
  await loadOrderView(db, principal, orderId);
  const rows = await db.execute(sql`
    SELECT event_type, payload_json, created_at FROM outbox_events
    WHERE organization_id = ${principal.organizationId} AND aggregate_type = 'order'
      AND aggregate_id = ${orderId}
    ORDER BY created_at ASC
  `);
  const canSeeInternalBilling = hasRole(
    principal,
    "customer",
    ...ROLE_GROUPS.admin,
    ...ROLE_GROUPS.dispatcher,
    ...ROLE_GROUPS.finance,
    ...ROLE_GROUPS.support,
  );
  if (canSeeInternalBilling) return rows.rows;
  return (rows.rows as Array<Record<string, unknown>>).map(row => ({
    ...row,
    payload_json: sanitizeTimelinePayload(row.payload_json),
  }));
}
