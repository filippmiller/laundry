import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { orders, supportMessages, supportThreads } from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

const SUPPORT_ROLES = [...ROLE_GROUPS.support, ...ROLE_GROUPS.admin] as const;

function isSupport(principal: Principal) {
  return hasRole(principal, ...SUPPORT_ROLES);
}

async function loadThread(db: Db, principal: Principal, threadId: string) {
  const [thread] = await db.select().from(supportThreads).where(and(
    eq(supportThreads.id, threadId),
    eq(supportThreads.organizationId, principal.organizationId),
  )).limit(1);
  if (!thread) throw errors.notFound("thread");
  let customerId: string | null = null;
  if (thread.orderId) {
    const [order] = await db.select({ customerId: orders.customerId }).from(orders).where(and(
      eq(orders.id, thread.orderId),
      eq(orders.organizationId, principal.organizationId),
    )).limit(1);
    customerId = order?.customerId ?? null;
  }
  const support = isSupport(principal);
  if (!support && customerId !== principal.userId) throw errors.notFound("thread");
  return { thread, support };
}

export async function openThread(
  db: Db,
  principal: Principal,
  input: { orderId?: string; subject: string; body: string; key: string },
) {
  assertRole(principal, "customer", ...SUPPORT_ROLES);
  if (input.subject.trim().length < 3 || input.body.trim().length < 3) {
    throw new AppError("VALIDATION_ERROR", "THREAD_CONTENT_REQUIRED");
  }
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "support:open", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const support = isSupport(principal);
    if (!support && !input.orderId) {
      throw new AppError("VALIDATION_ERROR", "ORDER_REQUIRED_FOR_CUSTOMER_THREAD");
    }
    if (input.orderId) {
      // Whoever opens the thread, the order has to belong to this tenant: the body chooses the
      // anchor and a thread pointing at a foreign order is invisible to everyone afterwards.
      const [order] = await tx.select({ id: orders.id, customerId: orders.customerId }).from(orders).where(and(
        eq(orders.id, input.orderId),
        eq(orders.organizationId, principal.organizationId),
      )).limit(1);
      if (!order) throw errors.notFound("order");
      // A customer thread must be anchored to their own order so it can be scoped later.
      if (!support && order.customerId !== principal.userId) throw errors.notFound("order");
    }
    const [thread] = await tx.insert(supportThreads).values({
      organizationId: principal.organizationId,
      orderId: input.orderId ?? null,
      subject: input.subject,
      state: "open",
    }).returning();
    await tx.insert(supportMessages).values({
      threadId: thread.id, authorId: principal.userId, body: input.body,
    });
    await appendEvent(tx, {
      principal, aggregateType: "support_thread", aggregateId: thread.id,
      eventType: "support.opened", payload: { orderId: input.orderId ?? null },
    });
    return { threadId: thread.id, state: "open" as const };
  });
}

export async function postMessage(
  db: Db,
  principal: Principal,
  input: { threadId: string; body: string; key: string },
) {
  assertRole(principal, "customer", ...SUPPORT_ROLES);
  if (input.body.trim().length < 1) throw new AppError("VALIDATION_ERROR", "MESSAGE_REQUIRED");
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "support:message", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const { thread, support } = await loadThread(tx, principal, input.threadId);
    if (thread.state !== "open") throw new AppError("INVALID_TRANSITION", "THREAD_CLOSED", { state: thread.state });
    const [message] = await tx.insert(supportMessages).values({
      threadId: thread.id, authorId: principal.userId, body: input.body,
    }).returning();
    await appendEvent(tx, {
      principal, aggregateType: "support_thread", aggregateId: thread.id,
      eventType: support ? "support.reply_staff" : "support.reply_customer",
      payload: { messageId: message.id },
    });
    return { threadId: thread.id, messageId: message.id, authorRole: support ? "support" : "customer" };
  });
}

export async function listThreads(db: Db, principal: Principal, input: { limit?: number } = {}) {
  assertRole(principal, "customer", ...SUPPORT_ROLES);
  const limit = Math.min(input.limit ?? 50, 100);
  if (isSupport(principal)) {
    return db.select().from(supportThreads)
      .where(eq(supportThreads.organizationId, principal.organizationId))
      .orderBy(desc(supportThreads.createdAt))
      .limit(limit);
  }
  return db.select({
    id: supportThreads.id, orderId: supportThreads.orderId, subject: supportThreads.subject,
    state: supportThreads.state, createdAt: supportThreads.createdAt,
  }).from(supportThreads)
    .innerJoin(orders, eq(orders.id, supportThreads.orderId))
    .where(and(
      eq(supportThreads.organizationId, principal.organizationId),
      eq(orders.customerId, principal.userId),
    ))
    .orderBy(desc(supportThreads.createdAt))
    .limit(limit);
}

export async function getThread(db: Db, principal: Principal, threadId: string) {
  assertRole(principal, "customer", ...SUPPORT_ROLES);
  const { thread, support } = await loadThread(db, principal, threadId);
  const messages = await db.select({
    id: supportMessages.id,
    body: supportMessages.body,
    createdAt: supportMessages.createdAt,
    authorId: supportMessages.authorId,
  }).from(supportMessages)
    .where(eq(supportMessages.threadId, thread.id))
    .orderBy(asc(supportMessages.createdAt))
    .limit(500);
  return {
    thread,
    messages: messages.map(message => ({
      id: message.id,
      body: message.body,
      createdAt: message.createdAt,
      isMine: message.authorId === principal.userId,
    })),
    viewer: support ? "support" : "customer",
  };
}

export async function closeThread(
  db: Db,
  principal: Principal,
  input: { threadId: string; reason: string; key: string },
) {
  assertRole(principal, ...SUPPORT_ROLES);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "support:close", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const { thread } = await loadThread(tx, principal, input.threadId);
    if (thread.state === "closed") return { threadId: thread.id, state: "closed" as const };
    await tx.update(supportThreads).set({ state: "closed" }).where(eq(supportThreads.id, thread.id));
    await appendEvent(tx, {
      principal, aggregateType: "support_thread", aggregateId: thread.id,
      eventType: "support.closed", reason: input.reason,
    });
    return { threadId: thread.id, state: "closed" as const };
  });
}
