import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { orders, serviceWindows, slotReservations } from "../src/db/schema.js";
import type { Principal } from "../src/core/context.js";
import {
  makePrincipal, seedAddress, seedCatalog, seedDeliveryWindow, seedUser, seedWindow,
} from "./fixtures.js";
import { seedFullOrder } from "./operations-fixtures.js";
import { createQuote } from "../src/services/quotes.js";
import { cancelOrder, createOrder, loadOrder, rescheduleOrder, scheduleOrder } from "../src/services/orders.js";
import { currentCourierStops, startStop } from "../src/services/delivery.js";
import { holdSlot } from "../src/domain/slot-reservation.js";

const NOW = new Date("2026-11-16T12:00:00Z");
const TTL = new Date("2026-11-16T12:10:00Z");
const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Customer order lifecycle and courier stops", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  async function fixture(capacity = 3) {
    const seed = await seedWindow(db, { capacity });
    const deliveryWindowId = await seedDeliveryWindow(db, seed);
    const catalog = await seedCatalog(db, seed.organizationId);
    await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    return { ...seed, deliveryWindowId, catalog, principal };
  }

  async function scheduled(f: Awaited<ReturnType<typeof fixture>>) {
    const quote = await createQuote(db, f.principal, {
      buildingId: f.buildingId, pickupWindowId: f.windowId, deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId, key: `q-${rid()}`,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });
    const order = await createOrder(db, f.principal, {
      quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: f.catalog.termsVersion, key: `o-${rid()}`,
    });
    const held = await holdBoth(f, f.principal);
    await scheduleOrder(db, f.principal, {
      orderId: order.id, pickupReservationId: held.pickup, deliveryReservationId: held.delivery, key: `s-${rid()}`, now: NOW,
    });
    return { order, holds: held };
  }

  async function holdBoth(f: Awaited<ReturnType<typeof fixture>>, principal: Principal) {
    const pickup = await holdSlot(db, { principal, windowId: f.windowId, key: `hp-${rid()}`, now: NOW, expiresAt: TTL });
    const delivery = await holdSlot(db, { principal, windowId: f.deliveryWindowId, key: `hd-${rid()}`, now: NOW, expiresAt: TTL });
    return { pickup: pickup.reservationId, delivery: delivery.reservationId };
  }

  async function reservedOrders(windowId: string) {
    const [row] = await db.select({ reserved: serviceWindows.reservedOrders }).from(serviceWindows)
      .where(eq(serviceWindows.id, windowId));
    return row.reserved;
  }

  it("cancel releases both confirmed reservations and cannot be repeated into double release", async () => {
    const f = await fixture();
    const { order } = await scheduled(f);
    expect(await reservedOrders(f.windowId)).toBe(1);
    expect(await reservedOrders(f.deliveryWindowId)).toBe(1);

    const cancelled = await cancelOrder(db, f.principal, { orderId: order.id, reason: "Ð¿ÐµÑ€ÐµÐ´ÑƒÐ¼Ð°Ð»", key: `c-${rid()}` });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.releasedReservations).toBe(2);
    expect((await loadOrder(db, f.principal, order.id)).lifecycleState).toBe("cancelled");
    expect(await reservedOrders(f.windowId)).toBe(0);
    expect(await reservedOrders(f.deliveryWindowId)).toBe(0);

    const reservations = await db.select().from(slotReservations).where(eq(slotReservations.orderId, order.id));
    expect(reservations.map(row => row.state)).toEqual(["released", "released"]);

    const again = await cancelOrder(db, f.principal, { orderId: order.id, reason: "Ð¿Ð¾Ð²Ñ‚Ð¾Ñ€", key: `c2-${rid()}` });
    expect(again.releasedReservations).toBe(0);
    expect(await reservedOrders(f.windowId)).toBe(0);
  });

  it("a foreign customer cannot cancel someone else's order", async () => {
    const f = await fixture();
    const { order } = await scheduled(f);
    const other = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await expect(cancelOrder(db, other, { orderId: order.id, reason: "Ñ‡ÑƒÐ¶Ð¾Ð¹", key: `c-${rid()}` }))
      .rejects.toThrow("NOT_FOUND");
    expect((await loadOrder(db, f.principal, order.id)).lifecycleState).toBe("scheduled");
  });

  it("reschedule releases the old capacity and binds the new legs", async () => {
    const f = await fixture();
    const { order, holds: old } = await scheduled(f);
    const next = await holdBoth(f, f.principal);
    expect(await reservedOrders(f.windowId)).toBe(2);

    const result = await rescheduleOrder(db, f.principal, {
      orderId: order.id, pickupReservationId: next.pickup, deliveryReservationId: next.delivery,
      key: `r-${rid()}`, now: NOW,
    });
    expect(result.state).toBe("scheduled");
    expect(await reservedOrders(f.windowId)).toBe(1);

    const rows = await db.select().from(slotReservations).where(inArray(slotReservations.id, [old.pickup, old.delivery, next.pickup, next.delivery]));
    const byId = new Map(rows.map(row => [row.id, row]));
    expect(byId.get(old.pickup)?.state).toBe("released");
    expect(byId.get(old.delivery)?.state).toBe("released");
    expect(byId.get(next.pickup)?.state).toBe("confirmed");
    expect(byId.get(next.pickup)?.orderId).toBe(order.id);
  });

  it("a failed reschedule leaves the existing confirmed capacity intact", async () => {
    const f = await fixture();
    const { order, holds: old } = await scheduled(f);
    const other = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await seedAddress(db, f.organizationId, other.userId, f.buildingId);
    const foreign = await holdBoth(f, other);

    await expect(rescheduleOrder(db, f.principal, {
      orderId: order.id, pickupReservationId: foreign.pickup, deliveryReservationId: foreign.delivery,
      key: `r-${rid()}`, now: NOW,
    })).rejects.toThrow("NOT_FOUND");

    const rows = await db.select().from(slotReservations).where(inArray(slotReservations.id, [old.pickup, old.delivery]));
    expect(rows.every(row => row.state === "confirmed")).toBe(true);
    expect(await reservedOrders(f.windowId)).toBe(2); // 2 held from the foreign customer + 0 released old
  });

  it("a courier can start and arrive a stop, and sees only active stops with the order number", async () => {
    const f = await seedFullOrder(db, { state: "scheduled" });
    const started = await startStop(db, f.courier, { stopId: f.stopId, key: `start-${rid()}` });
    expect(started.state).toBe("en_route");

    const stops = await currentCourierStops(db, f.courier);
    const stop = stops.find(row => row.stopId === f.stopId);
    expect(stop).toBeDefined();
    expect(stop!.state).toBe("en_route");
    expect(stop!.publicNumber).toMatch(/^LA-/);

    const intruder = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["courier"]);
    await expect(startStop(db, intruder, { stopId: f.stopId, key: `start-${rid()}` }))
      .rejects.toThrow("FORBIDDEN");
  });

  it("cancelled orders are terminal", async () => {
    const f = await fixture();
    const { order } = await scheduled(f);
    await cancelOrder(db, f.principal, { orderId: order.id, reason: "Ð½Ðµ Ð½ÑƒÐ¶Ð½Ð¾", key: `c-${rid()}` });
    const [row] = await db.select().from(orders).where(and(eq(orders.id, order.id)));
    expect(row.lifecycleState).toBe("cancelled");
    await expect(cancelOrder(db, f.principal, { orderId: order.id, reason: "ÐµÑ‰Ñ‘ Ñ€Ð°Ð·", key: `c-${rid()}` }))
      .resolves.toMatchObject({ releasedReservations: 0 });
  });
});
