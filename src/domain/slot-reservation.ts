import { and, eq, gt, sql } from "drizzle-orm";
import { slotReservations, serviceWindows } from "../db/schema.js";

export type ReservationDb = {
  transaction<T>(fn: (tx: ReservationTx) => Promise<T>): Promise<T>;
};
export type ReservationTx = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
};
export type HoldRequest = {
  windowId: string;
  key: string;
  expiresAt: Date;
  now?: Date;
};

export class CapacityUnavailable extends Error {
  constructor() { super("CAPACITY_UNAVAILABLE"); }
}

/**
 * Atomically reserves one order capacity unit. Callers must scope the
 * window to the authenticated tenant BEFORE invoking this function.
 *
 * This command is safe for concurrent callers because the UPDATE
 * conditionally increments the window counter in PostgreSQL.
 */
export async function holdSlot(db: ReservationDb, input: HoldRequest) {
  if (!input.key.trim() || input.key.length > 200) throw new Error("INVALID_IDEMPOTENCY_KEY");
  const now = input.now ?? new Date();
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now) {
    throw new Error("INVALID_EXPIRY");
  }
  return db.transaction(async tx => {
    // The unique (window_id, idempotency_key) index serializes retries.
    // Insert-first avoids consuming capacity on an existing key.
    const inserted = await tx.insert(slotReservations).values({
      windowId: input.windowId,
      idempotencyKey: input.key,
      expiresAt: input.expiresAt,
      state: "held",
    }).onConflictDoNothing().returning({ id: slotReservations.id });

    if (inserted.length === 0) {
      const existing = await tx.select().from(slotReservations).where(and(
        eq(slotReservations.windowId, input.windowId),
        eq(slotReservations.idempotencyKey, input.key),
      )).limit(1);
      if (!existing.length) throw new Error("RETRY_CONFLICT");
      return { reservationId: existing[0].id, state: existing[0].state, replayed: true };
    }

    const changed = await tx.update(serviceWindows).set({
      reservedOrders: sql`${serviceWindows.reservedOrders} + 1`,
      version: sql`${serviceWindows.version} + 1`,
    }).where(and(
      eq(serviceWindows.id, input.windowId),
      gt(serviceWindows.capacityOrders, serviceWindows.reservedOrders),
      gt(serviceWindows.endsAt, now),
    )).returning({ id: serviceWindows.id });
    if (!changed.length) throw new CapacityUnavailable(); // rollback insert
    return { reservationId: inserted[0].id, state: "held" as const, replayed: false };
  });
}

/** Confirm only a nonexpired hold; expiry worker must not touch confirmed rows. */
export async function confirmSlot(db: ReservationDb, reservationId: string, now = new Date()) {
  return db.transaction(async tx => {
    const changed = await tx.update(slotReservations).set({ state: "confirmed" })
      .where(and(eq(slotReservations.id, reservationId), eq(slotReservations.state, "held"), gt(slotReservations.expiresAt, now)))
      .returning({ id: slotReservations.id });
    if (changed.length) return "confirmed" as const;
    const rows = await tx.select().from(slotReservations).where(eq(slotReservations.id, reservationId)).limit(1);
    if (rows[0]?.state === "confirmed") return "confirmed" as const;
    throw new Error("RESERVATION_NOT_CONFIRMABLE");
  });
}

/**
 * Release a held/confirmed reservation exactly once. For a confirmed
 * reservation, caller must first validate cancellation/refund policy.
 */
export async function releaseSlot(db: ReservationDb, reservationId: string) {
  return db.transaction(async tx => {
    const rows = await tx.update(slotReservations).set({ state: "released" })
      .where(and(eq(slotReservations.id, reservationId), sql`${slotReservations.state} IN ('held','confirmed')`))
      .returning({ windowId: slotReservations.windowId });
    if (!rows.length) return false;
    await tx.update(serviceWindows).set({
      reservedOrders: sql`${serviceWindows.reservedOrders} - 1`,
      version: sql`${serviceWindows.version} + 1`,
    }).where(and(eq(serviceWindows.id, rows[0].windowId), gt(serviceWindows.reservedOrders, 0)));
    return true;
  });
}

/** Expire a single hold with compare-and-swap; safe under repeated workers. */
export async function expireSlot(db: ReservationDb, reservationId: string, now = new Date()) {
  return db.transaction(async tx => {
    const rows = await tx.update(slotReservations).set({ state: "expired" })
      .where(and(eq(slotReservations.id, reservationId), eq(slotReservations.state, "held"), sql`${slotReservations.expiresAt} <= ${now}`))
      .returning({ windowId: slotReservations.windowId });
    if (!rows.length) return false;
    await tx.update(serviceWindows).set({
      reservedOrders: sql`${serviceWindows.reservedOrders} - 1`,
      version: sql`${serviceWindows.version} + 1`,
    }).where(and(eq(serviceWindows.id, rows[0].windowId), gt(serviceWindows.reservedOrders, 0)));
    return true;
  });
}
