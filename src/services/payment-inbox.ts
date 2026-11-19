import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { paymentEvents, paymentIntents, refunds } from "../db/schema.js";
import { assertRole, type Principal } from "../core/context.js";
import { AppError } from "../core/errors.js";
import { appendEvent } from "../core/events.js";
import { hashRequest, withIdempotencyFlat } from "../core/idempotency.js";
import { postCaptureJournalTx, postRefundJournalTx } from "./finance.js";

const MAX_ATTEMPTS = 5;

type ClaimedEvent = {
  id: string;
  organizationId: string;
  eventType: string;
  paymentIntentId: string | null;
  attempts: number;
};

/**
 * Leased inbox processing: rows are claimed with FOR UPDATE SKIP LOCKED in a short claim
 * transaction, then each claimed event runs in its OWN independent transaction so a failure
 * mid-event rolls back ALL of that event's writes (`payment_intents`, `ledger_entries`, etc.),
 * records the error cleanly in `payment_events`, and never aborts or corrupts sibling events.
 */
export async function processPaymentInbox(
  db: Db,
  input: {
    limit?: number;
    /** Optional hook invoked inside the per-event transaction after `applyEvent` (used for failpoint tests). */
    afterApply?: (event: ClaimedEvent, tx: Tx) => Promise<void> | void;
  } = {},
) {
  const limit = Math.min(input.limit ?? 50, 200);
  const rows = await db.transaction(async tx => {
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
    return claimed.rows as unknown as ClaimedEvent[];
  });

  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await db.transaction(async tx => {
        if (!row.paymentIntentId) throw new Error("INTENT_MISSING");
        const [intent] = await tx.select().from(paymentIntents).where(and(
          eq(paymentIntents.id, row.paymentIntentId),
          eq(paymentIntents.organizationId, row.organizationId),
        )).limit(1);
        if (!intent) throw new Error("INTENT_NOT_FOUND");
        await applyEvent(tx, row.eventType, intent);
        if (input.afterApply) {
          await input.afterApply(row, tx);
        }
        await tx.update(paymentEvents)
          .set({ state: "processed", processedAt: new Date(), error: null })
          .where(eq(paymentEvents.id, row.id));
      });
      processed += 1;
    } catch (error) {
      await db.update(paymentEvents)
        .set({ state: "failed", error: (error as Error)?.message ?? "UNKNOWN" })
        .where(eq(paymentEvents.id, row.id));
      failed += 1;
    }
  }
  return { claimed: rows.length, processed, failed };
}

type Intent = typeof paymentIntents.$inferSelect;

async function applyEvent(tx: Tx, eventType: string, intent: Intent) {
  switch (eventType) {
    case "captured": {
      if (["pending", "authorized"].includes(intent.state)) {
        await tx.update(paymentIntents).set({ state: "captured" }).where(eq(paymentIntents.id, intent.id));
        await postCaptureJournalTx(tx, {
          organizationId: intent.organizationId,
          sourceId: intent.id,
          amountKopeks: intent.amountKopeks,
          description: "Оплата (вебхук провайдера)",
        });
      }
      return;
    }
    case "refunded": {
      const completedRefunds = await tx.select().from(refunds).where(and(
        eq(refunds.organizationId, intent.organizationId),
        eq(refunds.paymentIntentId, intent.id),
        eq(refunds.state, "completed"),
      ));
      const refunded = completedRefunds.reduce((acc, row) => acc + row.amountKopeks, 0);
      if (!refunded) return;
      for (const refundRow of completedRefunds) {
        await postRefundJournalTx(tx, {
          organizationId: intent.organizationId,
          sourceId: refundRow.id,
          amountKopeks: refundRow.amountKopeks,
          description: `Возврат: ${refundRow.reason}`,
          reversalOf: intent.id,
        });
      }
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
