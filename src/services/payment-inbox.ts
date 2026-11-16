import { and, eq, sql, sum } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { paymentEvents, paymentIntents, refunds } from "../db/schema.js";
import { assertRole, type Principal } from "../core/context.js";
import { AppError } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";

const MAX_ATTEMPTS = 5;

type ClaimedEvent = {
  id: string;
  organizationId: string;
  eventType: string;
  paymentIntentId: string | null;
  attempts: number;
};

/**
 * Leased inbox processing: rows are claimed with FOR UPDATE SKIP LOCKED, so several workers can
 * drain the queue without applying one provider event twice. A row that keeps failing stays
 * visible with its error instead of being silently dropped.
 */
export async function processPaymentInbox(db: Db, input: { limit?: number } = {}) {
  const limit = Math.min(input.limit ?? 50, 200);
  return db.transaction(async tx => {
    const claimed = await tx.execute(sql`
      UPDATE payment_events SET state = 'processing', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM payment_events
        WHERE state = 'received' AND attempts < ${MAX_ATTEMPTS}
        ORDER BY received_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organization_id AS "organizationId", event_type AS "eventType",
                payment_intent_id AS "paymentIntentId", attempts
    `);
    const rows = claimed.rows as unknown as ClaimedEvent[];
    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        if (!row.paymentIntentId) throw new Error("INTENT_MISSING");
        const [intent] = await tx.select().from(paymentIntents).where(and(
          eq(paymentIntents.id, row.paymentIntentId),
          eq(paymentIntents.organizationId, row.organizationId),
        )).limit(1);
        if (!intent) throw new Error("INTENT_NOT_FOUND");
        await applyEvent(tx, row.eventType, intent);
        await tx.update(paymentEvents)
          .set({ state: "processed", processedAt: new Date(), error: null })
          .where(eq(paymentEvents.id, row.id));
        processed += 1;
      } catch (error) {
        await tx.update(paymentEvents)
          .set({ state: "failed", error: (error as Error)?.message ?? "UNKNOWN" })
          .where(eq(paymentEvents.id, row.id));
        failed += 1;
      }
    }
    return { claimed: rows.length, processed, failed };
  });
}

type Intent = typeof paymentIntents.$inferSelect;

async function applyEvent(tx: Db, eventType: string, intent: Intent) {
  switch (eventType) {
    case "captured": {
      if (["pending", "authorized"].includes(intent.state)) {
        await tx.update(paymentIntents).set({ state: "captured" }).where(eq(paymentIntents.id, intent.id));
      }
      return;
    }
    case "refunded": {
      const [totals] = await tx.select({ total: sum(refunds.amountKopeks) }).from(refunds).where(and(
        eq(refunds.organizationId, intent.organizationId),
        eq(refunds.paymentIntentId, intent.id),
        eq(refunds.state, "completed"),
      ));
      const refunded = Number(totals?.total ?? 0);
      if (!refunded) return;
      const state = refunded >= intent.amountKopeks ? "refunded" : "partially_refunded";
      if (state !== intent.state) {
        await tx.update(paymentIntents).set({ state }).where(eq(paymentIntents.id, intent.id));
      }
      return;
    }
    case "chargeback":
    case "dispute": {
      if (intent.state !== "chargeback_lost") {
        await tx.update(paymentIntents).set({ state: "disputed" }).where(eq(paymentIntents.id, intent.id));
      }
      return;
    }
    default:
      throw new Error("UNKNOWN_EVENT_TYPE");
  }
}

/** Re-arms failed events with remaining attempts; used by the worker loop. */
export async function requeueFailedPaymentEvents(db: Db, input: { limit?: number } = {}) {
  const limit = Math.min(input.limit ?? 50, 200);
  const rows = await db.execute(sql`
    UPDATE payment_events SET state = 'received', error = NULL
    WHERE id IN (
      SELECT id FROM payment_events
      WHERE state = 'failed' AND attempts < ${MAX_ATTEMPTS}
      ORDER BY received_at ASC
      LIMIT ${limit}
    )
    RETURNING id
  `);
  return { requeued: (rows.rows as unknown[]).length };
}

/** Read-only drift report: the stored intent state must match the completed refunds. */
export async function paymentDrift(db: Db, principal: Principal) {
  assertRole(principal, "platform_finance", "platform_admin", "security_auditor");
  const rows = await db.execute(sql`
    SELECT pi.id AS "paymentIntentId", pi.state AS "state", pi.amount_kopeks AS "amountKopeks",
           COALESCE(SUM(r.amount_kopeks), 0)::bigint AS "refundedKopeks"
    FROM payment_intents pi
    LEFT JOIN refunds r ON r.payment_intent_id = pi.id AND r.state = 'completed'
    WHERE pi.organization_id = ${principal.organizationId}
    GROUP BY pi.id, pi.state, pi.amount_kopeks
    HAVING (pi.state = 'refunded' AND COALESCE(SUM(r.amount_kopeks), 0) < pi.amount_kopeks)
        OR (pi.state IN ('captured', 'partially_refunded') AND COALESCE(SUM(r.amount_kopeks), 0) >= pi.amount_kopeks)
        OR (pi.state = 'captured' AND COALESCE(SUM(r.amount_kopeks), 0) > 0)
    LIMIT 200
  `);
  return (rows.rows as unknown as Array<{
    paymentIntentId: string; state: string; amountKopeks: number; refundedKopeks: number;
  }>).map(row => ({
    ...row, amountKopeks: Number(row.amountKopeks), refundedKopeks: Number(row.refundedKopeks),
  }));
}

/** A chargeback is a disputed capture: refunds stop until a human resolves it. */
export async function markChargeback(
  db: Db,
  principal: Principal,
  input: { paymentIntentId: string; reason: string; key: string },
) {
  assertRole(principal, "platform_finance", "platform_admin");
  return withIdempotencyFlat(db, {
    organizationId: principal.organizationId, scope: "finance:chargeback", key: input.key, actorId: principal.userId,
    requestHash: hashRequest({ ...input, actorId: principal.userId }),
  }, async tx => {
    const locked = await tx.execute(sql`
      SELECT id FROM payment_intents
      WHERE id = ${input.paymentIntentId} AND organization_id = ${principal.organizationId}
      FOR UPDATE
    `);
    if (!(locked.rows as unknown[]).length) throw new AppError("NOT_FOUND", "NOT_FOUND", { resource: "payment intent" });
    const [intent] = await tx.select().from(paymentIntents).where(eq(paymentIntents.id, input.paymentIntentId)).limit(1);
    if (!intent) throw new AppError("NOT_FOUND", "NOT_FOUND", { resource: "payment intent" });
    if (!["captured", "partially_refunded", "refunded"].includes(intent.state)) {
      throw new AppError("FINANCIAL_HOLD", "PAYMENT_NOT_DISPUTABLE", { state: intent.state });
    }
    await tx.update(paymentIntents).set({ state: "disputed" }).where(eq(paymentIntents.id, intent.id));
    await appendEvent(tx, {
      principal, aggregateType: "payment", aggregateId: intent.id,
      eventType: "payment.chargeback", reason: input.reason,
      payload: { amountKopeks: intent.amountKopeks },
    });
    return { paymentIntentId: intent.id, state: "disputed" as const };
  });
}
