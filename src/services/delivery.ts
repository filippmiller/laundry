import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  buildings, claims, courierShifts, custodyDiscrepancies, custodyEvents, customerAddresses,
  deliveryAttempts, garments, notifications, orders, partners, routes, routeStops, users, vehicles,
} from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
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
    const to = nextState(order.lifecycleState as "scheduled", "assign_pickup", principal);
    await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
    await appendEvent(tx, {
      principal, aggregateType: "order", aggregateId: order.id,
      eventType: "order.assign_pickup", payload: { stopId: stop.id, courierId: shift.courierId },
    });
    return { orderId: order.id, stopId: stop.id, courierId: shift.courierId, state: to };
  });
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
  }).from(routeStops)
    .innerJoin(orders, eq(orders.id, routeStops.orderId))
    .where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.assignedCourierId, principal.userId),
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
    if (stop.assignedCourierId !== principal.userId && !principal.roles.includes("dispatcher")) {
      throw errors.forbidden("courier is not assigned to this stop");
    }
    if (stop.state !== "pending") throw errors.transition(stop.state, "start");
    await tx.update(routeStops).set({ state: "en_route", version: stop.version + 1 })
      .where(and(eq(routeStops.id, stop.id), eq(routeStops.version, stop.version)));
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
    if (order.lifecycleState !== "ready") throw errors.transition(order.lifecycleState, "dispatch");
    const [shift] = await tx.select().from(courierShifts).where(and(
      eq(courierShifts.id, input.shiftId), eq(courierShifts.organizationId, principal.organizationId),
    )).limit(1);
    if (!shift || shift.state !== "active") throw errors.notFound("shift");

    const [route] = await tx.insert(routes).values({
      organizationId: principal.organizationId,
      shiftId: shift.id,
      kind: "delivery",
      plannedStart: input.windowStart ?? new Date("2026-12-02T10:00:00Z"),
      plannedEnd: input.windowEnd ?? new Date("2026-12-02T12:00:00Z"),
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
    const to = nextState("ready", "dispatch", principal);
    await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
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
    if (stop.assignedCourierId !== principal.userId && !principal.roles.includes("dispatcher")) {
      throw errors.forbidden("courier is not assigned to this stop");
    }
    if (stop.state !== "pending" && stop.state !== "en_route") throw errors.transition(stop.state, "arrive");
    await tx.update(routeStops).set({ state: "arrived", version: stop.version + 1 })
      .where(and(eq(routeStops.id, stop.id), eq(routeStops.version, stop.version)));
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
    if (stop.assignedCourierId !== principal.userId && !principal.roles.includes("dispatcher")) {
      throw errors.forbidden("courier is not assigned to this stop");
    }
    if (stop.state !== "arrived") throw errors.transition(stop.state, "attempt");
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, stop.orderId), eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    if (!order) throw errors.notFound("order");

    const allGarments = await tx.select().from(garments).where(and(
      eq(garments.organizationId, principal.organizationId), eq(garments.orderId, order.id),
    ));
    const deliveredIds = input.deliveredGarmentIds ?? [];
    const uniqueDelivered = new Set(deliveredIds);
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
    if (input.outcome === "delivered" && allGarments.length > 0) {
      const missing = allGarments.filter(garment => garment.status === "missing_reported");
      if (missing.length > 0) {
        throw new AppError("CUSTODY_CONFLICT", "MISSING_GARMENTS_CANNOT_BE_DELIVERED", {
          missingGarmentIds: missing.map(garment => garment.id),
        });
      }
      const unprocessed = allGarments.filter(garment => garment.status === "returned_unprocessed");
      if (unprocessed.length > 0 && !order.returnReason) {
        throw new AppError("CUSTODY_CONFLICT", "RETURN_REASON_REQUIRED", {
          garmentIds: unprocessed.map(garment => garment.id),
        });
      }
      const exactSet = deliveredIds.length === allGarments.length
        && allGarments.every(garment => uniqueDelivered.has(garment.id));
      if (!exactSet) {
        throw new AppError("CUSTODY_CONFLICT", "DELIVERY_SET_MISMATCH", {
          required: allGarments.length, delivered: uniqueDelivered.size,
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
    if (input.outcome === "delivered" && (allGarments.length === 0 || uniqueDelivered.size === allGarments.length)) {
      state = nextState(order.lifecycleState as "out_for_delivery", "handover", principal);
      await tx.update(orders).set({ lifecycleState: state, version: order.version + 1 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
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
      await tx.update(routeStops).set({ state: "completed", version: stop.version + 1 })
        .where(and(eq(routeStops.id, stop.id), eq(routeStops.version, stop.version)));
    } else if (input.outcome === "partial") {
      for (const id of deliveredIds) {
        await tx.update(garments).set({ status: "delivered" }).where(eq(garments.id, id));
      }
      await tx.update(routeStops).set({ state: "completed", version: stop.version + 1 })
        .where(and(eq(routeStops.id, stop.id), eq(routeStops.version, stop.version)));
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
      await tx.update(orders).set({ lifecycleState: state, version: order.version + 1 })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
      await tx.update(routeStops).set({ state: "failed", version: stop.version + 1 })
        .where(and(eq(routeStops.id, stop.id), eq(routeStops.version, stop.version)));
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
    const unaccounted = await tx.select({ id: garments.id }).from(garments).where(and(
      eq(garments.organizationId, principal.organizationId),
      eq(garments.orderId, order.id),
      inArray(garments.status, ["accepted", "inspected", "processing", "packed"]),
    )).limit(1);
    if (unaccounted.length) throw new AppError("CUSTODY_CONFLICT", "UNACCOUNTED_ITEMS", { garmentId: unaccounted[0].id });
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
    if (partialAttempt.length && !openClaims.length) {
      throw new AppError("CUSTODY_CONFLICT", "PARTIAL_DELIVERY_REQUIRES_EXCEPTION", { attemptId: partialAttempt[0].id });
    }
    // An open claim does not block closure, but is required to explain a partial delivery.
    const to = nextState(order.lifecycleState as "delivered", "close", principal);
    await tx.update(orders).set({ lifecycleState: to, version: order.version + 1 })
      .where(and(eq(orders.id, order.id), eq(orders.version, order.version)));
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
