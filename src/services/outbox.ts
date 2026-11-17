import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notifications, orders, outboxEvents } from "../db/schema.js";

const MAX_ATTEMPTS = 5;

/**
 * Customer-visible outbox events and the notification template each one produces. An event type
 * absent from this map is informational and is marked processed without a notification; the
 * screens that already write `notifications` directly (intake, delivery) are deliberately not in
 * the map so their customers never receive a duplicate.
 */
const EVENT_TEMPLATES: Record<string, string> = {
  "order.confirmed": "order_confirmed",
  "order.scheduled": "order_scheduled",
  "order.cancelled": "order_cancelled",
  "order.rescheduled": "order_rescheduled",
  "order.partner_assigned": "order_partner_assigned",
  "order.partner_receive": "order_partner_receive",
  "order.propose_change": "order_propose_change",
  "order.approve_change": "order_approve_change",
  "order.decline_change": "order_decline_change",
  "order.return_unprocessed": "order_return_unprocessed",
  "order.qc_passed": "order_qc_passed",
  "order.qc_failed": "order_qc_failed",
  "invoice.created": "invoice_created",
  "payment.captured": "payment_captured",
  "payment.refunded": "payment_refunded",
  "claim.opened": "claim_opened",
  "claim.decided": "claim_decided",
  "delivery.failed": "delivery_failed",
  "delivery.partial": "delivery_partial",
};

/**
 * Leased outbox drain: rows are claimed with FOR UPDATE SKIP LOCKED so concurrent workers never
 * turn one domain event into two notifications. A row whose order cannot be resolved keeps its
 * attempt count and error instead of disappearing.
 */
export async function processOutbox(db: Db, input: { limit?: number } = {}) {
  const limit = Math.min(input.limit ?? 100, 500);
  return db.transaction(async tx => {
    const claimed = await tx.execute(sql`
      UPDATE outbox_events SET state = 'processing', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE state = 'pending' AND attempts < ${MAX_ATTEMPTS}
        ORDER BY available_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organization_id AS "organizationId", event_type AS "eventType",
                payload_json AS payload, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId"
    `);
    const rows = claimed.rows as unknown as Array<{
      id: string; organizationId: string; eventType: string; payload: Record<string, unknown>;
      aggregateType: string; aggregateId: string;
    }>;
    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const template = EVENT_TEMPLATES[row.eventType];
        if (template) {
          const orderId = row.aggregateType === "order"
            ? row.aggregateId
            : typeof row.payload?.orderId === "string" ? row.payload.orderId : null;
          if (!orderId) throw new Error("ORDER_UNRESOLVABLE");
          const [order] = await tx.select({ customerId: orders.customerId }).from(orders).where(and(
            eq(orders.id, orderId),
            eq(orders.organizationId, row.organizationId),
          )).limit(1);
          if (!order) throw new Error("ORDER_NOT_FOUND");
          await tx.insert(notifications).values({
            organizationId: row.organizationId,
            recipientId: order.customerId,
            orderId,
            channel: "push",
            template,
            payloadJson: { eventId: row.id, ...row.payload },
            dedupeKey: `outbox:${row.id}`,
          }).onConflictDoNothing();
        }
        await tx.update(outboxEvents)
          .set({ state: "processed", error: null })
          .where(eq(outboxEvents.id, row.id));
        processed += 1;
      } catch (error) {
        await tx.update(outboxEvents)
          .set({ state: "failed", error: (error as Error)?.message ?? "UNKNOWN" })
          .where(eq(outboxEvents.id, row.id));
        failed += 1;
      }
    }
    return { claimed: rows.length, processed, failed };
  });
}

/** Re-arms failed events with remaining attempts; used by the worker loop. */
export async function requeueFailedOutboxEvents(db: Db, input: { limit?: number } = {}) {
  const limit = Math.min(input.limit ?? 100, 500);
  const rows = await db.execute(sql`
    UPDATE outbox_events SET state = 'pending', error = NULL
    WHERE id IN (
      SELECT id FROM outbox_events
      WHERE state = 'failed' AND attempts < ${MAX_ATTEMPTS}
      ORDER BY available_at ASC
      LIMIT ${limit}
    )
    RETURNING id
  `);
  return { requeued: (rows.rows as unknown[]).length };
}
