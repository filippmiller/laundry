import { and, desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notifications, orders, supportMessageDrafts, supportMessages, supportThreads } from "../db/schema.js";
import { assertRole, hasRole, type Principal, ROLE_GROUPS } from "../core/context.js";
import { decodeKeysetCursor, encodeKeysetCursor, escapeLikePattern, pgCursorTimestampSql } from "../core/cursor.js";
import { AppError, errors } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

const SUPPORT_ROLES = [...ROLE_GROUPS.support, ...ROLE_GROUPS.admin] as const;

function isSupport(principal: Principal) {
  return hasRole(principal, ...SUPPORT_ROLES);
}

async function loadThread(db: Db, principal: Principal, threadId: string, options: { lock?: boolean } = {}) {
  const query = db.select().from(supportThreads).where(and(
    eq(supportThreads.id, threadId),
    eq(supportThreads.organizationId, principal.organizationId),
  )).limit(1);
  const [thread] = options.lock ? await query.for("update") : await query;
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
  return { thread, support, customerId };
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
    const { thread, support } = await loadThread(tx, principal, input.threadId, { lock: true });
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

export async function listThreadsPage(
  db: Db,
  principal: Principal,
  input: { limit?: number; cursor?: string; query?: string; state?: string } = {},
) {
  assertRole(principal, "customer", ...SUPPORT_ROLES);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  const decoded = input.cursor ? decodeKeysetCursor(input.cursor) : null;
  const trimmedQuery = input.query?.trim();
  const likePattern = trimmedQuery ? `%${escapeLikePattern(trimmedQuery)}%` : null;
  const stateFilter = input.state?.trim() || null;

  const support = isSupport(principal);
  const baseWhere = and(
    eq(supportThreads.organizationId, principal.organizationId),
    support ? undefined : eq(orders.customerId, principal.userId),
    stateFilter ? eq(supportThreads.state, stateFilter) : undefined,
    likePattern
      ? or(
        sql`${supportThreads.subject} ILIKE ${likePattern} ESCAPE '\\'`,
        sql`${orders.publicNumber} ILIKE ${likePattern} ESCAPE '\\'`,
      )
      : undefined,
  );
  const pageWhere = and(
    baseWhere,
    decoded
      ? sql`(${supportThreads.createdAt}, ${supportThreads.id}) < (${decoded.ts}::timestamptz, ${decoded.id})`
      : undefined,
  );

  const [[countRow], rows] = await Promise.all([
    support
      ? db.select({ count: sql<number>`count(*)::int` })
        .from(supportThreads)
        .leftJoin(orders, and(
          eq(orders.id, supportThreads.orderId),
          eq(orders.organizationId, supportThreads.organizationId),
        ))
        .where(baseWhere)
      : db.select({ count: sql<number>`count(*)::int` })
        .from(supportThreads)
        .innerJoin(orders, and(
          eq(orders.id, supportThreads.orderId),
          eq(orders.organizationId, supportThreads.organizationId),
        ))
        .where(baseWhere),
    support
      ? db.select({
        id: supportThreads.id,
        organizationId: supportThreads.organizationId,
        orderId: supportThreads.orderId,
        orderPublicNumber: orders.publicNumber,
        subject: supportThreads.subject,
        state: supportThreads.state,
        createdAt: supportThreads.createdAt,
        cursorTs: pgCursorTimestampSql(supportThreads.createdAt),
      }).from(supportThreads)
        .leftJoin(orders, and(
          eq(orders.id, supportThreads.orderId),
          eq(orders.organizationId, supportThreads.organizationId),
        ))
        .where(pageWhere)
        .orderBy(desc(supportThreads.createdAt), desc(supportThreads.id))
        .limit(limit + 1)
      : db.select({
        id: supportThreads.id,
        orderId: supportThreads.orderId,
        orderPublicNumber: orders.publicNumber,
        subject: supportThreads.subject,
        state: supportThreads.state,
        createdAt: supportThreads.createdAt,
        cursorTs: pgCursorTimestampSql(supportThreads.createdAt),
      }).from(supportThreads)
        .innerJoin(orders, and(
          eq(orders.id, supportThreads.orderId),
          eq(orders.organizationId, supportThreads.organizationId),
        ))
        .where(pageWhere)
        .orderBy(desc(supportThreads.createdAt), desc(supportThreads.id))
        .limit(limit + 1),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeKeysetCursor(last.cursorTs, last.id) : null;
  return {
    items: pageRows.map(({ cursorTs: _cursorTs, ...row }) => row),
    totalCount: countRow?.count ?? 0,
    hasMore,
    nextCursor,
  };
}

export async function listThreads(
  db: Db,
  principal: Principal,
  input: { limit?: number; cursor?: string; query?: string; state?: string } = {},
) {
  const page = await listThreadsPage(db, principal, input);
  return page.items;
}

export async function getThread(
  db: Db,
  principal: Principal,
  threadId: string,
  options: { limit?: number; beforeCursor?: string } = {},
) {
  assertRole(principal, "customer", ...SUPPORT_ROLES);
  const { thread, support, customerId } = await loadThread(db, principal, threadId);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 500);
  const decoded = options.beforeCursor ? decodeKeysetCursor(options.beforeCursor) : null;

  const [[countRow], fetched] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(supportMessages)
      .where(eq(supportMessages.threadId, thread.id)),
    db.select({
      id: supportMessages.id,
      body: supportMessages.body,
      createdAt: supportMessages.createdAt,
      authorId: supportMessages.authorId,
      cursorTs: pgCursorTimestampSql(supportMessages.createdAt),
    }).from(supportMessages)
      .where(and(
        eq(supportMessages.threadId, thread.id),
        decoded
          ? sql`(${supportMessages.createdAt}, ${supportMessages.id}) < (${decoded.ts}::timestamptz, ${decoded.id})`
          : undefined,
      ))
      .orderBy(desc(supportMessages.createdAt), desc(supportMessages.id))
      .limit(limit + 1),
  ]);

  const hasEarlier = fetched.length > limit;
  const pageDesc = hasEarlier ? fetched.slice(0, limit) : fetched;
  const messages = pageDesc.reverse();
  const oldest = messages[0];
  const earlierCursor = hasEarlier && oldest ? encodeKeysetCursor(oldest.cursorTs, oldest.id) : null;

  return {
    thread,
    messages: messages.map(message => ({
      id: message.id,
      body: message.body,
      createdAt: message.createdAt,
      isMine: message.authorId === principal.userId,
      authorKind: (customerId && message.authorId === customerId ? "customer" : "support") as "customer" | "support",
    })),
    hasEarlier,
    earlierCursor,
    totalMessages: countRow?.count ?? messages.length,
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
    const { thread, customerId } = await loadThread(tx, principal, input.threadId, { lock: true });
    if (thread.state === "closed") return { threadId: thread.id, state: "closed" as const };
    await tx.update(supportThreads).set({ state: "closed" }).where(eq(supportThreads.id, thread.id));
    await appendEvent(tx, {
      principal, aggregateType: "support_thread", aggregateId: thread.id,
      eventType: "support.closed", reason: input.reason,
    });
    // The customer has to learn that the conversation is over without opening the thread again.
    // The dedupe key is the one the outbox uses for the same event, so the customer never sees
    // the notice twice.
    if (customerId) {
      await tx.insert(notifications).values({
        organizationId: principal.organizationId,
        recipientId: customerId,
        orderId: thread.orderId,
        channel: "push",
        template: "support_closed",
        payloadJson: { threadId: thread.id, subject: thread.subject, reason: input.reason },
        dedupeKey: `support:${thread.id}:closed`,
      }).onConflictDoNothing();
    }
    // A closed thread has no answer left to write: the pending drafts go with it.
    await tx.delete(supportMessageDrafts).where(and(
      eq(supportMessageDrafts.organizationId, principal.organizationId),
      eq(supportMessageDrafts.threadId, thread.id),
    ));
    return { threadId: thread.id, state: "closed" as const };
  });
}

/**
 * Reopens a closed thread.
 *
 * A closed thread was a dead end: the customer could not continue the conversation and had to
 * open a new one, which split the history. Reopening keeps the thread and its messages together.
 */
export async function reopenThread(
  db: Db,
  principal: Principal,
  input: { threadId: string; key: string },
) {
  assertRole(principal, ...SUPPORT_ROLES);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "support:reopen", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const { thread, customerId } = await loadThread(tx, principal, input.threadId, { lock: true });
    if (thread.state !== "closed") throw errors.transition(thread.state, "open");
    await tx.update(supportThreads).set({ state: "open" }).where(eq(supportThreads.id, thread.id));
    await appendEvent(tx, {
      principal, aggregateType: "support_thread", aggregateId: thread.id,
      eventType: "support.reopened",
      payload: { previousState: thread.state, customerId: customerId ?? null },
    });
    // The customer asked to continue the conversation; the notice says the thread is open again.
    if (customerId) {
      await tx.insert(notifications).values({
        organizationId: principal.organizationId,
        recipientId: customerId,
        orderId: thread.orderId,
        channel: "push",
        template: "support_reopened",
        payloadJson: { threadId: thread.id, subject: thread.subject },
        dedupeKey: `support:${thread.id}:reopened`,
      }).onConflictDoNothing();
    }
    return { threadId: thread.id, state: "open" as const };
  });
}

/**
 * Saves the reply the support agent is writing.
 *
 * The draft belongs to its author and to nobody else: one row per (thread, author), readable only
 * by the author. It is stored on the server so a reload or a switch to another thread does not
 * throw the text away.
 */
export async function putThreadDraft(
  db: Db,
  principal: Principal,
  input: { threadId: string; body: string; key: string },
) {
  assertRole(principal, ...SUPPORT_ROLES);
  if (input.body.trim().length < 1) throw new AppError("VALIDATION_ERROR", "DRAFT_BODY_REQUIRED");
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "support:draft", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    await loadThread(tx, principal, input.threadId);
    const [draft] = await tx.insert(supportMessageDrafts).values({
      organizationId: principal.organizationId,
      threadId: input.threadId,
      authorId: principal.userId,
      body: input.body,
    }).onConflictDoUpdate({
      target: [supportMessageDrafts.threadId, supportMessageDrafts.authorId],
      set: { body: input.body, updatedAt: new Date() },
    }).returning({
      threadId: supportMessageDrafts.threadId,
      body: supportMessageDrafts.body,
      updatedAt: supportMessageDrafts.updatedAt,
    });
    return { threadId: draft.threadId, body: draft.body, updatedAt: draft.updatedAt.toISOString() };
  });
}

/** Reads the caller's own draft of a thread; another author's draft is invisible. */
export async function getThreadDraft(
  db: Db,
  principal: Principal,
  input: { threadId: string },
) {
  assertRole(principal, ...SUPPORT_ROLES);
  const [draft] = await db.select({
    threadId: supportMessageDrafts.threadId,
    body: supportMessageDrafts.body,
    updatedAt: supportMessageDrafts.updatedAt,
  }).from(supportMessageDrafts).where(and(
    eq(supportMessageDrafts.organizationId, principal.organizationId),
    eq(supportMessageDrafts.threadId, input.threadId),
    eq(supportMessageDrafts.authorId, principal.userId),
  )).limit(1);
  if (!draft) return null;
  return { threadId: draft.threadId, body: draft.body, updatedAt: draft.updatedAt.toISOString() };
}

/** Deletes the caller's own draft. A missing draft is not an error. */
export async function deleteThreadDraft(
  db: Db,
  principal: Principal,
  input: { threadId: string; key: string },
) {
  assertRole(principal, ...SUPPORT_ROLES);
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "support:draft_delete", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const deleted = await tx.delete(supportMessageDrafts).where(and(
      eq(supportMessageDrafts.organizationId, principal.organizationId),
      eq(supportMessageDrafts.threadId, input.threadId),
      eq(supportMessageDrafts.authorId, principal.userId),
    )).returning({ id: supportMessageDrafts.id });
    return { threadId: input.threadId, deleted: deleted.length > 0 };
  });
}
