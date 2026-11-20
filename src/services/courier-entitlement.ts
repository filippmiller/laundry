import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { courierShifts, routes, routeStops } from "../db/schema.js";
import { hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";

/**
 * Canonical Courier Shift & Stop Entitlement Rule
 *
 * Lock Ordering Contract (must be respected across courier-shift, delivery, intake, and workspace):
 *   1. Per-courier openShift advisory lock (`pg_advisory_xact_lock`, only in `openShift`)
 *   2. `courier_shifts` (`FOR UPDATE` in `completeShift`; `FOR SHARE` in all courier stop/intake/delivery/evidence/scan actions)
 *   3. `route_stops`
 *   4. `orders`
 *   5. `evidence_assets`
 *
 * Because `completeShift` only locks `courier_shifts` (`FOR UPDATE`) and every courier action
 * acquires `FOR SHARE` on `courier_shifts` BEFORE locking or mutating any route stop, order, or
 * evidence asset, shift close and courier operations serialize cleanly with zero deadlocks:
 *   - Either the courier action acquires `FOR SHARE` first and commits cleanly before `completeShift`
 *     can acquire `FOR UPDATE` and snapshot the shift;
 *   - Or `completeShift` acquires `FOR UPDATE` first and commits `state = 'completed'`, after which
 *     the waiting courier action observes `state !== 'active'` and aborts with zero business effect.
 *
 * A new active shift for the same courier has a different `shiftId`, so routes belonging to an
 * earlier completed shift are never re-authorized by opening a new shift.
 */

export const ACTIVE_STOP_STATES = ["pending", "en_route", "arrived"] as const;
export const HISTORICAL_SCAN_STOP_STATES = ["pending", "en_route", "arrived", "completed"] as const;

type DbOrTx = Db | Tx;

export async function lockCourierShiftForUpdate(
  tx: Tx,
  organizationId: string,
  shiftId: string,
) {
  const [shift] = await tx.select().from(courierShifts).where(and(
    eq(courierShifts.id, shiftId),
    eq(courierShifts.organizationId, organizationId),
  )).for("update").limit(1);
  return shift;
}

export async function lockCourierShiftForShare(
  tx: Tx,
  organizationId: string,
  shiftId: string,
) {
  const [shift] = await tx.select().from(courierShifts).where(and(
    eq(courierShifts.id, shiftId),
    eq(courierShifts.organizationId, organizationId),
  )).for("share").limit(1);
  return shift;
}

/**
 * Canonical WHERE predicate for active courier stops (`currentCourierStops`).
 * Checks tenant, assignedCourierId, route.shiftId, shift.courierId, and shift.state === 'active'.
 */
export function activeCourierStopsFilter(principal: Principal) {
  return and(
    eq(routeStops.organizationId, principal.organizationId),
    eq(routeStops.assignedCourierId, principal.userId),
    eq(routes.organizationId, principal.organizationId),
    eq(courierShifts.organizationId, principal.organizationId),
    eq(courierShifts.courierId, principal.userId),
    eq(courierShifts.state, "active"),
    inArray(routeStops.state, [...ACTIVE_STOP_STATES]),
  );
}

/**
 * Authorizes a courier (or dispatcher) to mutate a specific `route_stops` row.
 * For couriers, locks the stop's `courier_shifts` row `FOR SHARE` FIRST (before any stop/order
 * mutation), then re-verifies tenant, `assignedCourierId`, `route.shiftId`, `shift.courierId`,
 * and `shift.state === 'active'`, and returns the fresh stop row.
 */
export async function assertCourierStopEntitlement(
  tx: Tx,
  principal: Principal,
  stopId: string,
) {
  const isDispatcher = hasRole(principal, ...ROLE_GROUPS.dispatcher);

  const [initial] = await tx.select({
    stopId: routeStops.id,
    routeId: routeStops.routeId,
    assignedCourierId: routeStops.assignedCourierId,
    shiftId: routes.shiftId,
  })
    .from(routeStops)
    .innerJoin(routes, and(
      eq(routes.id, routeStops.routeId),
      eq(routes.organizationId, principal.organizationId),
    ))
    .where(and(
      eq(routeStops.id, stopId),
      eq(routeStops.organizationId, principal.organizationId),
    ))
    .limit(1);

  if (!initial) throw errors.notFound("stop");

  if (!isDispatcher) {
    if (initial.assignedCourierId !== principal.userId) {
      throw errors.forbidden("courier is not assigned to this stop");
    }
    const shift = await lockCourierShiftForShare(tx, principal.organizationId, initial.shiftId);
    if (!shift || shift.courierId !== principal.userId || shift.state !== "active") {
      throw new AppError("FORBIDDEN", "SHIFT_NOT_ACTIVE");
    }
  }

  // Re-read the stop after acquiring the shift lock so state/version are fresh.
  const [stop] = await tx.select().from(routeStops).where(and(
    eq(routeStops.id, stopId),
    eq(routeStops.organizationId, principal.organizationId),
  )).limit(1);
  if (!stop) throw errors.notFound("stop");
  if (!isDispatcher && stop.assignedCourierId !== principal.userId) {
    throw errors.forbidden("courier is not assigned to this stop");
  }

  return { stop, shiftId: initial.shiftId };
}

/**
 * Authorizes a courier (or dispatcher) to record intake for an order.
 * For couriers, locates the assigned active-state stop, locks its `courier_shifts` row `FOR SHARE`
 * FIRST (before any order/manifest/custody mutation), and re-verifies tenant, `assignedCourierId`,
 * `route.shiftId`, `shift.courierId`, and `shift.state === 'active'`.
 */
export async function assertCourierOrderIntakeEntitlement(
  tx: Tx,
  principal: Principal,
  orderId: string,
) {
  const isDispatcher = hasRole(principal, ...ROLE_GROUPS.dispatcher);
  if (isDispatcher) return;

  const candidates = await tx.select({
    stopId: routeStops.id,
    routeId: routeStops.routeId,
    shiftId: routes.shiftId,
    shiftState: courierShifts.state,
  })
    .from(routeStops)
    .innerJoin(routes, and(
      eq(routes.id, routeStops.routeId),
      eq(routes.organizationId, principal.organizationId),
    ))
    .innerJoin(courierShifts, and(
      eq(courierShifts.id, routes.shiftId),
      eq(courierShifts.organizationId, principal.organizationId),
    ))
    .where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, orderId),
      eq(routeStops.assignedCourierId, principal.userId),
      inArray(routeStops.state, [...ACTIVE_STOP_STATES]),
    ))
    .orderBy(sql`case when ${courierShifts.state} = 'active' then 0 else 1 end`, desc(courierShifts.startsAt))
    .limit(5);

  if (candidates.length === 0) {
    throw errors.forbidden("courier is not assigned to this stop");
  }

  for (const candidate of candidates) {
    const shift = await lockCourierShiftForShare(tx, principal.organizationId, candidate.shiftId);
    if (!shift || shift.courierId !== principal.userId || shift.state !== "active") {
      continue;
    }
    const [freshStop] = await tx.select({ id: routeStops.id }).from(routeStops).where(and(
      eq(routeStops.id, candidate.stopId),
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, orderId),
      eq(routeStops.assignedCourierId, principal.userId),
      inArray(routeStops.state, [...ACTIVE_STOP_STATES]),
    )).limit(1);
    if (freshStop) return;
  }

  throw new AppError("FORBIDDEN", "SHIFT_NOT_ACTIVE");
}

/**
 * Canonical courier order entitlement check used by all evidence operations
 * (list, read, content, register, upload, delete).
 * Checks tenant, `assignedCourierId`, `route.shiftId`, `shift.courierId`, `shift.state === 'active'`,
 * and active stop state. When `lockShift` is true (inside a transaction), locks `courier_shifts`
 * `FOR SHARE` and re-verifies inside the transaction so concurrent `completeShift` cannot race it.
 */
export async function hasActiveCourierOrderEntitlement(
  dbOrTx: DbOrTx,
  principal: Principal,
  orderId: string,
  options: { lockShift?: boolean } = {},
): Promise<boolean> {
  if (!hasRole(principal, "courier")) return false;

  const candidates = await dbOrTx.select({
    stopId: routeStops.id,
    shiftId: routes.shiftId,
  })
    .from(routeStops)
    .innerJoin(routes, and(
      eq(routes.id, routeStops.routeId),
      eq(routes.organizationId, principal.organizationId),
    ))
    .innerJoin(courierShifts, and(
      eq(courierShifts.id, routes.shiftId),
      eq(courierShifts.organizationId, principal.organizationId),
    ))
    .where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, orderId),
      eq(routeStops.assignedCourierId, principal.userId),
      eq(courierShifts.courierId, principal.userId),
      eq(courierShifts.state, "active"),
      inArray(routeStops.state, [...ACTIVE_STOP_STATES]),
    ))
    .orderBy(desc(courierShifts.startsAt))
    .limit(5);

  if (candidates.length === 0) return false;
  if (!options.lockShift) return true;

  for (const candidate of candidates) {
    const [shift] = await dbOrTx.select({
      id: courierShifts.id,
      courierId: courierShifts.courierId,
      state: courierShifts.state,
    }).from(courierShifts).where(and(
      eq(courierShifts.id, candidate.shiftId),
      eq(courierShifts.organizationId, principal.organizationId),
    )).for("share").limit(1);

    if (!shift || shift.courierId !== principal.userId || shift.state !== "active") {
      continue;
    }

    const [freshStop] = await dbOrTx.select({ id: routeStops.id }).from(routeStops).where(and(
      eq(routeStops.id, candidate.stopId),
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, orderId),
      eq(routeStops.assignedCourierId, principal.userId),
      inArray(routeStops.state, [...ACTIVE_STOP_STATES]),
    )).limit(1);

    if (freshStop) return true;
  }

  return false;
}

export type VerifiedScanShiftResolution =
  | { ok: true; shiftId: string; isLateCompletedShift: boolean }
  | { ok: false; reason: "NO_ACTIVE_SHIFT" | "ORDER_NOT_ASSIGNED" };

/**
 * Resolves the authoritative shift for an offline scan strictly from server-side route/shift
 * ownership (`route_stops -> routes -> courier_shifts`), NEVER trusting client-supplied `context`.
 *
 * 1. If the courier has an active shift owning an active-state stop for `orderId` (and `capturedAt`
 *    is not strictly before the active shift started, or no earlier completed shift owns it),
 *    locks that active shift `FOR SHARE` and verifies it is still active.
 * 2. Otherwise, checks if the courier owned a stop for `orderId` on a `completed` shift whose
 *    window `[startsAt, completedAt ?? endsAt]` covers `capturedAt`. If so, accepts as a late
 *    offline scan attributed to that original completed shift (never to a newer active shift).
 */
export async function resolveVerifiedScanShift(
  tx: Tx,
  principal: Principal,
  orderId: string,
  capturedAt: Date,
): Promise<VerifiedScanShiftResolution> {
  const rows = await tx.select({
    stopId: routeStops.id,
    stopState: routeStops.state,
    shiftId: courierShifts.id,
    shiftState: courierShifts.state,
    startsAt: courierShifts.startsAt,
    endsAt: courierShifts.endsAt,
    completedAt: courierShifts.completedAt,
  })
    .from(routeStops)
    .innerJoin(routes, and(
      eq(routes.id, routeStops.routeId),
      eq(routes.organizationId, principal.organizationId),
    ))
    .innerJoin(courierShifts, and(
      eq(courierShifts.id, routes.shiftId),
      eq(courierShifts.organizationId, principal.organizationId),
    ))
    .where(and(
      eq(routeStops.organizationId, principal.organizationId),
      eq(routeStops.orderId, orderId),
      eq(routeStops.assignedCourierId, principal.userId),
      eq(courierShifts.courierId, principal.userId),
      inArray(routeStops.state, [...HISTORICAL_SCAN_STOP_STATES]),
    ))
    .orderBy(desc(courierShifts.startsAt))
    .limit(10);

  // First check completed shifts whose actual window contains `capturedAt` when an active shift
  // started later (ensures a late scan from Shift 1 is NEVER misattributed to Shift 2 even if
  // the order was later re-assigned to Shift 2).
  const matchingCompleted = rows.find(row => {
    if (row.shiftState !== "completed") return false;
    const upperBound = row.completedAt ?? row.endsAt;
    return capturedAt >= row.startsAt && capturedAt <= upperBound;
  });

  // Check active shifts with an active-state stop for this order.
  const activeCandidates = rows.filter(
    row => row.shiftState === "active"
      && (ACTIVE_STOP_STATES as readonly string[]).includes(row.stopState),
  );

  for (const candidate of activeCandidates) {
    // If `capturedAt` clearly belongs to an earlier completed shift window rather than this
    // active shift, prefer the original completed shift.
    if (matchingCompleted && capturedAt < candidate.startsAt) {
      break;
    }
    const lockedShift = await lockCourierShiftForShare(tx, principal.organizationId, candidate.shiftId);
    if (!lockedShift || lockedShift.courierId !== principal.userId) continue;
    if (lockedShift.state === "active") {
      return { ok: true, shiftId: lockedShift.id, isLateCompletedShift: false };
    }
    // Shift completed while we waited for the lock: fall through to late-scan check if capturedAt fits.
    if (lockedShift.state === "completed") {
      const upperBound = lockedShift.completedAt ?? lockedShift.endsAt;
      if (capturedAt >= lockedShift.startsAt && capturedAt <= upperBound) {
        return { ok: true, shiftId: lockedShift.id, isLateCompletedShift: true };
      }
    }
  }

  if (matchingCompleted) {
    // Lock FOR SHARE to ensure shift metadata is committed and consistent.
    const lockedCompleted = await lockCourierShiftForShare(tx, principal.organizationId, matchingCompleted.shiftId);
    if (lockedCompleted && lockedCompleted.courierId === principal.userId && lockedCompleted.state === "completed") {
      const upperBound = lockedCompleted.completedAt ?? lockedCompleted.endsAt;
      if (capturedAt >= lockedCompleted.startsAt && capturedAt <= upperBound) {
        return { ok: true, shiftId: lockedCompleted.id, isLateCompletedShift: true };
      }
    }
  }

  // Distinguish NO_ACTIVE_SHIFT vs ORDER_NOT_ASSIGNED for courier callers.
  if (hasRole(principal, "courier") && !hasRole(principal, ...ROLE_GROUPS.dispatcher)) {
    const [activeShift] = await tx.select({ id: courierShifts.id }).from(courierShifts).where(and(
      eq(courierShifts.organizationId, principal.organizationId),
      eq(courierShifts.courierId, principal.userId),
      eq(courierShifts.state, "active"),
    )).limit(1);
    if (!activeShift) return { ok: false, reason: "NO_ACTIVE_SHIFT" };
  }

  return { ok: false, reason: "ORDER_NOT_ASSIGNED" };
}
