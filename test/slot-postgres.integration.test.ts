import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { serviceWindows, slotReservations } from "../src/db/schema.js";
import { confirmSlot, expireDueHolds, expireSlot, holdSlot, reconcileCapacity, releaseSlot, repairCapacity } from "../src/domain/slot-reservation.js";
import { makePrincipal, seedUser, seedWindow } from "./fixtures.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
describe.skipIf(!enabled)("PostgreSQL reservation integration (A01-A05)", () => {
  let db: Db;
  let close: () => Promise<void>;
  const now = new Date("2026-11-16T12:00:00.000Z");
  const expiry = new Date("2026-11-16T12:10:00.000Z");

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  it("A01: two competing clients for the last slot produce exactly one winner", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    const results = await Promise.allSettled([
      holdSlot(db, { principal, windowId: seed.windowId, key: "a", now, expiresAt: expiry }),
      holdSlot(db, { principal, windowId: seed.windowId, key: "b", now, expiresAt: expiry }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
    expect(window.reservedOrders).toBe(1);
    const rows = await db.select().from(slotReservations).where(eq(slotReservations.windowId, seed.windowId));
    expect(rows).toHaveLength(1);
  });

  it("A04: replay is idempotent, changed body conflicts, foreign tenant cannot see the window", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"], { deviceId: "device-1" });
    const body = { feeKopeks: 50_000, termsVersion: "v1" };
    const first = await holdSlot(db, { principal, windowId: seed.windowId, key: "same", now, expiresAt: expiry, body });
    const replay = await holdSlot(db, { principal, windowId: seed.windowId, key: "same", now, expiresAt: expiry, body });
    expect(replay.replayed).toBe(true);
    expect(replay.reservationId).toBe(first.reservationId);
    await expect(holdSlot(db, {
      principal, windowId: seed.windowId, key: "same", now, expiresAt: expiry, body: { ...body, feeKopeks: 1 },
    })).rejects.toThrow("IDEMPOTENCY_PAYLOAD_CONFLICT");
    const foreignSeed = await seedWindow(db, { capacity: 1 });
    const foreign = makePrincipal(foreignSeed.organizationId, foreignSeed.userId, ["customer"]);
    await expect(holdSlot(db, { principal: foreign, windowId: seed.windowId, key: "foreign", now, expiresAt: expiry }))
      .rejects.toThrow("NOT_FOUND");
    const [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
    expect(window.reservedOrders).toBe(1);
  });

  it("A03: cross-tenant confirm and release are denied without leaking the reservation", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const owner = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    const foreignSeed = await seedWindow(db, { capacity: 1 });
    const foreign = makePrincipal(foreignSeed.organizationId, foreignSeed.userId, ["customer"]);
    const hold = await holdSlot(db, { principal: owner, windowId: seed.windowId, key: "owned", now, expiresAt: expiry });
    await expect(confirmSlot(db, { principal: foreign, reservationId: hold.reservationId, now })).rejects.toThrow("NOT_FOUND");
    await expect(releaseSlot(db, { principal: foreign, reservationId: hold.reservationId, reason: "test" })).rejects.toThrow("NOT_FOUND");
    await expect(confirmSlot(db, { principal: owner, reservationId: hold.reservationId, now })).resolves.toMatchObject({ state: "confirmed" });
  });

  it("A05: expiration runs once, never touches confirmed holds, and capacity stays consistent", async () => {
    const seed = await seedWindow(db, { capacity: 2 });
    const owner = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    const worker = makePrincipal(seed.organizationId, await seedUser(db, seed.organizationId), ["system_worker"]);
    const held = await holdSlot(db, { principal: owner, windowId: seed.windowId, key: "held", now, expiresAt: expiry });
    const confirmed = await holdSlot(db, { principal: owner, windowId: seed.windowId, key: "confirmed", now, expiresAt: expiry });
    await confirmSlot(db, { principal: owner, reservationId: confirmed.reservationId, now });

    const swept = await expireDueHolds(db, { principal: worker, now: new Date("2026-11-16T12:11:00Z") });
    expect(swept.expired).toBe(1);
    expect(await expireSlot(db, { principal: worker, reservationId: held.reservationId, now: new Date("2026-11-16T12:11:00Z") }))
      .toMatchObject({ state: "expired" });
    expect(await expireSlot(db, { principal: worker, reservationId: confirmed.reservationId, now: new Date("2026-11-16T12:11:00Z") }))
      .toMatchObject({ changed: false });
    expect(await reconcileCapacity(db, seed.organizationId)).toEqual([]);
    const [window] = await db.select().from(serviceWindows).where(eq(serviceWindows.id, seed.windowId));
    expect(window.reservedOrders).toBe(1);
    expect(await releaseSlot(db, { principal: owner, reservationId: confirmed.reservationId, reason: "cancel" }))
      .toMatchObject({ changed: true });
    expect(await releaseSlot(db, { principal: owner, reservationId: confirmed.reservationId, reason: "cancel" }))
      .toMatchObject({ state: "released" });
  });

  it("confirm versus expire race produces a single terminal result", async () => {
    const seed = await seedWindow(db, { capacity: 1 });
    const owner = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    const worker = makePrincipal(seed.organizationId, await seedUser(db, seed.organizationId), ["system_worker"]);
    const hold = await holdSlot(db, { principal: owner, windowId: seed.windowId, key: "race", now, expiresAt: expiry });
    const results = await Promise.allSettled([
      confirmSlot(db, { principal: owner, reservationId: hold.reservationId, key: "race-confirm", now: new Date("2026-11-16T12:09:59Z") }),
      expireSlot(db, { principal: worker, reservationId: hold.reservationId, key: "race-expire", now: new Date("2026-11-16T12:10:01Z") }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await reconcileCapacity(db, seed.organizationId)).toEqual([]);
  });

  it("reconciliation detects and repairs a corrupted counter with an auditable reason", async () => {
    const seed = await seedWindow(db, { capacity: 3 });
    await db.update(serviceWindows).set({ reservedOrders: 2 }).where(eq(serviceWindows.id, seed.windowId));
    expect(await reconcileCapacity(db, seed.organizationId)).toEqual([{ windowId: seed.windowId, stored: 2, actual: 0 }]);
    const admin = makePrincipal(seed.organizationId, await seedUser(db, seed.organizationId), ["platform_admin"]);
    await expect(repairCapacity(db, { principal: admin, windowId: seed.windowId, reason: "drift after incident" }))
      .resolves.toMatchObject({ from: 2, to: 0 });
    expect(await reconcileCapacity(db, seed.organizationId)).toEqual([]);
  });

});
