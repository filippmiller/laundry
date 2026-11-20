import { and, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { buildings, orders, serviceWindows, slotReservations } from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotency } from "../core/idempotency.js";

export type HoldRequest = {
  principal: Principal;
  windowId: string;
  key: string;
  /**
   * Absolute expiry, for a caller that names a fixed instant — the demo book uses the window's
   * own end, which is the same on every re-run.
   */
  expiresAt?: Date;
  /**
   * Lifetime in minutes, for a caller that asks for "the next ten minutes". The HTTP surface
   * uses this: an absolute instant computed from the wall clock differs on every retry of the
   * same request, which turned the replay of a hold into a payload conflict.
   */
  ttlMinutes?: number;
  orderId?: string | null;
  quoteId?: string | null;
  capacityUnits?: number;
  body?: Record<string, unknown>;
  now?: Date;
};
export type HoldResult = {
  reservationId: string;
  windowId: string;
  state: "held";
  expiresAt: string;
  replayed?: boolean;
};

function fingerprint(input: HoldRequest) {
  // The fingerprint has to cover a value the caller controls. A lifetime in minutes is stable
  // for a client that asks for ten minutes; an absolute instant is stable for a caller that
  // names a fixed moment. Hashing a wall-clock derived quantity made every retry of the same
  // request look like a changed body.
  const lifetime = input.ttlMinutes !== undefined
    ? { ttlMinutes: input.ttlMinutes }
    : { expiresAt: input.expiresAt!.toISOString() };
  return hashRequest({
    organizationId: input.principal.organizationId,
    principalId: input.principal.userId,
    windowId: input.windowId,
    key: input.key,
    ...lifetime,
    orderId: input.orderId ?? null,
    quoteId: input.quoteId ?? null,
    capacityUnits: input.capacityUnits ?? 1,
    body: input.body ?? {},
  });
}

export async function holdSlot(db: Db, input: HoldRequest): Promise<HoldResult> {
  assertRole(input.principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher, "system_worker");
  if (!input.principal.organizationId) throw errors.forbidden();
  if (!input.key?.trim() || input.key.length > 200) throw new AppError("VALIDATION_ERROR", "INVALID_IDEMPOTENCY_KEY");
  const now = input.now ?? new Date();
  const units = input.capacityUnits ?? 1;
  if (!Number.isInteger(units) || units < 1) throw new AppError("VALIDATION_ERROR", "INVALID_CAPACITY_UNITS");
  const expiresAt = input.ttlMinutes !== undefined
    ? new Date(now.getTime() + input.ttlMinutes * 60_000)
    : input.expiresAt;
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new AppError("INVALID_EXPIRY");
  }
  const requestHash = fingerprint({ ...input, expiresAt, capacityUnits: units });

  const result = await withIdempotency(db, {
    organizationId: input.principal.organizationId,
    scope: `slot:hold:${input.windowId}`,
    key: input.key,
    actorId: input.principal.userId,
    requestHash,
  }, async tx => {
    const [window] = await tx.select({ id: serviceWindows.id, feeKopeks: serviceWindows.feeKopeks })
      .from(serviceWindows)
      .innerJoin(buildings, eq(serviceWindows.buildingId, buildings.id))
      .where(and(
        eq(serviceWindows.id, input.windowId),
        eq(buildings.organizationId, input.principal.organizationId),
        eq(serviceWindows.status, "open"),
        gt(serviceWindows.endsAt, now),
      )).limit(1);
    if (!window) throw new AppError("WINDOW_NOT_FOUND");

    const inserted = await tx.insert(slotReservations).values({
      organizationId: input.principal.organizationId,
      windowId: input.windowId,
      orderId: input.orderId ?? null,
      quoteId: input.quoteId ?? null,
      principalId: input.principal.userId,
      capacityUnits: units,
      expiresAt,
      idempotencyKey: input.key,
      requestHash,
      state: "held",
    }).returning({ id: slotReservations.id });
    if (!inserted.length) throw new AppError("CAPACITY_UNAVAILABLE");

    const changed = await tx.update(serviceWindows).set({
      reservedOrders: sql`${serviceWindows.reservedOrders} + ${units}`,
      version: sql`${serviceWindows.version} + 1`,
    }).where(and(
      eq(serviceWindows.id, input.windowId),
      sql`${serviceWindows.capacityOrders} - ${serviceWindows.safetyBufferOrders} - ${serviceWindows.reservedOrders} >= ${units}`,
    )).returning({ id: serviceWindows.id });
    if (!changed.length) throw new AppError("CAPACITY_UNAVAILABLE");

    await appendEvent(tx, {
      principal: input.principal,
      aggregateType: "slot_reservation",
      aggregateId: inserted[0].id,
      eventType: "slot.held",
      payload: { windowId: input.windowId, capacityUnits: units, expiresAt: expiresAt.toISOString(), feeKopeks: window.feeKopeks },
    });
    return {
      reservationId: inserted[0].id,
      windowId: input.windowId,
      state: "held" as const,
      expiresAt: expiresAt.toISOString(),
    };
  });
  return { ...result.value, replayed: result.replayed };
}

export type HoldPairRequest = {
  principal: Principal;
  pickupWindowId: string;
  deliveryWindowId: string;
  key: string;
  expiresAt?: Date;
  ttlMinutes?: number;
  orderId?: string | null;
  quoteId?: string | null;
  capacityUnits?: number;
  releaseReservationIds?: string[];
  now?: Date;
};

export type HoldPairResult = {
  pickup: HoldResult;
  delivery: HoldResult;
  releasedReservationIds: string[];
  replayed?: boolean;
};

/**
 * Releases specific unattached `held` reservations inside an existing transaction.
 * Strictly scoped to the caller's tenant and (for customers) their own principalId.
 * Already-released/expired reservations are treated as idempotent no-ops; confirmed
 * reservations are never silently released here.
 */
export async function releaseHeldReservationsInTx(
  tx: Tx,
  input: {
    principal: Principal;
    reservationIds: string[];
    reason: string;
    ownerPrincipalId?: string;
  },
): Promise<string[]> {
  const uniqueIds = [...new Set(input.reservationIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];
  const isStaff = hasRole(input.principal, ...ROLE_GROUPS.dispatcher);
  const expectedPrincipalId = isStaff
    ? (input.ownerPrincipalId ?? null)
    : input.principal.userId;

  const rows = await tx.select().from(slotReservations).where(and(
    inArray(slotReservations.id, uniqueIds),
    eq(slotReservations.organizationId, input.principal.organizationId),
  )).for("update");

  // Reject if any requested reservation belongs to another tenant or does not exist
  // when explicitly targeted, or belongs to another principal for a customer caller.
  if (rows.length !== uniqueIds.length) {
    throw errors.notFound("reservation");
  }
  for (const row of rows) {
    if (expectedPrincipalId && row.principalId !== expectedPrincipalId) {
      throw errors.notFound("reservation");
    }
  }

  const releasedIds: string[] = [];
  // Lock/update windows in deterministic order to avoid deadlocks.
  const toRelease = rows
    .filter(row => row.state === "held" && row.orderId === null)
    .sort((a, b) => a.windowId.localeCompare(b.windowId) || a.id.localeCompare(b.id));

  for (const reservation of toRelease) {
    const changed = await tx.update(slotReservations).set({ state: "released" }).where(and(
      eq(slotReservations.id, reservation.id),
      eq(slotReservations.state, "held"),
      isNull(slotReservations.orderId),
    )).returning({ windowId: slotReservations.windowId, capacityUnits: slotReservations.capacityUnits });
    if (!changed.length) continue;

    const counter = await tx.update(serviceWindows).set({
      reservedOrders: sql`GREATEST(${serviceWindows.reservedOrders} - ${changed[0].capacityUnits}, 0)`,
      version: sql`${serviceWindows.version} + 1`,
    }).where(and(
      eq(serviceWindows.id, changed[0].windowId),
      gte(serviceWindows.reservedOrders, changed[0].capacityUnits),
    )).returning({ id: serviceWindows.id });
    if (!counter.length) throw new AppError("INVALID_TRANSITION", "CAPACITY_COUNTER_INCONSISTENT");

    await appendEvent(tx, {
      principal: input.principal,
      aggregateType: "slot_reservation",
      aggregateId: reservation.id,
      eventType: "slot.released",
      payload: { windowId: reservation.windowId, capacityUnits: changed[0].capacityUnits },
      reason: input.reason,
    });
    releasedIds.push(reservation.id);
  }
  return releasedIds;
}

/**
 * Atomically reserves both pickup and delivery windows in a single DB transaction.
 * If either leg fails (unavailable window, insufficient capacity, etc.) in either order,
 * the entire transaction rolls back so no orphan hold is ever left behind.
 * Replaying with the same idempotency key after a timeout returns the committed pair.
 */
export async function holdSlotPair(db: Db, input: HoldPairRequest): Promise<HoldPairResult> {
  assertRole(input.principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher, "system_worker");
  if (!input.principal.organizationId) throw errors.forbidden();
  if (!input.key?.trim() || input.key.length > 200) throw new AppError("VALIDATION_ERROR", "INVALID_IDEMPOTENCY_KEY");
  if (input.pickupWindowId === input.deliveryWindowId) {
    throw new AppError("VALIDATION_ERROR", "SAME_PICKUP_AND_DELIVERY_WINDOW");
  }
  const now = input.now ?? new Date();
  const units = input.capacityUnits ?? 1;
  if (!Number.isInteger(units) || units < 1) throw new AppError("VALIDATION_ERROR", "INVALID_CAPACITY_UNITS");
  const expiresAt = input.ttlMinutes !== undefined
    ? new Date(now.getTime() + input.ttlMinutes * 60_000)
    : input.expiresAt;
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new AppError("INVALID_EXPIRY");
  }
  const lifetime = input.ttlMinutes !== undefined
    ? { ttlMinutes: input.ttlMinutes }
    : { expiresAt: expiresAt.toISOString() };
  const releaseIds = [...new Set(input.releaseReservationIds ?? [])].sort();
  const requestHash = hashRequest({
    organizationId: input.principal.organizationId,
    principalId: input.principal.userId,
    pickupWindowId: input.pickupWindowId,
    deliveryWindowId: input.deliveryWindowId,
    key: input.key,
    ...lifetime,
    orderId: input.orderId ?? null,
    quoteId: input.quoteId ?? null,
    capacityUnits: units,
    releaseReservationIds: releaseIds,
  });

  const result = await withIdempotency(db, {
    organizationId: input.principal.organizationId,
    scope: "slot:hold:pair",
    key: input.key,
    actorId: input.principal.userId,
    requestHash,
  }, async tx => {
    const releasedReservationIds = releaseIds.length > 0
      ? await releaseHeldReservationsInTx(tx, {
        principal: input.principal,
        reservationIds: releaseIds,
        reason: "Replaced by paired slot hold",
      })
      : [];

    // Reserve in deterministic windowId order to prevent deadlocks under concurrent paired holds.
    const legs: Array<{ role: "pickup" | "delivery"; windowId: string }> = [
      { role: "pickup", windowId: input.pickupWindowId },
      { role: "delivery", windowId: input.deliveryWindowId },
    ];
    const orderedLegs = [...legs].sort((a, b) => a.windowId.localeCompare(b.windowId));

    const heldByRole: Partial<Record<"pickup" | "delivery", HoldResult>> = {};
    for (const leg of orderedLegs) {
      const [window] = await tx.select({
        id: serviceWindows.id,
        kind: serviceWindows.kind,
        feeKopeks: serviceWindows.feeKopeks,
      })
        .from(serviceWindows)
        .innerJoin(buildings, eq(serviceWindows.buildingId, buildings.id))
        .where(and(
          eq(serviceWindows.id, leg.windowId),
          eq(buildings.organizationId, input.principal.organizationId),
          eq(serviceWindows.kind, leg.role),
          eq(serviceWindows.status, "open"),
          gt(serviceWindows.endsAt, now),
        )).limit(1);
      if (!window) throw new AppError("WINDOW_NOT_FOUND");

      const inserted = await tx.insert(slotReservations).values({
        organizationId: input.principal.organizationId,
        windowId: leg.windowId,
        orderId: input.orderId ?? null,
        quoteId: input.quoteId ?? null,
        principalId: input.principal.userId,
        capacityUnits: units,
        expiresAt,
        idempotencyKey: `${input.key}:${leg.role}`,
        requestHash,
        state: "held",
      }).returning({ id: slotReservations.id });
      if (!inserted.length) throw new AppError("CAPACITY_UNAVAILABLE");

      const changed = await tx.update(serviceWindows).set({
        reservedOrders: sql`${serviceWindows.reservedOrders} + ${units}`,
        version: sql`${serviceWindows.version} + 1`,
      }).where(and(
        eq(serviceWindows.id, leg.windowId),
        sql`${serviceWindows.capacityOrders} - ${serviceWindows.safetyBufferOrders} - ${serviceWindows.reservedOrders} >= ${units}`,
      )).returning({ id: serviceWindows.id });
      if (!changed.length) throw new AppError("CAPACITY_UNAVAILABLE");

      await appendEvent(tx, {
        principal: input.principal,
        aggregateType: "slot_reservation",
        aggregateId: inserted[0].id,
        eventType: "slot.held",
        payload: { windowId: leg.windowId, capacityUnits: units, expiresAt: expiresAt.toISOString(), feeKopeks: window.feeKopeks },
      });

      heldByRole[leg.role] = {
        reservationId: inserted[0].id,
        windowId: leg.windowId,
        state: "held" as const,
        expiresAt: expiresAt.toISOString(),
      };
    }

    return {
      pickup: heldByRole.pickup!,
      delivery: heldByRole.delivery!,
      releasedReservationIds,
    };
  });

  return { ...result.value, replayed: result.replayed };
}

export type ConfirmResult = { reservationId: string; state: "confirmed"; replayed?: boolean };
export async function confirmSlot(
  db: Db,
  input: { principal: Principal; reservationId: string; key?: string; now?: Date },
): Promise<ConfirmResult> {
  assertRole(input.principal, ...ROLE_GROUPS.customer, ...ROLE_GROUPS.dispatcher, "system_worker");
  const now = input.now ?? new Date();
  const result = await withIdempotency(db, {
    organizationId: input.principal.organizationId,
    scope: "slot:confirm",
    key: input.key ?? input.reservationId,
    actorId: input.principal.userId,
    requestHash: hashRequest({ reservationId: input.reservationId, organizationId: input.principal.organizationId }),
  }, async tx => {
    const [reservation] = await tx.select().from(slotReservations).where(and(
      eq(slotReservations.id, input.reservationId),
      eq(slotReservations.organizationId, input.principal.organizationId),
    )).limit(1);
    if (!reservation) throw errors.notFound("reservation");

    if (reservation.state === "confirmed") {
      return { reservationId: reservation.id, state: "confirmed" as const };
    }
    if (reservation.state !== "held" || reservation.expiresAt <= now) {
      throw new AppError("INVALID_TRANSITION", "RESERVATION_NOT_CONFIRMABLE", { state: reservation.state });
    }
    const changed = await tx.update(slotReservations).set({ state: "confirmed" }).where(and(
      eq(slotReservations.id, reservation.id),
      eq(slotReservations.state, "held"),
      gt(slotReservations.expiresAt, now),
    )).returning({ id: slotReservations.id });
    if (!changed.length) throw new AppError("INVALID_TRANSITION", "RESERVATION_NOT_CONFIRMABLE");
    await appendEvent(tx, {
      principal: input.principal,
      aggregateType: "slot_reservation",
      aggregateId: reservation.id,
      eventType: "slot.confirmed",
      payload: { windowId: reservation.windowId, orderId: reservation.orderId },
    });
    return { reservationId: reservation.id, state: "confirmed" as const };
  });
  return { ...result.value, replayed: result.replayed };
}

async function terminate(
  db: Db,
  input: { principal: Principal; reservationId: string; reason: string; key?: string; now?: Date; heldOnly?: boolean },
  target: "released" | "expired",
) {
  const now = input.now ?? new Date();
  assertRole(input.principal, ...(target === "expired"
    ? ROLE_GROUPS.worker
    : [...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.partner, "customer" as const]));
  if (target === "released" && !input.reason?.trim()) throw new AppError("VALIDATION_ERROR", "REASON_REQUIRED");
  const result = await withIdempotency(db, {
    organizationId: input.principal.organizationId,
    scope: `slot:${target}`,
    key: input.key ?? input.reservationId,
    actorId: input.principal.userId,
    requestHash: hashRequest({ reservationId: input.reservationId, target, reason: input.reason, heldOnly: Boolean(input.heldOnly) }),
  }, async tx => {
    const [reservation] = await tx.select().from(slotReservations).where(and(
      eq(slotReservations.id, input.reservationId),
      eq(slotReservations.organizationId, input.principal.organizationId),
    )).limit(1);
    if (!reservation) throw errors.notFound("reservation");
    if (target === "released" && !hasRole(input.principal, ...ROLE_GROUPS.dispatcher)) {
      if (hasRole(input.principal, "customer") && reservation.principalId !== input.principal.userId) {
        throw errors.notFound("reservation");
      }
      if (hasRole(input.principal, ...ROLE_GROUPS.partner) && !hasRole(input.principal, "customer")) {
        if (!input.principal.partnerId || !reservation.orderId) throw errors.notFound("reservation");
        const [order] = await tx.select({ assignedPartnerId: orders.assignedPartnerId }).from(orders).where(and(
          eq(orders.id, reservation.orderId),
          eq(orders.organizationId, input.principal.organizationId),
        )).limit(1);
        if (!order || order.assignedPartnerId !== input.principal.partnerId) {
          throw errors.notFound("reservation");
        }
      }
    }
    if (reservation.state === target) return { reservationId: reservation.id, state: target, changed: false };
    if (target === "released" && input.heldOnly && (reservation.state !== "held" || reservation.orderId !== null)) {
      throw new AppError("INVALID_TRANSITION", "RESERVATION_NOT_TERMINABLE", { state: reservation.state });
    }
    const condition = target === "expired"
      ? and(eq(slotReservations.id, reservation.id), eq(slotReservations.state, "held"), lte(slotReservations.expiresAt, now))
      : input.heldOnly
        ? and(eq(slotReservations.id, reservation.id), eq(slotReservations.state, "held"), isNull(slotReservations.orderId))
        : and(eq(slotReservations.id, reservation.id), sql`${slotReservations.state} IN ('held','confirmed')`);
    const changed = await tx.update(slotReservations).set({ state: target }).where(condition)
      .returning({ windowId: slotReservations.windowId, capacityUnits: slotReservations.capacityUnits });
    if (!changed.length) {
      // A confirmed hold must never be released by TTL; the sweep treats it as a no-op.
      if (reservation.state === target || (target === "expired" && reservation.state === "confirmed")) {
        return { reservationId: reservation.id, state: reservation.state, changed: false };
      }
      throw new AppError("INVALID_TRANSITION", "RESERVATION_NOT_TERMINABLE", { state: reservation.state });
    }
    const counter = await tx.update(serviceWindows).set({
      reservedOrders: sql`GREATEST(${serviceWindows.reservedOrders} - ${changed[0].capacityUnits}, 0)`,
      version: sql`${serviceWindows.version} + 1`,
    }).where(and(eq(serviceWindows.id, changed[0].windowId), gte(serviceWindows.reservedOrders, changed[0].capacityUnits)))
      .returning({ id: serviceWindows.id });
    if (!counter.length) throw new AppError("INVALID_TRANSITION", "CAPACITY_COUNTER_INCONSISTENT");
    await appendEvent(tx, {
      principal: input.principal,
      aggregateType: "slot_reservation",
      aggregateId: reservation.id,
      eventType: target === "expired" ? "slot.expired" : "slot.released",
      payload: { windowId: reservation.windowId, capacityUnits: changed[0].capacityUnits },
      reason: input.reason,
    });
    return { reservationId: reservation.id, state: target, changed: true };
  });
  return { ...result.value, replayed: result.replayed };
}

export function releaseSlot(db: Db, input: { principal: Principal; reservationId: string; reason: string; key?: string; heldOnly?: boolean }) {
  return terminate(db, input, "released");
}
export function expireSlot(db: Db, input: { principal: Principal; reservationId: string; reason?: string; key?: string; now?: Date }) {
  return terminate(db, { ...input, reason: input.reason ?? "TTL expired" }, "expired");
}

export async function expireDueHolds(
  db: Db,
  input: { principal: Principal; now?: Date; limit?: number },
) {
  assertRole(input.principal, ...ROLE_GROUPS.worker);
  const now = input.now ?? new Date();
  const due = await db.select({ id: slotReservations.id }).from(slotReservations).where(and(
    eq(slotReservations.organizationId, input.principal.organizationId),
    eq(slotReservations.state, "held"),
    lte(slotReservations.expiresAt, now),
  )).limit(input.limit ?? 100);
  let expired = 0;
  for (const row of due) {
    try {
      const result = await expireSlot(db, { principal: input.principal, reservationId: row.id, now });
      if (result.changed) expired++;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // A concurrent confirm/win is expected; the sweep continues.
    }
  }
  return { scanned: due.length, expired };
}

export type CapacityMismatch = { windowId: string; stored: number; actual: number };
export async function reconcileCapacity(db: Db, organizationId: string): Promise<CapacityMismatch[]> {
  const rows = await db.execute(sql`
    SELECT w.id AS "windowId", w.reserved_orders AS stored,
           COALESCE(SUM(CASE WHEN r.state IN ('held','confirmed') THEN r.capacity_units ELSE 0 END), 0) AS actual
    FROM service_windows w
    LEFT JOIN slot_reservations r ON r.window_id = w.id
    WHERE w.organization_id = ${organizationId}
    GROUP BY w.id, w.reserved_orders, w.capacity_orders, w.safety_buffer_orders
    HAVING w.reserved_orders <> COALESCE(SUM(CASE WHEN r.state IN ('held','confirmed') THEN r.capacity_units ELSE 0 END), 0)
        OR w.reserved_orders > GREATEST(w.capacity_orders - w.safety_buffer_orders, 0)
  `);
  return (rows.rows as unknown as Array<{ windowId: string; stored: number; actual: number | string }>)
    .map(row => ({ windowId: row.windowId, stored: Number(row.stored), actual: Number(row.actual) }));
}

export async function repairCapacity(
  db: Db,
  input: { principal: Principal; windowId: string; reason: string },
) {
  assertRole(input.principal, "platform_admin");
  if (!input.reason?.trim()) throw new AppError("VALIDATION_ERROR", "REASON_REQUIRED");
  return db.transaction(async tx => {
    const [window] = await tx.select().from(serviceWindows).where(and(
      eq(serviceWindows.id, input.windowId),
      eq(serviceWindows.organizationId, input.principal.organizationId),
    )).limit(1);
    if (!window) throw errors.notFound("window");
    const [totals] = await tx.select({
      actual: sql<number>`COALESCE(SUM(${slotReservations.capacityUnits}), 0)`,
    }).from(slotReservations).where(and(
      eq(slotReservations.windowId, input.windowId),
      sql`${slotReservations.state} IN ('held','confirmed')`,
    ));
    const actual = Number(totals?.actual ?? 0);
    await tx.update(serviceWindows).set({
      reservedOrders: actual,
      version: sql`${serviceWindows.version} + 1`,
    }).where(eq(serviceWindows.id, window.id));
    await appendEvent(tx, {
      principal: input.principal,
      aggregateType: "service_window",
      aggregateId: window.id,
      eventType: "capacity.repaired",
      payload: { from: window.reservedOrders, to: actual },
      reason: input.reason,
    });
    return { windowId: window.id, from: window.reservedOrders, to: actual };
  });
}

export { isNull };
