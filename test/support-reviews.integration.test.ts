import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { auditEvents, orders } from "../src/db/schema.js";
import { makePrincipal, seedUser } from "./fixtures.js";
import { seedFullOrder } from "./operations-fixtures.js";
import { closeThread, getThread, listThreads, openThread, postMessage } from "../src/services/support.js";
import { createReview, hideReview, likeReview, listReviews, unlikeReview } from "../src/services/reviews.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Support threads and customer reviews", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 8 });
    db = created.db;
    close = () => created.pool.end();
  });
  afterAll(async () => { await close(); });

  async function deliveredOrder() {
    const f = await seedFullOrder(db, { state: "scheduled" });
    await db.update(orders).set({ lifecycleState: "delivered" }).where(eq(orders.id, f.orderId));
    const support = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer_support"]);
    return { ...f, support };
  }

  it("lets a customer and support exchange messages on the customer's order", async () => {
    const f = await deliveredOrder();
    const opened = await openThread(db, f.principal, {
      orderId: f.orderId, subject: "Пятно на рубашке", body: "После стирки осталось пятно", key: `t-${rid()}`,
    });
    await postMessage(db, f.support, { threadId: opened.threadId, body: "Разбираемся", key: `m-${rid()}` });
    await postMessage(db, f.principal, { threadId: opened.threadId, body: "Спасибо", key: `m-${rid()}` });

    const customerView = await getThread(db, f.principal, opened.threadId);
    expect(customerView.viewer).toBe("customer");
    expect(customerView.messages.map(message => message.body)).toEqual([
      "После стирки осталось пятно", "Разбираемся", "Спасибо",
    ]);
    expect(customerView.messages.filter(message => message.isMine)).toHaveLength(2);

    const staffView = await getThread(db, f.support, opened.threadId);
    expect(staffView.viewer).toBe("support");
    expect((await listThreads(db, f.support)).map(thread => thread.id)).toContain(opened.threadId);
    expect((await listThreads(db, f.principal)).map(thread => thread.id)).toContain(opened.threadId);
  });

  it("refuses a thread without an order or on a foreign order, and scopes reads", async () => {
    const f = await deliveredOrder();
    await expect(openThread(db, f.principal, {
      subject: "Без заказа", body: "Не к чему привязать", key: `t-${rid()}`,
    })).rejects.toThrow("ORDER_REQUIRED_FOR_CUSTOMER_THREAD");

    const foreign = await seedFullOrder(db, { state: "scheduled" });
    await expect(openThread(db, f.principal, {
      orderId: foreign.orderId, subject: "Чужой заказ", body: "Не должен пройти", key: `t-${rid()}`,
    })).rejects.toThrow("NOT_FOUND");

    const opened = await openThread(db, f.principal, {
      orderId: f.orderId, subject: "Мой заказ", body: "Вопрос", key: `t-${rid()}`,
    });
    const otherCustomer = makePrincipal(f.organizationId, await seedUser(db, f.organizationId), ["customer"]);
    await expect(getThread(db, otherCustomer, opened.threadId)).rejects.toThrow("NOT_FOUND");
    expect(await listThreads(db, otherCustomer)).toEqual([]);
  });

  it("closes a thread for support only and then rejects new messages", async () => {
    const f = await deliveredOrder();
    const opened = await openThread(db, f.principal, {
      orderId: f.orderId, subject: "Закрытие", body: "Вопрос", key: `t-${rid()}`,
    });
    await expect(closeThread(db, f.principal, {
      threadId: opened.threadId, reason: "сам", key: `c-${rid()}`,
    })).rejects.toThrow("FORBIDDEN");

    const closed = await closeThread(db, f.support, {
      threadId: opened.threadId, reason: "решено", key: `c-${rid()}`,
    });
    expect(closed.state).toBe("closed");
    await expect(postMessage(db, f.principal, {
      threadId: opened.threadId, body: "ещё вопрос", key: `m-${rid()}`,
    })).rejects.toThrow("THREAD_CLOSED");
  });

  it("reviews only completed orders, once", async () => {
    const f = await deliveredOrder();
    const pending = await seedFullOrder(db, { state: "scheduled" });
    await expect(createReview(db, pending.principal, {
      orderId: pending.orderId, rating: 5, body: "рано", key: `r-${rid()}`,
    })).rejects.toThrow("ORDER_NOT_COMPLETED");

    const review = await createReview(db, f.principal, {
      orderId: f.orderId, rating: 5, body: "Отлично", key: `r-${rid()}`,
    });
    expect(review.state).toBe("published");
    await expect(createReview(db, f.principal, {
      orderId: f.orderId, rating: 4, body: "Ещё раз", key: `r-${rid()}`,
    })).rejects.toThrow("REVIEW_EXISTS");
  });

  it("counts likes per user idempotently and hides a moderated review", async () => {
    const f = await deliveredOrder();
    const review = await createReview(db, f.principal, {
      orderId: f.orderId, rating: 4, body: "Хорошо", key: `r-${rid()}`,
    });
    const otherId = await seedUser(db, f.organizationId);
    const other = makePrincipal(f.organizationId, otherId, ["customer"]);

    await likeReview(db, f.principal, { reviewId: review.reviewId, key: `l-${rid()}` });
    await likeReview(db, f.principal, { reviewId: review.reviewId, key: `l-${rid()}` });
    await likeReview(db, other, { reviewId: review.reviewId, key: `l-${rid()}` });

    const first = (await listReviews(db, f.principal)).find(row => row.id === review.reviewId);
    expect(first?.likeCount).toBe(2);
    expect(first?.likedByMe).toBe(true);
    expect(first?.body).toBe("Хорошо");

    await unlikeReview(db, other, { reviewId: review.reviewId });
    const second = (await listReviews(db, f.principal)).find(row => row.id === review.reviewId);
    expect(second?.likeCount).toBe(1);

    const foreignReview = await (async () => {
      const foreign = await deliveredOrder();
      return createReview(db, foreign.principal, {
        orderId: foreign.orderId, rating: 5, body: "Другая организация", key: `r-${rid()}`,
      });
    })();
    expect((await listReviews(db, f.principal)).some(row => row.id === foreignReview.reviewId)).toBe(false);

    await expect(hideReview(db, f.principal, {
      reviewId: review.reviewId, reason: "сам", key: `h-${rid()}`,
    })).rejects.toThrow("FORBIDDEN");
    await hideReview(db, f.support, {
      reviewId: review.reviewId, reason: "оскорбительный текст", key: `h-${rid()}`,
    });
    expect((await listReviews(db, f.principal)).some(row => row.id === review.reviewId)).toBe(false);
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, review.reviewId));
    expect(audit.some(event => event.action === "review.hidden")).toBe(true);
  });
});
