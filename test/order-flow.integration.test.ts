import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { makePrincipal, seedAddress, seedCatalog, seedDeliveryWindow, seedWindow } from "./fixtures.js";
import { createQuote, getQuote } from "../src/services/quotes.js";
import { createOrder, getOrderTimeline, loadOrder, scheduleOrder, transitionOrder } from "../src/services/orders.js";
import { holdSlot } from "../src/domain/slot-reservation.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("Slice B: quote to scheduled order", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  async function fixture(capacity = 2) {
    const seed = await seedWindow(db, { capacity });
    const deliveryWindowId = await seedDeliveryWindow(db, seed);
    const catalog = await seedCatalog(db, seed.organizationId);
    await seedAddress(db, seed.organizationId, seed.userId, seed.buildingId);
    const principal = makePrincipal(seed.organizationId, seed.userId, ["customer"]);
    return { ...seed, deliveryWindowId, catalog, principal };
  }

  function quoteInput(f: Awaited<ReturnType<typeof fixture>>, key = "quote-1") {
    return {
      buildingId: f.buildingId,
      pickupWindowId: f.windowId,
      deliveryWindowId: f.deliveryWindowId,
      tariffVersionId: f.catalog.tariffVersionId,
      key,
      lines: [{ serviceId: f.catalog.serviceId, tier: "economy" as const, quantity: 2_150, unit: "gram" as const }],
    };
  }

  it("B01: a shared building quote has zero pickup/delivery fees and becomes a confirmed order", async () => {
    const f = await fixture();
    const quote = await createQuote(db, f.principal, quoteInput(f));
    expect(quote.totalKopeks).toBe(220);
    expect(quote.lines.filter(line => line.kind.endsWith("_fee")).every(line => line.amountKopeks === 0)).toBe(true);

    const order = await createOrder(db, f.principal, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: f.catalog.termsVersion,
      key: "order-1",
    });
    expect(order.state).toBe("confirmed");
    const stored = await loadOrder(db, f.principal, order.id);
    expect(stored.lifecycleState).toBe("confirmed");
    expect((await getOrderTimeline(db, f.principal, order.id)).length).toBeGreaterThan(0);

    const hold = await holdSlot(db, {
      principal: f.principal, windowId: f.windowId, key: "pickup-hold",
      expiresAt: new Date("2026-11-16T12:10:00Z"), now: new Date("2026-11-16T12:00:00Z"),
    });
    const deliveryHold = await holdSlot(db, {
      principal: f.principal, windowId: f.deliveryWindowId, key: "delivery-hold",
      expiresAt: new Date("2026-11-16T12:10:00Z"), now: new Date("2026-11-16T12:00:00Z"),
    });
    await expect(scheduleOrder(db, f.principal, {
      orderId: order.id, pickupReservationId: hold.reservationId,
      deliveryReservationId: deliveryHold.reservationId, key: "schedule-1",
      now: new Date("2026-11-16T12:00:00Z"),
    })).resolves.toMatchObject({ state: "scheduled" });
    expect((await loadOrder(db, f.principal, order.id)).lifecycleState).toBe("scheduled");
  });

  it("B02: off-schedule windows produce two explicit 500 RUB lines and one total", async () => {
    const f = await fixture();
    const quote = await createQuote(db, f.principal, {
      ...quoteInput(f), offSchedulePickup: true, offScheduleDelivery: true, key: "quote-exceptions",
    });
    const fees = quote.lines.filter(line => line.kind.endsWith("_fee"));
    expect(fees.map(line => line.amountKopeks)).toEqual([50_000, 50_000]);
    expect(quote.totalKopeks).toBe(100_220);
  });

  it("A02/A02: stale quote and mismatched hash are rejected before an order exists", async () => {
    const f = await fixture();
    const quote = await createQuote(db, f.principal, quoteInput(f, "quote-stale"));
    await expect(createOrder(db, f.principal, {
      quoteId: quote.id, acceptedQuoteHash: "wrong", termsVersion: f.catalog.termsVersion, key: "order-bad-hash",
    })).rejects.toThrow("QUOTE_HASH_MISMATCH");
    await expect(createOrder(db, f.principal, {
      quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: f.catalog.termsVersion,
      key: "order-stale", now: new Date("2026-12-31T00:00:00Z"),
    })).rejects.toThrow("QUOTE_EXPIRED");
  });

  it("A03: a foreign tenant cannot read a quote or order", async () => {
    const f = await fixture();
    const other = await seedWindow(db, { capacity: 1 });
    const foreign = makePrincipal(other.organizationId, other.userId, ["customer"]);
    const quote = await createQuote(db, f.principal, quoteInput(f, "quote-foreign"));
    await expect(getQuote(db, foreign, quote.id)).rejects.toThrow("NOT_FOUND");
    const order = await createOrder(db, f.principal, {
      quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: f.catalog.termsVersion, key: "order-foreign",
    });
    await expect(loadOrder(db, foreign, order.id)).rejects.toThrow("NOT_FOUND");
  });

  it("idempotent order creation does not duplicate lines", async () => {
    const f = await fixture();
    const quote = await createQuote(db, f.principal, quoteInput(f, "quote-idem"));
    const input = {
      quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: f.catalog.termsVersion, key: "order-idem",
    };
    const first = await createOrder(db, f.principal, input);
    const second = await createOrder(db, f.principal, input);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    await expect(createOrder(db, f.principal, { ...input, acceptedQuoteHash: "changed" })).rejects.toThrow("IDEMPOTENCY_PAYLOAD_CONFLICT");
  });

  it("role-bound order transition rejects a customer dispatcher-only command", async () => {
    const f = await fixture();
    const quote = await createQuote(db, f.principal, quoteInput(f, "quote-roles"));
    const order = await createOrder(db, f.principal, {
      quoteId: quote.id, acceptedQuoteHash: quote.quoteHash, termsVersion: f.catalog.termsVersion, key: "order-roles",
    });
    const hold = await holdSlot(db, {
      principal: f.principal, windowId: f.windowId, key: "roles-hold",
      expiresAt: new Date("2026-11-16T12:10:00Z"), now: new Date("2026-11-16T12:00:00Z"),
    });
    const deliveryHold = await holdSlot(db, {
      principal: f.principal, windowId: f.deliveryWindowId, key: "roles-delivery-hold",
      expiresAt: new Date("2026-11-16T12:10:00Z"), now: new Date("2026-11-16T12:00:00Z"),
    });
    await scheduleOrder(db, f.principal, {
      orderId: order.id, pickupReservationId: hold.reservationId,
      deliveryReservationId: deliveryHold.reservationId, key: "roles-schedule",
      now: new Date("2026-11-16T12:00:00Z"),
    });
    await expect(transitionOrder(db, f.principal, {
      orderId: order.id, command: "assign_pickup", key: "bad-role",
    })).rejects.toThrow("FORBIDDEN");
  });
});
