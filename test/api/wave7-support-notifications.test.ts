import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { notifications, outboxEvents } from "../../src/db/schema.js";
import { makePrincipal } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { closeThread, openThread, reopenThread } from "../../src/services/support.js";
import { processOutbox, requeueFailedOutboxEvents } from "../../src/services/outbox.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 7: support transition notifications (LND-R4-04)", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
    db = created.db;
    close = () => created.pool.end();
  });

  afterAll(async () => {
    await close();
  });

  /** Drains the events of one tenant until nothing of that tenant is left to claim. */
  async function drain(organizationId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await processOutbox(db, { limit: 500, organizationId });
      if (result.claimed === 0) return;
    }
  }

  async function notificationsFor(organizationId: string, recipientId: string, template: string) {
    return db.select().from(notifications).where(and(
      eq(notifications.organizationId, organizationId),
      eq(notifications.recipientId, recipientId),
      eq(notifications.template, template),
    ));
  }

  async function eventsFor(organizationId: string, threadId: string, eventType: string) {
    return db.select().from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, organizationId),
      eq(outboxEvents.aggregateId, threadId),
      eq(outboxEvents.eventType, eventType),
    ));
  }

  it("LND-R4-04: every close and every reopen of the same thread tells the customer again", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const customer = order.principal;
    const support = makePrincipal(order.organizationId, order.courierId, ["customer_support"]);

    const thread = await openThread(db, customer, {
      orderId: order.orderId,
      subject: "Пятна после стирки",
      body: "После стирки остались пятна, что делать?",
      key: `thread-${rid()}`,
    });

    // Two full cycles: the second close and the second reopen are transitions of their own.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const closed = await closeThread(db, support, {
        threadId: thread.threadId,
        reason: "Клиенту отправлена инструкция по уходу.",
        key: `close-${rid()}`,
      });
      expect(closed.state).toBe("closed");
      const reopened = await reopenThread(db, support, { threadId: thread.threadId, key: `reopen-${rid()}` });
      expect(reopened.state).toBe("open");
    }

    await drain(order.organizationId);

    const closes = await notificationsFor(order.organizationId, customer.userId, "support_closed");
    const reopens = await notificationsFor(order.organizationId, customer.userId, "support_reopened");
    expect(closes).toHaveLength(2);
    expect(reopens).toHaveLength(2);

    // Every transition owns its key, and the key names the event it belongs to.
    const closeEvents = await eventsFor(order.organizationId, thread.threadId, "support.closed");
    const reopenEvents = await eventsFor(order.organizationId, thread.threadId, "support.reopened");
    expect(closeEvents).toHaveLength(2);
    expect(reopenEvents).toHaveLength(2);
    expect(new Set(closes.map(row => row.dedupeKey)).size).toBe(2);
    expect(new Set(reopens.map(row => row.dedupeKey)).size).toBe(2);
    for (const event of closeEvents) {
      expect(closes.some(row => row.dedupeKey === `support:${thread.threadId}:closed:${event.id}`)).toBe(true);
    }
    for (const event of reopenEvents) {
      expect(reopens.some(row => row.dedupeKey === `support:${thread.threadId}:reopened:${event.id}`)).toBe(true);
    }
  });

  it("LND-R4-04: a redelivered event does not tell the customer twice", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const customer = order.principal;
    const support = makePrincipal(order.organizationId, order.courierId, ["customer_support"]);

    const thread = await openThread(db, customer, {
      orderId: order.orderId,
      subject: "Повторная доставка уведомления",
      body: "Что с моим заказом?",
      key: `thread-${rid()}`,
    });
    await closeThread(db, support, {
      threadId: thread.threadId,
      reason: "Ответ отправлен.",
      key: `close-${rid()}`,
    });
    await drain(order.organizationId);

    const before = await notificationsFor(order.organizationId, customer.userId, "support_closed");
    expect(before).toHaveLength(1);

    // The very same event is handed to the worker again: it goes back into the queue and the
    // drain sees it a second time.
    const [event] = await eventsFor(order.organizationId, thread.threadId, "support.closed");
    expect(event).toBeTruthy();
    await db.update(outboxEvents)
      .set({ state: "failed", deliveryStatus: "failed", attempts: 1, error: "REDELIVERED" })
      .where(eq(outboxEvents.id, event.id));
    const requeued = await requeueFailedOutboxEvents(db, {
      organizationId: order.organizationId,
      forceImmediate: true,
    });
    expect(requeued.requeued).toBeGreaterThanOrEqual(1);
    await drain(order.organizationId);

    const after = await notificationsFor(order.organizationId, customer.userId, "support_closed");
    expect(after).toHaveLength(1);
    expect(after[0].dedupeKey).toBe(before[0].dedupeKey);
  });

  it("LND-R4-04: a single close tells the customer exactly once", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const customer = order.principal;
    const support = makePrincipal(order.organizationId, order.courierId, ["customer_support"]);

    const thread = await openThread(db, customer, {
      orderId: order.orderId,
      subject: "Одно закрытие",
      body: "Спасибо за помощь.",
      key: `thread-${rid()}`,
    });
    await closeThread(db, support, {
      threadId: thread.threadId,
      reason: "Вопрос закрыт.",
      key: `close-${rid()}`,
    });

    // The service writes the notice right away.
    const direct = await notificationsFor(order.organizationId, customer.userId, "support_closed");
    expect(direct).toHaveLength(1);

    // The outbox copy of the same event must not add a second one.
    await drain(order.organizationId);
    const afterDrain = await notificationsFor(order.organizationId, customer.userId, "support_closed");
    expect(afterDrain).toHaveLength(1);

    const [event] = await eventsFor(order.organizationId, thread.threadId, "support.closed");
    expect(afterDrain[0].dedupeKey).toBe(`support:${thread.threadId}:closed:${event.id}`);
  });
});
