import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  courierShifts, outboxEvents, routeStops, routes, scanEvents, shiftReconciliationAdjustments,
} from "../db/schema.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";
import { lockCourierShiftForUpdate } from "./courier-entitlement.js";

const COURIER_ROLES = ["courier", ...ROLE_GROUPS.dispatcher] as const;

/**
 * A courier opens their own shift: it starts active immediately so dispatch can assign stops to
 * it. One active shift per courier at a time — concurrent opens (fresh+fresh or planned+fresh)
 * serialize on a per-courier advisory lock and are also enforced by a DB partial unique index on
 * `courier_shifts (organization_id, courier_id) WHERE state = 'active'`.
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
    // Serialize all shift-open attempts per (organization, courier) so two concurrent opens
    // (fresh+fresh or planned->active racing fresh open) yield strictly one active shift.
    const lockKey = `courier_shift_open:${principal.organizationId}:${principal.userId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const [active] = await tx.select().from(courierShifts).where(and(
      eq(courierShifts.organizationId, principal.organizationId),
      eq(courierShifts.courierId, principal.userId),
      eq(courierShifts.state, "active"),
    )).limit(1);
    if (active) return { shiftId: active.id, state: active.state, reused: true as const };

    const [planned] = await tx.select().from(courierShifts).where(and(
      eq(courierShifts.organizationId, principal.organizationId),
      eq(courierShifts.courierId, principal.userId),
      eq(courierShifts.state, "planned"),
    )).orderBy(asc(courierShifts.startsAt)).for("update").limit(1);
    if (planned) {
      const nextStartsAt = input.startsAt ? startsAt : now;
      const nextEndsAt = input.endsAt
        ? endsAt
        : planned.endsAt > nextStartsAt
          ? planned.endsAt
          : new Date(nextStartsAt.getTime() + 8 * 60 * 60 * 1000);
      const [activated] = await tx.update(courierShifts).set({
        state: "active",
        startsAt: nextStartsAt,
        endsAt: nextEndsAt,
      }).where(and(
        eq(courierShifts.id, planned.id),
        eq(courierShifts.organizationId, principal.organizationId),
        eq(courierShifts.courierId, principal.userId),
        eq(courierShifts.state, "planned"),
      )).returning();
      if (!activated) throw new AppError("CONFLICT_VERSION", "CONFLICT_VERSION");
      await appendEvent(tx, {
        principal, aggregateType: "courier_shift", aggregateId: activated.id,
        eventType: "shift.opened", payload: { startsAt: nextStartsAt, endsAt: nextEndsAt, fromPlanned: true },
      });
      return { shiftId: activated.id, state: activated.state, reused: false as const };
    }
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
  )).orderBy(sql`case when ${courierShifts.state} = 'active' then 0 else 1 end`, asc(courierShifts.startsAt)).limit(1);
  return shift ? { shiftId: shift.id, state: shift.state, startsAt: shift.startsAt, endsAt: shift.endsAt } : null;
}

/**
 * End-of-shift reconciliation: locks the shift row `FOR UPDATE` (level 1 of the canonical lock
 * order) so every concurrent stop/intake/delivery/evidence operation either commits cleanly before
 * shift close or observes `state === 'completed'` and aborts with zero business effect.
 *
 * The close snapshot is recorded immutably in the `shift.completed` domain event. Late valid
 * offline scans arriving after close are never attributed to a newer shift; instead they append
 * auditable `shift_reconciliation_adjustments` rows against this shift.
 */
export async function completeShift(db: Db, principal: Principal, input: { shiftId: string; key: string }) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "shift:complete", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const shift = await lockCourierShiftForUpdate(tx, principal.organizationId, input.shiftId);
    if (!shift) throw errors.notFound("shift");
    const isDispatcher = (ROLE_GROUPS.dispatcher as readonly string[]).some(role =>
      (principal.roles as readonly string[]).includes(role));
    if (!isDispatcher && shift.courierId !== principal.userId) throw errors.notFound("shift");
    if (shift.state === "completed") {
      const adjustments = await tx.select({
        id: shiftReconciliationAdjustments.id,
        scanEventId: shiftReconciliationAdjustments.scanEventId,
        deltaAccepted: shiftReconciliationAdjustments.deltaAccepted,
        deltaRejected: shiftReconciliationAdjustments.deltaRejected,
        reason: shiftReconciliationAdjustments.reason,
        recordedAt: shiftReconciliationAdjustments.recordedAt,
      }).from(shiftReconciliationAdjustments).where(and(
        eq(shiftReconciliationAdjustments.organizationId, principal.organizationId),
        eq(shiftReconciliationAdjustments.shiftId, shift.id),
      )).orderBy(asc(shiftReconciliationAdjustments.recordedAt));
      return { shiftId: shift.id, state: "completed" as const, alreadyCompleted: true as const, adjustments };
    }
    const shiftRoutes = await tx.select({ id: routes.id }).from(routes).where(and(
      eq(routes.shiftId, shift.id),
      eq(routes.organizationId, principal.organizationId),
    ));
    const routeIds = shiftRoutes.map(route => route.id);
    const stops = routeIds.length
      ? await tx.select({ state: routeStops.state }).from(routeStops).where(and(
          eq(routeStops.organizationId, principal.organizationId),
          inArray(routeStops.routeId, routeIds),
        ))
      : [];
    const byState: Record<string, number> = {};
    for (const stop of stops) byState[stop.state] = (byState[stop.state] ?? 0) + 1;
    const completedAt = new Date();
    const scanRows = await tx.select({ state: scanEvents.syncStatus, count: sql<number>`count(*)::int` })
      .from(scanEvents)
      .where(and(
        eq(scanEvents.organizationId, principal.organizationId),
        eq(scanEvents.actorId, shift.courierId),
        or(
          eq(scanEvents.shiftId, shift.id),
          and(
            isNull(scanEvents.shiftId),
            gte(scanEvents.capturedAt, shift.startsAt),
            lte(scanEvents.capturedAt, completedAt),
          ),
        ),
      ))
      .groupBy(scanEvents.syncStatus);
    const scans = { accepted: 0, rejected: 0 };
    for (const row of scanRows) {
      if (row.state === "accepted") scans.accepted = row.count;
      if (row.state === "rejected") scans.rejected = row.count;
    }
    await tx.update(courierShifts).set({
      state: "completed",
      completedAt,
    }).where(eq(courierShifts.id, shift.id));
    await appendEvent(tx, {
      principal, aggregateType: "courier_shift", aggregateId: shift.id,
      eventType: "shift.completed", payload: { stops: byState, scans, completedAt: completedAt.toISOString() },
    });
    return { shiftId: shift.id, state: "completed" as const, completedAt, stops: byState, scans, replayed: false as const };
  });
}

/**
 * Returns the immutable original close snapshot together with any post-close reconciliation
 * adjustments recorded for late valid offline scans.
 */
export async function getShiftReconciliation(db: Db, principal: Principal, shiftId: string) {
  assertRole(principal, "courier", ...ROLE_GROUPS.dispatcher);
  const [shift] = await db.select().from(courierShifts).where(and(
    eq(courierShifts.id, shiftId),
    eq(courierShifts.organizationId, principal.organizationId),
  )).limit(1);
  if (!shift) throw errors.notFound("shift");
  const isDispatcher = (ROLE_GROUPS.dispatcher as readonly string[]).some(role =>
    (principal.roles as readonly string[]).includes(role));
  if (!isDispatcher && shift.courierId !== principal.userId) throw errors.notFound("shift");

  const [completedEvent] = await db.select({
    payloadJson: outboxEvents.payloadJson,
    createdAt: outboxEvents.createdAt,
  }).from(outboxEvents).where(and(
    eq(outboxEvents.organizationId, principal.organizationId),
    eq(outboxEvents.aggregateType, "courier_shift"),
    eq(outboxEvents.aggregateId, shift.id),
    eq(outboxEvents.eventType, "shift.completed"),
  )).orderBy(asc(outboxEvents.createdAt)).limit(1);

  const snapshotPayload = (completedEvent?.payloadJson ?? {}) as {
    stops?: Record<string, number>;
    scans?: { accepted?: number; rejected?: number };
  };
  const snapshotScans = {
    accepted: Number(snapshotPayload.scans?.accepted ?? 0),
    rejected: Number(snapshotPayload.scans?.rejected ?? 0),
  };

  const adjustments = await db.select({
    id: shiftReconciliationAdjustments.id,
    scanEventId: shiftReconciliationAdjustments.scanEventId,
    deltaAccepted: shiftReconciliationAdjustments.deltaAccepted,
    deltaRejected: shiftReconciliationAdjustments.deltaRejected,
    reason: shiftReconciliationAdjustments.reason,
    recordedAt: shiftReconciliationAdjustments.recordedAt,
  }).from(shiftReconciliationAdjustments).where(and(
    eq(shiftReconciliationAdjustments.organizationId, principal.organizationId),
    eq(shiftReconciliationAdjustments.shiftId, shift.id),
  )).orderBy(asc(shiftReconciliationAdjustments.recordedAt));

  const effectiveScans = {
    accepted: snapshotScans.accepted + adjustments.reduce((sum, adj) => sum + adj.deltaAccepted, 0),
    rejected: snapshotScans.rejected + adjustments.reduce((sum, adj) => sum + adj.deltaRejected, 0),
  };

  return {
    shiftId: shift.id,
    state: shift.state,
    completedAt: shift.completedAt,
    snapshot: completedEvent
      ? { stops: snapshotPayload.stops ?? {}, scans: snapshotScans }
      : null,
    adjustments,
    effectiveScans,
  };
}
