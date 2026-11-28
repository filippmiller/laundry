import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { orderEscalations, orders, outboxEvents, users } from "../../src/db/schema.js";
import { escalateOrder, listStuckOrders, resolveEscalation } from "../../src/services/escalation.js";
import { cancelOrder, createOrder } from "../../src/services/orders.js";
import { createQuote } from "../../src/services/quotes.js";
import { seedFullOrder, seedPartnerForOrder } from "../operations-fixtures.js";
import { login, uniquePhone } from "./_fixtures.js";

const rid = () => randomUUID();

/**
 * Wave 8: an open escalation must keep its way to be closed.
 *
 * The re-audit found that the escalation queue was the idle queue: as soon as the order moved
 * (a factory was assigned) or finished, the order left the list and the open escalation with
 * it — the case could not be closed any more, because the panel could only close an escalation
 * it had received from that list. The queue of open escalations is now apart from the queue of
 * idle orders, and the escalation always names the person responsible for it.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 8: an open escalation keeps its way to be closed", () => {
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

  /** A second order of the same tenant. */
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

  /** The open escalations of the order in the database. */
  async function openEscalations(organizationId: string, orderId: string) {
    return db.select().from(orderEscalations).where(and(
      eq(orderEscalations.organizationId, organizationId),
      eq(orderEscalations.orderId, orderId),
      eq(orderEscalations.state, "open"),
    ));
  }

  it("keeps an open escalation reachable after the order moved on, and closes it explicitly", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);

    const escalated = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ на сортировочном хабе, фабрика не назначена",
      key: `escalate-${rid()}`,
    });

    // The order moves: a factory is assigned, so the order is not idle any more.
    await seedPartnerForOrder(db, order);

    const list = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    // The idle queue forgets the order...
    expect(list.items.map(item => item.orderId)).not.toContain(order.orderId);
    // ...but the open escalation is still there, with the way to close it.
    const open = list.escalations.find(item => item.id === escalated.escalationId);
    expect(open).toBeTruthy();
    expect(open?.orderId).toBe(order.orderId);
    expect(open?.reason).toContain("фабрика не назначена");

    // The same is true of the route the panel reads.
    const dispatcherSession = await login(app, {
      organizationId: order.organizationId,
      phone: uniquePhone(),
      roles: ["dispatcher"],
    });
    expect(dispatcherSession.status).toBe(200);
    const route = await app.inject({
      method: "GET",
      url: "/api/v1/ops/stuck-orders?minutes=30",
      headers: { cookie: dispatcherSession.cookie },
    });
    expect(route.statusCode).toBe(200);
    const body = route.json() as { items: Array<{ orderId: string }>; escalations: Array<{ id: string }> };
    expect(body.items.some(item => item.orderId === order.orderId)).toBe(false);
    expect(body.escalations.some(item => item.id === escalated.escalationId)).toBe(true);

    const closed = await resolveEscalation(db, order.dispatcher, {
      escalationId: escalated.escalationId,
      resolution: "Фабрика назначена, заказ передан в обработку",
      key: `resolve-${rid()}`,
    });
    expect(closed.state).toBe("resolved");

    const after = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    expect(after.escalations.map(item => item.id)).not.toContain(escalated.escalationId);
  });

  it("keeps an open escalation of a terminal order reachable and closable", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);

    const escalated = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ завис на хабе, ответа от фабрики нет",
      key: `escalate-${rid()}`,
    });

    // The order is finished: a finished order is not stuck, but the case is still open.
    await cancelOrder(db, order.principal, {
      orderId: order.orderId,
      reason: "Клиент отказался от заказа",
      key: `cancel-${rid()}`,
    });
    const [row] = await db.select({ lifecycleState: orders.lifecycleState }).from(orders)
      .where(eq(orders.id, order.orderId)).limit(1);
    expect(row?.lifecycleState).toBe("cancelled");

    const list = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    expect(list.items.map(item => item.orderId)).not.toContain(order.orderId);
    const open = list.escalations.find(item => item.id === escalated.escalationId);
    expect(open).toBeTruthy();
    expect(open?.lifecycleState).toBe("cancelled");

    const closed = await resolveEscalation(db, order.dispatcher, {
      escalationId: escalated.escalationId,
      resolution: "Заказ отменён клиентом, эскалация закрыта",
      key: `resolve-${rid()}`,
    });
    expect(closed.state).toBe("resolved");
    expect(await openEscalations(order.organizationId, order.orderId)).toHaveLength(0);
  });

  it("the idle list still leaves out terminal and recently moved orders", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 120);

    const moving = await freshOrderOf(order);
    await makeIdle(moving.id, 120);
    const terminal = await freshOrderOf(order);
    await makeIdle(terminal.id, 120);

    // All three orders look idle at first.
    const before = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    expect(before.items.map(item => item.orderId).sort()).toEqual(
      [order.orderId, moving.id, terminal.id].sort(),
    );

    // One moves (a factory is assigned), the other is finished.
    await seedPartnerForOrder(db, {
      orderId: moving.id,
      organizationId: order.organizationId,
      dispatcher: order.dispatcher,
    });
    await cancelOrder(db, order.principal, {
      orderId: terminal.id,
      reason: "Клиент отказался от заказа",
      key: `cancel-${rid()}`,
    });

    const after = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    // The idle list did not become a list of everything: only the order that still stands
    // still is in it, and no escalation was opened, so the escalation queue is empty too.
    expect(after.items.map(item => item.orderId)).toEqual([order.orderId]);
    expect(after.escalations).toEqual([]);
  });

  it("names the responsible person: the author of the escalation owns the jam", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);
    await db.update(users).set({ displayName: "Иван Петров" }).where(eq(users.id, order.dispatcher.userId));

    const escalated = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ на сортировочном хабе, фабрика не назначена",
      key: `escalate-${rid()}`,
    });

    // The author is the responsible person: the escalation always names somebody.
    expect(escalated.assigneeId).toBe(order.dispatcher.userId);
    expect(escalated.assigneeName).toBe("Иван Петров");
    expect(escalated.escalatedBy).toBe(order.dispatcher.userId);
    expect(escalated.escalatedByName).toBe("Иван Петров");

    const list = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    const open = list.escalations.find(item => item.id === escalated.escalationId);
    expect(open?.assigneeId).toBe(order.dispatcher.userId);
    expect(open?.assigneeName).toBe("Иван Петров");
    expect(open?.escalatedBy).toBe(order.dispatcher.userId);
    expect(open?.escalatedByName).toBe("Иван Петров");

    // The idle queue names the same person.
    const row = list.items.find(item => item.orderId === order.orderId);
    expect(row?.escalation?.assigneeName).toBe("Иван Петров");
    expect(row?.escalation?.escalatedByName).toBe("Иван Петров");
  });

  it("reports an escalation without an assignee as nobody named", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);
    await db.update(users).set({ displayName: "Иван Петров" }).where(eq(users.id, order.dispatcher.userId));

    // A row written before the rule "the author owns the jam": no assignee at all.
    await db.insert(orderEscalations).values({
      organizationId: order.organizationId,
      orderId: order.orderId,
      escalatedBy: order.dispatcher.userId,
      reason: "Заказ завис на хабе",
      assigneeId: null,
      state: "open",
    });

    const list = await listStuckOrders(db, order.dispatcher, { minutes: 30 });
    const open = list.escalations[0];
    // A nullable assignee is not an assignment: the panel has to say so.
    expect(open.assigneeId).toBeNull();
    expect(open.assigneeName).toBeNull();
    // The author is still named, so the panel can show who opened the case.
    expect(open.escalatedByName).toBe("Иван Петров");
  });

  it("the server still refuses the escalation actions to a pure finance operator", async () => {
    const order = await seedFullOrder(db);
    await makeIdle(order.orderId, 90);

    const escalated = await escalateOrder(db, order.dispatcher, {
      orderId: order.orderId,
      reason: "Заказ завис на хабе",
      key: `escalate-${rid()}`,
    });

    // A clean finance operator: no admin role in the bag.
    const financeSession = await login(app, {
      organizationId: order.organizationId,
      phone: uniquePhone(),
      roles: ["platform_finance"],
    });
    expect(financeSession.status).toBe(200);
    expect(financeSession.body.roles).toEqual(["platform_finance"]);

    // Reading is allowed — the panel shows the list in the read-only mode.
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/ops/stuck-orders?minutes=30",
      headers: { cookie: financeSession.cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { escalations: Array<{ id: string; assigneeName: string | null }> };
    const open = body.escalations.find(item => item.id === escalated.escalationId);
    expect(open).toBeTruthy();

    // Opening an escalation is not.
    const forbiddenEscalation = await app.inject({
      method: "POST",
      url: `/api/v1/orders/${order.orderId}/escalations`,
      headers: { cookie: financeSession.cookie, "idempotency-key": `escalate-${rid()}` },
      payload: { reason: "Заказ на хабе без фабрики" },
    });
    expect(forbiddenEscalation.statusCode).toBe(403);

    // Closing one is not either.
    const forbiddenResolve = await app.inject({
      method: "POST",
      url: `/api/v1/escalations/${escalated.escalationId}/resolve`,
      headers: { cookie: financeSession.cookie, "idempotency-key": `resolve-${rid()}` },
      payload: { resolution: "Фабрика назначена" },
    });
    expect(forbiddenResolve.statusCode).toBe(403);

    // The escalation is still open: the refused calls changed nothing.
    expect(await openEscalations(order.organizationId, order.orderId)).toHaveLength(1);
  });
});
