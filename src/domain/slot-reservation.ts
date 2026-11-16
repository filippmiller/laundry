import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { buildings, slotReservations, serviceWindows } from "../db/schema.js";

export type ReservationDb = { transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> };
export type HoldRequest = {
  organizationId: string;
  windowId: string;
  key: string;
  expiresAt: Date;
  now?: Date;
};
export class CapacityUnavailable extends Error {
  constructor() { super("CAPACITY_UNAVAILABLE"); }
}
function fingerprint(input: HoldRequest) {
  return createHash("sha256").update(JSON.stringify({
    organizationId: input.organizationId,
    windowId: input.windowId,
    expiresAt: input.expiresAt.toISOString(),
  })).digest("hex");
}
export async function holdSlot(db: ReservationDb, input: HoldRequest) {
  if (!input.organizationId) throw new Error("ORGANIZATION_REQUIRED");
  if (!input.key?.trim() || input.key.length > 200) throw new Error("INVALID_IDEMPOTENCY_KEY");
  const now = input.now ?? new Date();
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now) {
    throw new Error("INVALID_EXPIRY");
  }
  const requestHash = fingerprint(input);
  return db.transaction(async tx => {
    // Check ownership inside transaction; the client cannot supply another tenant's window.
    const owned = await tx.select({ id: serviceWindows.id }).from(serviceWindows)
      .innerJoin(buildings, eq(serviceWindows.buildingId, buildings.id))
      .where(and(eq(serviceWindows.id, input.windowId), eq(buildings.organizationId, input.organizationId)))
      .limit(1);
    if (!owned.length) throw new Error("WINDOW_NOT_FOUND");
    const inserted = await tx.insert(slotReservations).values({
      windowId: input.windowId, idempotencyKey: input.key,
      requestHash, expiresAt: input.expiresAt, state: "held",
    }).onConflictDoNothing().returning({ id: slotReservations.id });
    if (!inserted.length) {
      const rows = await tx.select().from(slotReservations).where(and(
        eq(slotReservations.windowId, input.windowId), eq(slotReservations.idempotencyKey, input.key),
      )).limit(1);
      if (!rows.length) throw new Error("RETRY_CONFLICT");
      if (rows[0].requestHash !== requestHash) throw new Error("IDEMPOTENCY_PAYLOAD_CONFLICT");
      return { reservationId: rows[0].id, state: rows[0].state, replayed: true };
    }
    const changed = await tx.update(serviceWindows).set({
      reservedOrders: sql`${serviceWindows.reservedOrders} + 1`,
      version: sql`${serviceWindows.version} + 1`,
    }).where(and(
      eq(serviceWindows.id, input.windowId),
      gt(serviceWindows.capacityOrders, serviceWindows.reservedOrders),
      gt(serviceWindows.endsAt, now),
    )).returning({ id: serviceWindows.id });
    if (!changed.length) throw new CapacityUnavailable();
    return { reservationId: inserted[0].id, state: "held" as const, replayed: false };
  });
}
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
async function terminate(db: ReservationDb, reservationId: string, target: "released" | "expired", now: Date) {
  return db.transaction(async tx => {
    const condition = target === "expired"
      ? and(eq(slotReservations.id, reservationId), eq(slotReservations.state, "held"), sql`${slotReservations.expiresAt} <= ${now}`)
      : and(eq(slotReservations.id, reservationId), sql`${slotReservations.state} IN ('held','confirmed')`);
    const changed = await tx.update(slotReservations).set({ state: target }).where(condition)
      .returning({ windowId: slotReservations.windowId });
    if (!changed.length) return false;
    const counter = await tx.update(serviceWindows).set({
      reservedOrders: sql`${serviceWindows.reservedOrders} - 1`,
      version: sql`${serviceWindows.version} + 1`,
    }).where(and(eq(serviceWindows.id, changed[0].windowId), gt(serviceWindows.reservedOrders, 0)))
      .returning({ id: serviceWindows.id });
    if (!counter.length) throw new Error("CAPACITY_COUNTER_INCONSISTENT"); // rollback reservation state
    return true;
  });
}
/** Only call after authorization of cancellation and refund policy. */
export function releaseSlot(db: ReservationDb, reservationId: string) {
  return terminate(db, reservationId, "released", new Date());
}
export function expireSlot(db: ReservationDb, reservationId: string, now = new Date()) {
  return terminate(db, reservationId, "expired", now);
}
