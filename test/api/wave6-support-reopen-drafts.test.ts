import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "../../src/api/server.js";
import { createDb, type Db } from "../../src/db/client.js";
import { notifications, supportMessageDrafts, supportThreads } from "../../src/db/schema.js";
import { makePrincipal } from "../fixtures.js";
import { seedFullOrder } from "../operations-fixtures.js";
import { closeThread, getThreadDraft, openThread, putThreadDraft, deleteThreadDraft, reopenThread } from "../../src/services/support.js";

const rid = () => randomUUID();

describe.skipIf(!process.env.TEST_DATABASE_URL)("Wave 6: support thread reopen and server-side drafts (LA-03, LA-06, LA-09)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    const created = createDb(process.env.TEST_DATABASE_URL!, { max: 10 });
    db = created.db;
    close = () => created.pool.end();
    app = buildApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  async function loginAs(organizationId: string, phone: string, roles: string[]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { organizationId, phone, roles },
    });
    expect(response.statusCode).toBe(200);
    return { cookie: String(response.headers["set-cookie"] ?? "").split(";")[0] };
  }

  it("LA-03: a closed thread can be reopened and the customer is told about it", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const customer = order.principal;
    const support = makePrincipal(order.organizationId, order.courierId, ["customer_support"]);

    const thread = await openThread(db, customer, {
      orderId: order.orderId,
      subject: "Вещь вернулась пятнами",
      body: "После стирки остались пятна, что делать?",
      key: `thread-${rid()}`,
    });
    expect(thread.state).toBe("open");

    const closed = await closeThread(db, support, {
      threadId: thread.threadId,
      reason: "Клиенту отправлена инструкция по уходу.",
      key: `close-${rid()}`,
    });
    expect(closed.state).toBe("closed");

    // LA-06: the customer is told that the thread was closed.
    const closeNotifications = await db.select().from(notifications).where(and(
      eq(notifications.organizationId, order.organizationId),
      eq(notifications.recipientId, customer.userId),
      eq(notifications.template, "support_closed"),
    ));
    expect(closeNotifications).toHaveLength(1);

    const reopened = await reopenThread(db, support, { threadId: thread.threadId, key: `reopen-${rid()}` });
    expect(reopened).toMatchObject({ threadId: thread.threadId, state: "open" });
    const [row] = await db.select().from(supportThreads).where(eq(supportThreads.id, thread.threadId));
    expect(row.state).toBe("open");

    const reopenNotifications = await db.select().from(notifications).where(and(
      eq(notifications.organizationId, order.organizationId),
      eq(notifications.recipientId, customer.userId),
      eq(notifications.template, "support_reopened"),
    ));
    expect(reopenNotifications).toHaveLength(1);

    // The domain event of the reopening is written.
    const events = await db.execute(sql`
      SELECT event_type FROM outbox_events
      WHERE aggregate_id = ${thread.threadId} AND event_type = 'support.reopened'
    `);
    expect(events.rows.length).toBe(1);
  });

  it("LA-03: reopening a thread that is still open is refused", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const support = makePrincipal(order.organizationId, order.courierId, ["customer_support"]);
    const thread = await openThread(db, order.principal, {
      orderId: order.orderId,
      subject: "Ещё вопрос",
      body: "Когда будет доставка?",
      key: `thread-${rid()}`,
    });
    await expect(reopenThread(db, support, { threadId: thread.threadId, key: `reopen-${rid()}` }))
      .rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("LA-09: a draft belongs to its author, survives a reload and is deleted on request", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const agent = makePrincipal(order.organizationId, order.courierId, ["customer_support"]);
    const otherAgent = makePrincipal(order.organizationId, order.dispatcher.userId, ["claims_approver"]);
    const thread = await openThread(db, order.principal, {
      orderId: order.orderId,
      subject: "Долгий ответ",
      body: "Нужен развёрнутый ответ.",
      key: `thread-${rid()}`,
    });

    const saved = await putThreadDraft(db, agent, {
      threadId: thread.threadId,
      body: "Извините за ожидание, вот подробный ответ.",
      key: `draft-${rid()}`,
    });
    expect(saved.body).toContain("подробный ответ");
    expect(saved.updatedAt).toBeTruthy();

    // Reading it back gives the same text: the draft is on the server, not in the tab.
    const read = await getThreadDraft(db, agent, { threadId: thread.threadId });
    expect(read?.body).toBe(saved.body);

    // Another agent sees nothing: the draft belongs to its author.
    const foreign = await getThreadDraft(db, otherAgent, { threadId: thread.threadId });
    expect(foreign).toBeNull();

    // Saving again replaces the text instead of piling up rows.
    const updated = await putThreadDraft(db, agent, {
      threadId: thread.threadId,
      body: "Уточнённый ответ.",
      key: `draft2-${rid()}`,
    });
    expect(updated.body).toBe("Уточнённый ответ.");
    const rows = await db.select().from(supportMessageDrafts)
      .where(eq(supportMessageDrafts.threadId, thread.threadId));
    expect(rows).toHaveLength(1);

    // A closed thread has no answer left to write: the contract says the draft does not survive
    // the closing of the thread (REMEDIATION-CONTRACT-2026-11-25, §1.7).
    await closeThread(db, agent, { threadId: thread.threadId, reason: "Ответ отправлен.", key: `close-${rid()}` });
    const afterClose = await getThreadDraft(db, agent, { threadId: thread.threadId });
    expect(afterClose).toBeNull();
    const remaining = await db.select().from(supportMessageDrafts)
      .where(eq(supportMessageDrafts.threadId, thread.threadId));
    expect(remaining).toHaveLength(0);

    const deleted = await deleteThreadDraft(db, agent, { threadId: thread.threadId, key: `del-${rid()}` });
    expect(deleted.deleted).toBe(false);
    expect(await getThreadDraft(db, agent, { threadId: thread.threadId })).toBeNull();
  });

  it("LA-09: the draft routes of the API save, read and delete the author's own draft", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const supportPhone = `+7999${Math.floor(1000000 + Math.random() * 8999999)}`;
    const session = await loginAs(order.organizationId, supportPhone, ["customer_support"]);
    const thread = await openThread(db, order.principal, {
      orderId: order.orderId,
      subject: "Черновик через API",
      body: "Нужен ответ.",
      key: `thread-${rid()}`,
    });

    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/support/threads/${thread.threadId}/draft`,
      headers: { cookie: session.cookie, "idempotency-key": `draft-${rid()}` },
      payload: { body: "Черновик через API" },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { body: string }).body).toBe("Черновик через API");

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/support/threads/${thread.threadId}/draft`,
      headers: { cookie: session.cookie },
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { body: string }).body).toBe("Черновик через API");

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/support/threads/${thread.threadId}/draft`,
      headers: { cookie: session.cookie, "idempotency-key": `draft-del-${rid()}` },
    });
    expect(remove.statusCode).toBe(200);

    const getAfter = await app.inject({
      method: "GET",
      url: `/api/v1/support/threads/${thread.threadId}/draft`,
      headers: { cookie: session.cookie },
    });
    expect(getAfter.statusCode).toBe(200);
    expect(getAfter.json()).toBeNull();
  });

  it("LA-03: the reopen route of the API brings the thread back", async () => {
    const order = await seedFullOrder(db, { state: "scheduled" });
    const supportPhone = `+7999${Math.floor(1000000 + Math.random() * 8999999)}`;
    const session = await loginAs(order.organizationId, supportPhone, ["customer_support"]);
    const thread = await openThread(db, order.principal, {
      orderId: order.orderId,
      subject: "Переоткрытие через API",
      body: "Вопрос ещё не решён.",
      key: `thread-${rid()}`,
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/support/threads/${thread.threadId}/close`,
      headers: { cookie: session.cookie, "idempotency-key": `close-${rid()}` },
      payload: { reason: "Пока ждём ответ клиента." },
    });

    const reopen = await app.inject({
      method: "POST",
      url: `/api/v1/support/threads/${thread.threadId}/reopen`,
      headers: { cookie: session.cookie, "idempotency-key": `reopen-${rid()}` },
      payload: {},
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json()).toMatchObject({ threadId: thread.threadId, state: "open" });
  });
});
