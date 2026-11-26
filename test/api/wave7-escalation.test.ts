import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { orderEscalations, orders, outboxEvents, users } from "../../src/db/schema.js";
import { makePrincipal } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { createOrder } from "../../src/services/orders.js";
import { createQuote } from "../../src/services/quotes.js";
import { escalateOrder, listStuckOrders, resolveEscalation } from "../../src/services/escalation.js";
import { login, uniquePhone } from "./_fixtures.js";

const rid = () => randomUUID();

/**
 * Wave 7: an escalation for a stuck order.
 *
 * The audit found that no route anywhere let anybody escalate an order that got stuck: the
 * escalation was absent from every route, so a jammed order had no owner, no reason and no
 * allowed transition out of the jam. These tests pin the way out — the list of stuck orders,
 * the escalation with its reason, and the resolution that closes it.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 7: escalation for a stuck order", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  /**
   * Moves the order and its events into the past, so the order looks like it has been
   * standing still. The order table carries no `updated_at`, so the age of an order is the
   * age of its newest domain event — both have to be moved back.
   */
  async function makeIdle(orderId: string, minutes: number) {
    const at = new Date(Date.now() - minutes * 60_000);
    await db.update(orders).set({ createdAt: at }).where(eq(orders.id, orderId));
    await db.update(outboxEvents).set({ createdAt: at }).where(and(
      eq(outboxEvents.aggregateType, "order"),
      eq(outboxEvents.aggregateId, orderId),
    ));
  }

  /** A second order of the same tenant, created right now. */
  async function freshOrderOf(order: Awaited<ReturnType<typeof seedFullOrder>>) {
    const quote = await createQuote(db, order.principal, {
      buildingId: order.buildingId,
      pickupWindowId: order.windowId,
      deliveryWindowId: order.deliveryWindowId,
      tariffVersionId: order.catalog.tariffVersionId,
      key: `quote-${rid()}`,
      lines: [{ serviceId: order.catalog.serviceId, tier: "economy", quantity: 1_000, unit: "gram" }],
    });
    return createOrder(db, order.principal, {
      quoteId: quote.id,
      acceptedQuoteHash: quote.quoteHash,
      termsVersion: order.catalog.termsVersion,
      key: `order-${rid()}`,
    });
  }

  async function openEscalations(organizationId: string, orderId: string) {
    return db.select().from(orderEscalations).where(and(
      eq(orderEscalations.organizationId, organizationId),
      eq(orderEscalations.orderId, orderId),
      eq(orderEscalations.state, "open"),
    ));
  }

  it("shows an idle order in the stuck list and leaves a fresh one out", async () => {
    const order = await seedFullOrder(db);
    const dispatcher = order.dispatcher;
    await makeIdle(order.orderId, 120);
    const fresh = await freshOrderOf(order);
    await db.update(users).set({ displayName: "Иван Петров" }).where(eq(users.id, order.userId));

    const result = await listStuckOrders(db, dispatcher, { minutes: 30 });
    const ids = result.items.map(item => item.orderId);

    expect(ids).toContain(order.orderId);
    expect(ids).not.toContain(fresh.id);

    const idle = result.items.find(item => item.orderId === order.orderId);
    expect(idle?.idleMinutes).toBeGreaterThanOrEqual(30);
    expect(idle?.lifecycleState).not.toBe("delivered");
    // The customer is named, the phone number is not part of the projection.
    expect(idle?.customerName).toBe("Иван Петров");
    expect(JSON.stringify(idle)).not.toContain(order.phone);
  });

  it("escalates a stuck order: the escalation is created, the event is written and the order shows it", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);

    const result = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ на сортировочном хабе, фабрика не назначена",
      key: `escalate-${rid()}`,
    });

    expect(result.escalationId).toBeTruthy();
    expect(result.state).toBe("open");
    expect(result.created).toBe(true);

    const events = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateType, "order"),
      eq(outboxEvents.aggregateId, order.orderId),
      eq(outboxEvents.eventType, "order.escalated"),
    ));
    expect(events).toHaveLength(1);

    const list = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    const row = list.items.find(item => item.orderId === order.orderId);
    expect(row?.escalation?.id).toBe(result.escalationId);
    expect(row?.escalation?.reason).toContain("фабрика не назначена");
  });

  it("keeps one open escalation per order, and allows a new one after the old one is closed", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);

    const first = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ завис на хабе без фабрики",
      key: `escalate-${rid()}`,
    });
    const second = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Повторное обращение диспетчера",
      key: `escalate-${rid()}`,
    });

    // The second request does not open a second jam record — it points at the open one.
    expect(second.escalationId).toBe(first.escalationId);
    expect(second.created).toBe(false);
    expect(await openEscalations(order.organizationId, order.orderId)).toHaveLength(1);

    await resolveEscalation(db, order.dispatcher, {
      escalationId: first.escalationId,
      resolution: "Фабрика назначена, заказ передан в обработку",
      key: `resolve-${rid()}`,
    });

    const third = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ снова стоит без движения",
      key: `escalate-${rid()}`,
    });
    expect(third.escalationId).not.toBe(first.escalationId);
    expect(third.created).toBe(true);
    expect(await openEscalations(order.organizationId, order.orderId)).toHaveLength(1);
  });

  it("records the resolution, the resolver and the time, and the escalation leaves the open list", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);

    const escalated = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ не уходит в обработку",
      key: `escalate-${rid()}`,
    });

    const resolved = await resolveEscalation(db, order.dispatcher, {
      escalationId: escalated.escalationId,
      resolution: "Назначена фабрика, заказ передан",
      key: `resolve-${rid()}`,
    });
    expect(resolved.state).toBe("resolved");
    expect(resolved.resolvedAt).toBeTruthy();

    const [stored] = await db.select().from(orderEscalations)
      .where(eq(orderEscalations.id, escalated.escalationId)).limit(1);
    expect(stored.state).toBe("resolved");
    expect(stored.resolution).toBe("Назначена фабрика, заказ передан");
    expect(stored.resolvedBy).toBe(order.dispatcher.userId);
    expect(stored.resolvedAt).toBeInstanceOf(Date);

    const events = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateType, "order"),
      eq(outboxEvents.aggregateId, order.orderId),
      eq(outboxEvents.eventType, "order.escalation_resolved"),
    ));
    expect(events).toHaveLength(1);

    const list = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    const row = list.items.find(item => item.orderId === order.orderId);
    expect(row).toBeTruthy();
    // The escalation is closed, so the order is no longer flagged as escalated.
    expect(row?.escalation ?? null).toBeNull();
    expect(await openEscalations(order.organizationId, order.orderId)).toHaveLength(0);
  });

  it("replays a repeated escalate request instead of opening a second escalation", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);
    const key = `escalate-${rid()}`;

    const first = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ завис на хабе",
      key,
    });
    const second = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ завис на хабе",
      key,
    });

    expect(second.escalationId).toBe(first.escalationId);
    expect(second.replayed).toBe(true);
    expect(await openEscalations(order.organizationId, order.orderId)).toHaveLength(1);

    const events = await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.aggregateType, "order"),
      eq(outboxEvents.aggregateId, order.orderId),
      eq(outboxEvents.eventType, "order.escalated"),
    ));
    expect(events).toHaveLength(1);
  });

  it("refuses a reason and a resolution that explain nothing", async () => {
    const order = await seedFullOrder(db);
    await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ завис на хабе",
      key: `escalate-${rid()}`,
    });
    await expect(escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "  ",
      key: `escalate-${rid()}`,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps the courier out of the stuck list and out of the escalation", async () => {
    const order = await seedFullOrder(db);
    const courier = makePrincipal(order.organizationId, order.courierId, ["courier"]);

    await expect(listStuckOrders(db, courier, { minutes: 30 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(escalateOrder(db, courier, {
      orderId: order.orderId,
      reason: "Заказ завис на хабе",
      key: `escalate-${rid()}`,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(resolveEscalation(db, courier, {
      escalationId: randomUUID(),
      resolution: "Заказ передан",
      key: `resolve-${rid()}`,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("serves the routes to the dispatcher and refuses them to the courier", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);

    const dispatcherSession = await login(app, {
      organizationId: order.organizationId,
      phone: uniquePhone(),
      roles: ["dispatcher"],
    });
    expect(dispatcherSession.status).toBe(200);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ops/stuck-orders?minutes=30",
      headers: { cookie: dispatcherSession.cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<{ orderId: string; escalation: unknown }> };
    expect(body.items.some(item => item.orderId === order.orderId)).toBe(true);

    const escalated = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${order.orderId}/escalations`,
      headers: { cookie: dispatcherSession.cookie, "idempotency-key": `escalate-${rid()}` },
      payload: { reason: "Заказ на хабе без фабрики" },
    });
    expect(escalated.statusCode).toBe(200);
    const escalatedBody = escalated.json() as { escalationId: string; state: string };
    expect(escalatedBody.state).toBe("open");

    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/escalations/${escalatedBody.escalationId}/resolve`,
      headers: { cookie: dispatcherSession.cookie, "idempotency-key": `resolve-${rid()}` },
      payload: { resolution: "Фабрика назначена" },
    });
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as { state: string }).state).toBe("resolved");

    const courierSession = await login(app, {
      organizationId: order.organizationId,
      phone: uniquePhone(),
      roles: ["courier"],
    });
    expect(courierSession.status).toBe(200);

    const forbiddenList = await app.inject({
      method: "GET",
      url: "/api/v1/ops/stuck-orders?minutes=30",
      headers: { cookie: courierSession.cookie },
    });
    expect(forbiddenList.statusCode).toBe(403);

    const forbiddenEscalation = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${order.orderId}/escalations`,
      headers: { cookie: courierSession.cookie, "idempotency-key": `escalate-${rid()}` },
      payload: { reason: "Заказ на хабе без фабрики" },
    });
    expect(forbiddenEscalation.statusCode).toBe(403);
  });
});
