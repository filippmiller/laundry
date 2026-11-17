import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { courierShifts, routeStops, routes, scanEvents } from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

const COURIER_ROLES = ["courier", ...ROLE_GROUPS.dispatcher] as const;

/**
 * A courier opens their own shift: it starts active immediately so dispatch can assign stops to
 * it. One active shift per courier at a time — a second open call returns the existing one.
 */
export async function openShift(
  db: Db,
  principal: Principal,
  input: { startsAt?: string; endsAt?: string; key: string },
) {
  assertRole(principal, ...COURIER_ROLES);
  const now = new Date();
  const startsAt = input.startsAt ? new Date(input.startsAt) : now;
  const endsAt = input.endsAt ? new Date(input.endsAt) : new Date(now.getTime() + 8 * 60 * 60 * 1000);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw new AppError("VALIDATION_ERROR", "SHIFT_WINDOW_INVALID");
  }
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "shift:open", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [running] = await tx.select().from(courierShifts).where(and(
      eq(courierShifts.organizationId, principal.organizationId),
      eq(courierShifts.courierId, principal.userId),
      inArray(courierShifts.state, ["planned", "active"]),
    )).limit(1);
    if (running) return { shiftId: running.id, state: running.state, reused: true as const };
    const [shift] = await tx.insert(courierShifts).values({
      organizationId: principal.organizationId,
      courierId: principal.userId,
      state: "active",
      startsAt,
      endsAt,
    }).returning();
    await appendEvent(tx, {
      principal, aggregateType: "courier_shift", aggregateId: shift.id,
      eventType: "shift.opened", payload: { startsAt, endsAt },
    });
    return { shiftId: shift.id, state: shift.state, reused: false as const };
  });
}

export async function currentShift(db: Db, principal: Principal) {
  assertRole(principal, ...COURIER_ROLES);
  const [shift] = await db.select().from(courierShifts).where(and(
    eq(courierShifts.organizationId, principal.organizationId),
    eq(courierShifts.courierId, principal.userId),
    inArray(courierShifts.state, ["planned", "active"]),
  )).limit(1);
  return shift ? { shiftId: shift.id, state: shift.state, startsAt: shift.startsAt, endsAt: shift.endsAt } : null;
}

/**
 * End-of-shift reconciliation: the courier sees exactly what was completed, failed and how many
 * custody scans were accepted — the numbers the platform will hold them to. Stops still open
 * (pending/en_route/arrived) do not block closing the shift, but they are reported honestly.
 */
export async function completeShift(db: Db, principal: Principal, input: { shiftId: string; key: string }) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "shift:complete", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const [shift] = await tx.select().from(courierShifts).where(and(
      eq(courierShifts.id, input.shiftId),
      eq(courierShifts.organizationId, principal.organizationId),
    )).limit(1);
    if (!shift) throw errors.notFound("shift");
    const isDispatcher = (ROLE_GROUPS.dispatcher as readonly string[]).some(role =>
      (principal.roles as readonly string[]).includes(role));
    if (!isDispatcher && shift.courierId !== principal.userId) throw errors.notFound("shift");
    if (shift.state === "completed") {
      return { shiftId: shift.id, state: "completed" as const, alreadyCompleted: true as const };
    }
    const shiftRoutes = await tx.select({ id: routes.id }).from(routes).where(eq(routes.shiftId, shift.id));
    const routeIds = shiftRoutes.map(route => route.id);
    const stops = routeIds.length
      ? await tx.select({ state: routeStops.state }).from(routeStops).where(inArray(routeStops.routeId, routeIds))
      : [];
    const byState: Record<string, number> = {};
    for (const stop of stops) byState[stop.state] = (byState[stop.state] ?? 0) + 1;
    const scanRows = await tx.select({ state: scanEvents.syncStatus, count: sql<number>`count(*)::int` })
      .from(scanEvents)
      .where(and(eq(scanEvents.organizationId, principal.organizationId), eq(scanEvents.actorId, shift.courierId)))
      .groupBy(scanEvents.syncStatus);
    const scans = { accepted: 0, rejected: 0 };
    for (const row of scanRows) {
      if (row.state === "accepted") scans.accepted = row.count;
      if (row.state === "rejected") scans.rejected = row.count;
    }
    await tx.update(courierShifts).set({ state: "completed" }).where(eq(courierShifts.id, shift.id));
    await appendEvent(tx, {
      principal, aggregateType: "courier_shift", aggregateId: shift.id,
      eventType: "shift.completed", payload: { stops: byState, scans },
    });
    return { shiftId: shift.id, state: "completed" as const, stops: byState, scans, replayed: false as const };
  });
}
