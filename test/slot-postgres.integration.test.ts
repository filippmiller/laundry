import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { buildings, organizations, serviceWindows, slotReservations } from "../src/db/schema.js";
import { confirmSlot, expireSlot, holdSlot, releaseSlot } from "../src/domain/slot-reservation.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!enabled)("PostgreSQL reservation integration", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const db = drizzle(pool);
  let windowId: string;
  const now = new Date("2026-11-16T12:00:00.000Z");
  const expiry = new Date("2026-11-16T12:10:00.000Z");

  beforeAll(async () => {
    const [org] = await db.insert(organizations).values({ name: "Reservation integration" }).returning();
    const [building] = await db.insert(buildings).values({ organizationId: org.id, address: "Test 1" }).returning();
    const [window] = await db.insert(serviceWindows).values({
      buildingId: building.id, kind: "pickup",
      startsAt: new Date("2026-11-17T12:00:00.000Z"),
      endsAt: new Date("2026-11-17T13:00:00.000Z"),
      capacityOrders: 1,
    }).returning();
    windowId = window.id;
  });
  afterAll(async () => { await pool.end(); });

  it("allows exactly one winner for last slot", async () => {
    const results = await Promise.allSettled([
      holdSlot(db as any, { windowId, key: "competitor-a", now, expiresAt: expiry }),
      holdSlot(db as any, { windowId, key: "competitor-b", now, expiresAt: expiry }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, windowId));
    expect(window.reservedOrders).toBe(1);
    const rows = await db.select().from(slotReservations).where(eq(slotReservations.windowId, windowId));
    expect(rows).toHaveLength(1);
  });

  it("retries do not consume more capacity", async () => {
    const [existing] = await db.select().from(slotReservations).where(eq(slotReservations.windowId, windowId));
    const replay = await holdSlot(db as any, {
      windowId, key: existing.idempotencyKey, now, expiresAt: expiry,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.reservationId).toBe(existing.id);
    const [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, windowId));
    expect(window.reservedOrders).toBe(1);
  });

  it("expiration decrements once and cannot expire confirmed reservation", async () => {
    const [existing] = await db.select().from(slotReservations).where(eq(slotReservations.windowId, windowId));
    expect(await expireSlot(db as any, existing.id, new Date("2026-11-16T12:11:00Z"))).toBe(true);
    expect(await expireSlot(db as any, existing.id, new Date("2026-11-16T12:11:00Z"))).toBe(false);
    let [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, windowId));
    expect(window.reservedOrders).toBe(0);
    const next = await holdSlot(db as any, { windowId, key: "confirmed", now, expiresAt: expiry });
    expect(await confirmSlot(db as any, next.reservationId, now)).toBe("confirmed");
    expect(await expireSlot(db as any, next.reservationId, new Date("2026-11-16T12:11:00Z"))).toBe(false);
    expect(await releaseSlot(db as any, next.reservationId)).toBe(true);
    expect(await releaseSlot(db as any, next.reservationId)).toBe(false);
    [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, windowId));
    expect(window.reservedOrders).toBe(0);
  });
});
