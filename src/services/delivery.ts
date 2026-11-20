import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  buildings, claims, courierShifts, custodyDiscrepancies, custodyEvents, customerAddresses,
  deliveryAttempts, garments, notifications, orders, partners, routes, routeStops, users, vehicles,
} from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";
import { nextState, type OrderState } from "../domain/order-state.js";

export async function assignPickup(
  db: Db,
  principal: Principal,
  input: { orderId: string; shiftId: string; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "pickup:assign", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    const [shift] = await tx.select().from(courierShifts).where(and(
      eq(courierShifts.id, input.shiftId), eq(courierShifts.organizationId, principal.organizationId),
    )).limit(1);
    if (!shift || shift.state !== "active") throw errors.notFound("shift");
    const isReassign = order.lifecycleState === "pickup_assigned";
    const to: OrderState = isReassign
      ? "pickup_assigned"
      : nextState(order.lifecycleState as "scheduled", "assign_pickup", principal);
    // Supersede any active pickup stop so a reassigned courier immediately loses access.
    await tx.update(routeStops).set({ state: "rescheduled", version: sql`${routeStops.version} + 1` }).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, order.id),
      eq(routeStops.kind, "pickup"),
      inArray(routeStops.state, ["pending", "en_route", "arrived"]),
    ));
    const [route] = await tx.insert(routes).values({
      organizationId: principal.organizationId,
      shiftId: shift.id,
      kind: "pickup",
      plannedStart: shift.startsAt,
      plannedEnd: shift.endsAt,
    }).returning();
    const [stop] = await tx.insert(routeStops).values({
      organizationId: principal.organizationId,
      routeId: route.id,
      orderId: order.id,
      kind: "pickup",
      sequence: 1,
      assignedCourierId: shift.courierId,
    }).returning();
    const [advanced] = await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
      .returning({ version: orders.version });
    // The optimistic lock only protects anything when its result is checked. Ignored, a lost
    // update leaves the order in its old state while the route and the stop are committed.
    if (!advanced) throw errors.version(order.version);
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: "order.assign_pickup", payload: { stopId: stop.id, courierId: shift.courierId },
    });
    return { orderId: order.id, stopId: stop.id, courierId: shift.courierId, state: to };
  });
}

type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function assertStopShiftActive(tx: DbTx, principal: Principal, routeId: string) {
  if (hasRole(principal, ...ROLE_GROUPS.dispatcher)) return;
  const [shiftRow] = await tx.select({ state: courierShifts.state })
    .from(routes)
    .innerJoin(courierShifts, eq(courierShifts.id, routes.shiftId))
    .where(and(
      eq(routes.id, routeId),
      eq(routes.organizationId, principal.organizationId),
      eq(courierShifts.organizationId, principal.organizationId),
    ))
    .limit(1);
  if (!shiftRow || shiftRow.state !== "active") {
    throw new AppError("FORBIDDEN", "SHIFT_NOT_ACTIVE");
  }
}

export async function currentCourierStops(db: Db, principal: Principal) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  return db.select({
    stopId: routeStops.id,
    orderId: routeStops.orderId,
    publicNumber: orders.publicNumber,
    orderState: orders.lifecycleState,
    kind: routeStops.kind,
    state: routeStops.state,
    sequence: routeStops.sequence,
    windowStart: routeStops.windowStart,
    windowEnd: routeStops.windowEnd,
    address: buildings.address,
    apartment: customerAddresses.apartment,
    notes: customerAddresses.notes,
  }).from(routeStops)
    .innerJoin(routes, eq(routes.id, routeStops.routeId))
    .innerJoin(courierShifts, eq(courierShifts.id, routes.shiftId))
    .innerJoin(orders, eq(orders.id, routeStops.orderId))
    .leftJoin(customerAddresses, eq(customerAddresses.id, orders.addressId))
    .leftJoin(buildings, eq(buildings.id, customerAddresses.buildingId))
    .where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.assignedCourierId, principal.userId),
      eq(courierShifts.organizationId, principal.organizationId),
      eq(courierShifts.state, "active"),
      inArray(routeStops.state, ["pending", "en_route", "arrived"]),
    ))
    .orderBy(routeStops.sequence)
    .limit(50);
}

export async function startStop(db: Db, principal: Principal, input: { stopId: string; key: string }) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "delivery:start", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [stop] = await tx.select().from(routeStops).where(and(
      eq(routeStops.id, input.stopId), eq(routeStops.organizationId, principal.organizationId),
    )).limit(1);
    if (!stop) throw errors.notFound("stop");
    if (stop.assignedCourierId !== principal.userId && !hasRole(principal, ...ROLE_GROUPS.dispatcher)) {
      throw errors.forbidden("courier is not assigned to this stop");
    }
    await assertStopShiftActive(tx, principal, stop.routeId);
    if (stop.state !== "pending") throw errors.transition(stop.state, "start");
    const [updated] = await tx.update(routeStops).set({ state: "en_route", version: stop.version + 1 })
      .where(and(eq(routeStops.id, stop.id), eq(routeStops.version, stop.version)))
      .returning({ id: routeStops.id });
    if (!updated) throw errors.version(stop.version);
    await appendEvent(tx, {
      principal, aggregateType: "route_stop", aggregateId: stop.id,
      eventType: "delivery.en_route", payload: { orderId: stop.orderId },
    });
    return { stopId: stop.id, state: "en_route" as const };
  });
}

export async function assignDelivery(
  db: Db,
  principal: Principal,
  input: { orderId: string; shiftId: string; windowStart?: Date; windowEnd?: Date; key: string },
) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "delivery:assign", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    const isReassign = order.lifecycleState === "out_for_delivery";
    if (!isReassign && order.lifecycleState !== "ready") {
      throw errors.transition(order.lifecycleState, "dispatch");
    }
    const [shift] = await tx.select().from(courierShifts).where(and(
      eq(courierShifts.id, input.shiftId), eq(courierShifts.organizationId, principal.organizationId),
    )).limit(1);
    if (!shift || shift.state !== "active") throw errors.notFound("shift");

    // Supersede any active delivery stop so a reassigned courier immediately loses access.
    await tx.update(routeStops).set({ state: "rescheduled", version: sql`${routeStops.version} + 1` }).where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, order.id),
      eq(routeStops.kind, "delivery"),
      inArray(routeStops.state, ["pending", "en_route", "arrived"]),
    ));
    const [route] = await tx.insert(routes).values({
      organizationId: principal.organizationId,
      shiftId: shift.id,
      kind: "delivery",
      plannedStart: input.windowStart ?? shift.startsAt,
      plannedEnd: input.windowEnd ?? shift.endsAt,
    }).returning();
    const [stop] = await tx.insert(routeStops).values({
      organizationId: principal.organizationId,
      routeId: route.id,
      orderId: order.id,
      kind: "delivery",
      sequence: 1,
      state: "pending",
      assignedCourierId: shift.courierId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    }).returning();
    const to: OrderState = isReassign
      ? "out_for_delivery"
      : nextState("ready", "dispatch", principal);
    const [advanced] = await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
      .returning({ version: orders.version });
    if (!advanced) throw errors.version(order.version);
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: "order.dispatch", payload: { stopId: stop.id, routeId: route.id },
    });
    return { orderId: order.id, stopId: stop.id, state: to };
  });
}

export async function arriveStop(db: Db, principal: Principal, input: { stopId: string; key: string }) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "delivery:arrive", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [stop] = await tx.select().from(routeStops).where(and(
      eq(routeStops.id, input.stopId), eq(routeStops.organizationId, principal.organizationId),
    )).limit(1);
    if (!stop) throw errors.notFound("stop");
    if (stop.assignedCourierId !== principal.userId && !hasRole(principal, ...ROLE_GROUPS.dispatcher)) {
      throw errors.forbidden("courier is not assigned to this stop");
    }
    await assertStopShiftActive(tx, principal, stop.routeId);
    if (stop.state !== "pending" && stop.state !== "en_route") throw errors.transition(stop.state, "arrive");
    const [updated] = await tx.update(routeStops).set({ state: "arrived", version: stop.version + 1 })
      .where(and(eq(routeStops.id, stop.id), eq(routeStops.version, stop.version)))
      .returning({ id: routeStops.id });
    if (!updated) throw errors.version(stop.version);
    await appendEvent(tx, {
      principal, aggregateType: "route_stop", aggregateId: stop.id, eventType: "delivery.arrived",
      payload: { orderId: stop.orderId },
    });
    return { stopId: stop.id, state: "arrived" as const };
  });
}

export type DeliveryAttemptInput = {
  stopId: string;
  outcome: "delivered" | "partial" | "recipient_unavailable" | "wrong_recipient" | "refused" | "damaged";
  deliveredGarmentIds?: string[];
  recipientProof?: Record<string, unknown>;
  reason?: string;
  key: string;
};

export async function recordDeliveryAttempt(db: Db, principal: Principal, input: DeliveryAttemptInput) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "delivery:attempt", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [stop] = await tx.select().from(routeStops).where(and(
      eq(routeStops.id, input.stopId), eq(routeStops.organizationId, principal.organizationId),
    )).limit(1);
    if (!stop) throw errors.notFound("stop");
    if (stop.assignedCourierId !== principal.userId && !hasRole(principal, ...ROLE_GROUPS.dispatcher)) {
      throw errors.forbidden("courier is not assigned to this stop");
    }
    await assertStopShiftActive(tx, principal, stop.routeId);
    if (stop.state !== "arrived") throw errors.transition(stop.state, "attempt");
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, stop.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");

    const allGarments = await tx.select().from(garments).where(and(
      eq(garments.organizationId, principal.organizationId), eq(garments.orderId, order.id),
    ));
    // Garments handed over in an earlier attempt are not outstanding any more. A recovery stop
    // must deliver what is still pending; comparing against the whole historical set would make
    // the exact-set check below impossible to satisfy, and a partially delivered order could
    // then never be closed.
    const pendingGarments = allGarments.filter(garment => garment.status !== "delivered");
    const pendingIds = new Set(pendingGarments.map(garment => garment.id));
    const deliveredIds = input.deliveredGarmentIds ?? [];
    const uniqueDelivered = new Set(deliveredIds);
    const outstandingDelivered = deliveredIds.filter(id => pendingIds.has(id));
    if (uniqueDelivered.size !== deliveredIds.length) {
      throw new AppError("CUSTODY_CONFLICT", "DUPLICATE_GARMENT_ID", { deliveredIds });
    }
    if (deliveredIds.length) {
      const owned = await tx.select({ id: garments.id }).from(garments).where(and(
        eq(garments.organizationId, principal.organizationId),
        eq(garments.orderId, order.id),
        inArray(garments.id, deliveredIds),
      ));
      if (owned.length !== uniqueDelivered.size) throw errors.notFound("garment");
    }
    // Handover requires the exact complete item set; duplicates or omissions must use `partial`.
    if (input.outcome === "delivered" && pendingGarments.length > 0) {
      const missing = pendingGarments.filter(garment => garment.status === "missing_reported");
      if (missing.length > 0) {
        throw new AppError("CUSTODY_CONFLICT", "MISSING_GARMENTS_CANNOT_BE_DELIVERED", {
          missingGarmentIds: missing.map(garment => garment.id),
        });
      }
      const unprocessed = pendingGarments.filter(garment => garment.status === "returned_unprocessed");
      if (unprocessed.length > 0 && !order.returnReason) {
        throw new AppError("CUSTODY_CONFLICT", "RETURN_REASON_REQUIRED", {
          garmentIds: unprocessed.map(garment => garment.id),
        });
      }
      const exactSet = pendingGarments.every(garment => uniqueDelivered.has(garment.id));
      if (!exactSet) {
        throw new AppError("CUSTODY_CONFLICT", "DELIVERY_SET_MISMATCH", {
          required: pendingGarments.length, delivered: outstandingDelivered.length,
        });
      }
    }
    if (input.outcome === "delivered" && allGarments.length === 0 && deliveredIds.length > 0) {
      // Economy bag orders have no per-item inventory: bag-level proof, never invented garment ids.
      throw new AppError("CUSTODY_CONFLICT", "BAG_ORDER_HAS_NO_ITEMS");
    }
    const needsProof = input.outcome === "delivered" || input.outcome === "partial";
    if (needsProof && Object.keys(input.recipientProof ?? {}).length === 0) {
      throw new AppError("EVIDENCE_REQUIRED", "RECIPIENT_PROOF_REQUIRED");
    }
    const rawPin = input.recipientProof?.pin;
    const pinProvided = rawPin !== undefined && rawPin !== null
      && (typeof rawPin !== "string" || rawPin.length > 0 || Object.keys(input.recipientProof ?? {}).length === 1);
    if (pinProvided && order.handoffCode) {
      if (String(rawPin).trim() !== order.handoffCode) {
        throw new AppError("FORBIDDEN", "HANDOFF_PIN_MISMATCH");
      }
    }
    const [attempt] = await tx.insert(deliveryAttempts).values({
      organizationId: principal.organizationId,
      stopId: stop.id,
      orderId: order.id,
      outcome: input.outcome,
      deliveredGarmentIds: deliveredIds,
      recipientProofJson: input.recipientProof ?? {},
      reason: input.reason ?? null,
      actorId: principal.userId,
    }).returning();

    let state: OrderState = order.lifecycleState;
    let recoveryStopId: string | null = null;
    if (input.outcome === "delivered" && (allGarments.length === 0 || outstandingDelivered.length === pendingGarments.length)) {
      state = nextState(order.lifecycleState as "out_for_delivery", "handover", principal);
      const [handedOver] = await tx.update(orders).set({ lifecycleState: state, version: order.version + 1 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
        .returning({ version: orders.version });
      if (!handedOver) throw errors.version(order.version);
      await tx.insert(custodyEvents).values({
        organizationId: principal.organizationId,
        orderId: order.id,
        fromParty: "delivery_courier",
        toParty: "customer",
        actorId: principal.userId,
        manifestHash: hashRequest({ attemptId: attempt.id, deliveredIds }),
      });
      for (const id of deliveredIds) {
        await tx.update(garments).set({ status: "delivered" }).where(eq(garments.id, id));
      }
      await tx.insert(notifications).values({
        organizationId: principal.organizationId,
        recipientId: order.customerId,
        orderId: order.id,
        channel: "push",
        template: "delivery_confirmed",
        payloadJson: { attemptId: attempt.id },
        dedupeKey: `delivery:${order.id}:${attempt.id}`,
      }).onConflictDoNothing();
      const [completedStop] = await tx.update(routeStops).set({ state: "completed", version: stop.version + 1 })
        .where(and(
          eq(routeStops.id, stop.id),
          eq(routeStops.version, stop.version),
          inArray(routeStops.state, ["pending", "en_route", "arrived"]),
        ))
        .returning({ id: routeStops.id });
      if (!completedStop) throw errors.version(stop.version);
    } else if (input.outcome === "partial") {
      for (const id of deliveredIds) {
        await tx.update(garments).set({ status: "delivered" }).where(eq(garments.id, id));
      }
      const [completedStop] = await tx.update(routeStops).set({ state: "completed", version: stop.version + 1 })
        .where(and(
          eq(routeStops.id, stop.id),
          eq(routeStops.version, stop.version),
          inArray(routeStops.state, ["pending", "en_route", "arrived"]),
        ))
        .returning({ id: routeStops.id });
      if (!completedStop) throw errors.version(stop.version);
      // A partial delivery leaves the order open and creates an actionable reattempt stop.
      const [recovery] = await tx.insert(routeStops).values({
        organizationId: principal.organizationId,
        routeId: stop.routeId,
        orderId: order.id,
        buildingId: stop.buildingId,
        kind: "delivery",
        sequence: stop.sequence + 1,
        state: "pending",
        assignedCourierId: stop.assignedCourierId,
        windowStart: stop.windowStart,
        windowEnd: stop.windowEnd,
      }).returning({ id: routeStops.id });
      recoveryStopId = recovery.id;
      // The order deliberately stays out_for_delivery: partial delivery cannot close it.
    } else {
      state = nextState(order.lifecycleState as "out_for_delivery", "failed_attempt", principal);
      const [failed] = await tx.update(orders).set({ lifecycleState: state, version: order.version + 1 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
        .returning({ version: orders.version });
      if (!failed) throw errors.version(order.version);
      const [failedStop] = await tx.update(routeStops).set({ state: "failed", version: stop.version + 1 })
        .where(and(
          eq(routeStops.id, stop.id),
          eq(routeStops.version, stop.version),
          inArray(routeStops.state, ["pending", "en_route", "arrived"]),
        ))
        .returning({ id: routeStops.id });
      if (!failedStop) throw errors.version(stop.version);
    }

    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: input.outcome === "partial" ? "delivery.partial" : `delivery.${input.outcome}`,
      payload: { attemptId: attempt.id, outcome: input.outcome, deliveredGarmentIds: deliveredIds, state },
      reason: input.reason,
    });
    return { attemptId: attempt.id, orderId: order.id, outcome: input.outcome, state, recoveryStopId };
  });
}

export async function closeOrder(db: Db, principal: Principal, input: { orderId: string; key: string }) {
  assertRole(principal, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.worker);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "order:close", key: input.key, actorId: principal.userId,
    requestHash: hashRequest(input),
  }, async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");
    const orderGarments = await tx.select({ id: garments.id, status: garments.status }).from(garments).where(and(
      eq(garments.organizationId, principal.organizationId),
      eq(garments.orderId, order.id),
    ));
    const unaccounted = orderGarments.find(garment =>
      ["accepted", "inspected", "processing", "packed"].includes(garment.status),
    );
    if (unaccounted) throw new AppError("CUSTODY_CONFLICT", "UNACCOUNTED_ITEMS", { garmentId: unaccounted.id });
    const openClaims = await tx.select({ id: claims.id }).from(claims).where(and(
      eq(claims.organizationId, principal.organizationId),
      eq(claims.orderId, order.id),
      inArray(claims.state, ["opened", "triage", "investigating", "decision_pending", "escalated", "reopened"]),
    )).limit(1);
    const partialAttempt = await tx.select({ id: deliveryAttempts.id }).from(deliveryAttempts)
      .where(and(
        eq(deliveryAttempts.organizationId, principal.organizationId),
        eq(deliveryAttempts.orderId, order.id),
        eq(deliveryAttempts.outcome, "partial"),
      )).limit(1);
    const deliveredAttempt = orderGarments.length === 0 && partialAttempt.length > 0
      ? await tx.select({ id: deliveryAttempts.id }).from(deliveryAttempts)
        .where(and(
          eq(deliveryAttempts.organizationId, principal.organizationId),
          eq(deliveryAttempts.orderId, order.id),
          eq(deliveryAttempts.outcome, "delivered"),
        )).limit(1)
      : [];
    const allGarmentsDelivered = orderGarments.length > 0
      ? orderGarments.every(garment => garment.status === "delivered")
      : deliveredAttempt.length > 0;
    if (partialAttempt.length && !allGarmentsDelivered && !openClaims.length) {
      throw new AppError("CUSTODY_CONFLICT", "PARTIAL_DELIVERY_REQUIRES_EXCEPTION", { attemptId: partialAttempt[0].id });
    }
    // An open claim does not block closure, and a full recovery delivery clears an earlier partial.
    const to = nextState(order.lifecycleState as "delivered", "close", principal);
    const [closed] = await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
      .returning({ id: orders.id });
    if (!closed) throw errors.version(order.version);
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id, eventType: "order.closed",
      payload: { openClaimCount: openClaims.length },
    });
    return { orderId: order.id, state: to, openClaimCount: openClaims.length };
  });
}

export async function dispatchOverview(db: Db, principal: Principal) {
  assertRole(principal, ...ROLE_GROUPS.dispatcher);
  const orgId = principal.organizationId;

  const orderQueueSelect = {
    id: orders.id,
    publicNumber: orders.publicNumber,
    lifecycleState: orders.lifecycleState,
    assignedPartnerId: orders.assignedPartnerId,
    returnReason: orders.returnReason,
    buildingId: customerAddresses.buildingId,
    address: buildings.address,
    createdAt: orders.createdAt,
  };

  const [shiftRows, partnerRows, pickupQueue, deliveryQueue, returnOrders, openDiscrepancies] = await Promise.all([
    db.select({
      id: courierShifts.id,
      courierId: courierShifts.courierId,
      courierName: users.displayName,
      vehicleId: courierShifts.vehicleId,
      vehiclePlate: vehicles.plate,
      capacityWeightGrams: vehicles.capacityWeightGrams,
      state: courierShifts.state,
      startsAt: courierShifts.startsAt,
      endsAt: courierShifts.endsAt,
    }).from(courierShifts)
      .leftJoin(users, eq(users.id, courierShifts.courierId))
      .leftJoin(vehicles, eq(vehicles.id, courierShifts.vehicleId))
      .where(and(
        eq(courierShifts.organizationId, orgId),
        inArray(courierShifts.state, ["planned", "active"]),
      ))
      .orderBy(asc(courierShifts.startsAt))
      .limit(100),
    db.select({
      id: partners.id,
      name: partners.name,
      status: partners.status,
      createdAt: partners.createdAt,
    }).from(partners)
      .where(eq(partners.organizationId, orgId))
      .orderBy(asc(partners.name))
      .limit(100),
    db.select(orderQueueSelect).from(orders)
      .innerJoin(customerAddresses, eq(customerAddresses.id, orders.addressId))
      .innerJoin(buildings, eq(buildings.id, customerAddresses.buildingId))
      .where(and(
        eq(orders.organizationId, orgId),
        inArray(orders.lifecycleState, ["scheduled", "pickup_assigned"]),
      ))
      .orderBy(asc(orders.createdAt))
      .limit(100),
    db.select(orderQueueSelect).from(orders)
      .innerJoin(customerAddresses, eq(customerAddresses.id, orders.addressId))
      .innerJoin(buildings, eq(buildings.id, customerAddresses.buildingId))
      .where(and(
        eq(orders.organizationId, orgId),
        inArray(orders.lifecycleState, ["ready", "out_for_delivery"]),
      ))
      .orderBy(asc(orders.createdAt))
      .limit(100),
    db.select(orderQueueSelect).from(orders)
      .innerJoin(customerAddresses, eq(customerAddresses.id, orders.addressId))
      .innerJoin(buildings, eq(buildings.id, customerAddresses.buildingId))
      .where(and(
        eq(orders.organizationId, orgId),
        isNotNull(orders.returnReason),
      ))
      .orderBy(desc(orders.createdAt))
      .limit(100),
    db.select({
      id: custodyDiscrepancies.id,
      orderId: custodyDiscrepancies.orderId,
      publicNumber: orders.publicNumber,
      orderState: orders.lifecycleState,
      kind: custodyDiscrepancies.kind,
      detailsJson: custodyDiscrepancies.detailsJson,
      state: custodyDiscrepancies.state,
      openedBy: custodyDiscrepancies.openedBy,
      openedAt: custodyDiscrepancies.openedAt,
    }).from(custodyDiscrepancies)
      .innerJoin(orders, eq(orders.id, custodyDiscrepancies.orderId))
      .where(and(
        eq(custodyDiscrepancies.organizationId, orgId),
        eq(custodyDiscrepancies.state, "open"),
      ))
      .orderBy(desc(custodyDiscrepancies.openedAt))
      .limit(100),
  ]);

  return {
    shifts: shiftRows,
    partners: partnerRows,
    pickupQueue,
    deliveryQueue,
    returnOrders,
    openDiscrepancies,
  };
}
