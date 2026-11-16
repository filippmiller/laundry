import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  claims, courierShifts, custodyEvents, deliveryAttempts, garments, notifications, orders, routes, routeStops,
} from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";
import { nextState, type OrderState } from "../domain/order-state.js";

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
    if (deliveredIds.length) {
      const owned = await tx.select({ id: garments.id }).from(garments).where(and(
        eq(garments.organizationId, principal.organizationId),
        eq(garments.orderId, order.id),
        inArray(garments.id, deliveredIds),
      ));
      if (owned.length !== new Set(deliveredIds).size) throw errors.notFound("garment");
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
    if (input.outcome === "delivered" && allGarments.length > 0 && deliveredIds.length === allGarments.length) {
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
    return { attemptId: attempt.id, orderId: order.id, outcome: input.outcome, state };
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
    // An open claim does not block closure, but must be visible as an exception.
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
