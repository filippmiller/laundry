import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notifications, orders, outboxEvents } from "../db/schema.js";

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BACKOFF_BASE_MS = 5_000;
export const OUTBOX_BACKOFF_CAP_MS = 3_600_000; // 1 hour

export type OutboxDeliveryRequest = {
  eventId: string;
  organizationId: string;
  recipientId: string;
  orderId: string;
  channel: string;
  template: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

export type OutboxDeliveryResult = {
  receiptId: string;
  deliveredAt?: Date;
};

export type OutboxDeliverFn = (req: OutboxDeliveryRequest) => Promise<OutboxDeliveryResult>;

export function computeOutboxBackoffMs(
  attempts: number,
  baseMs = OUTBOX_BACKOFF_BASE_MS,
  capMs = OUTBOX_BACKOFF_CAP_MS,
): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(baseMs * (2 ** exponent), capMs);
}

const defaultDeliver: OutboxDeliverFn = async req => ({
  receiptId: `local:${req.dedupeKey}`,
  deliveredAt: new Date(),
});

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

type ClaimedOutboxRow = {
  id: string;
  organizationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  aggregateType: string;
  aggregateId: string;
  attempts: number;
  providerReceipt: string | null;
};

/**
 * Leased outbox drain: rows with `available_at <= now` are claimed with FOR UPDATE SKIP LOCKED
 * so concurrent workers never turn one domain event into two notifications. Each event tracks
 * external delivery state (`delivery_status`, `provider_receipt`, `delivered_at`), applies
 * bounded exponential backoff on failure, and moves exhausted events to `dead_letter`.
 */
export async function processOutbox(
  db: Db,
  input: {
    limit?: number;
    organizationId?: string;
    now?: Date;
    maxAttempts?: number;
    backoffBaseMs?: number;
    backoffCapMs?: number;
    paused?: boolean;
    deliver?: OutboxDeliverFn;
  } = {},
) {
  if (input.paused || process.env.OUTBOX_PAUSED === "true") {
    return { claimed: 0, processed: 0, failed: 0, deadLettered: 0, paused: true as const };
  }
  const limit = Math.min(input.limit ?? 100, 500);
  const now = input.now ?? new Date();
  const maxAttempts = input.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  const backoffBaseMs = input.backoffBaseMs ?? OUTBOX_BACKOFF_BASE_MS;
  const backoffCapMs = input.backoffCapMs ?? OUTBOX_BACKOFF_CAP_MS;
  const deliver = input.deliver ?? defaultDeliver;
  const orgFilter = input.organizationId ? sql`AND organization_id = ${input.organizationId}` : sql``;

  const rows = await db.transaction(async tx => {
    const claimed = await tx.execute(sql`
      UPDATE outbox_events SET state = 'processing', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE state = 'pending'
          AND available_at <= ${now}
          AND attempts < ${maxAttempts}
          ${orgFilter}
        ORDER BY available_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organization_id AS "organizationId", event_type AS "eventType",
                payload_json AS payload, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId",
                attempts, provider_receipt AS "providerReceipt"
    `);
    return claimed.rows as unknown as ClaimedOutboxRow[];
  });

  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const row of rows) {
    try {
      const template = EVENT_TEMPLATES[row.eventType];
      if (template) {
        const orderId = row.aggregateType === "order"
          ? row.aggregateId
          : typeof row.payload?.orderId === "string" ? row.payload.orderId : null;
        if (!orderId) throw new Error("ORDER_UNRESOLVABLE");
        const [order] = await db.select({ customerId: orders.customerId }).from(orders).where(and(
          eq(orders.id, orderId),
          eq(orders.organizationId, row.organizationId),
        )).limit(1);
        if (!order) throw new Error("ORDER_NOT_FOUND");
        const dedupeKey = `outbox:${row.id}`;

        // Idempotent provider receipt recording: if already delivered with a receipt, do not re-send.
        let receiptId = row.providerReceipt;
        let deliveredAt = new Date();
        if (!receiptId) {
          const delivery = await deliver({
            eventId: row.id,
            organizationId: row.organizationId,
            recipientId: order.customerId,
            orderId,
            channel: "push",
            template,
            dedupeKey,
            payload: { eventId: row.id, ...row.payload },
          });
          if (!delivery.receiptId || !delivery.receiptId.trim()) {
            throw new Error("PROVIDER_RECEIPT_MISSING");
          }
          receiptId = delivery.receiptId.trim();
          deliveredAt = delivery.deliveredAt ?? new Date();
        }

        await db.transaction(async tx => {
          await tx.insert(notifications).values({
            organizationId: row.organizationId,
            recipientId: order.customerId,
            orderId,
            channel: "push",
            template,
            payloadJson: { eventId: row.id, ...row.payload },
            dedupeKey,
            state: "sent",
          }).onConflictDoNothing();
          await tx.update(outboxEvents)
            .set({
              state: "processed",
              deliveryStatus: "delivered",
              providerReceipt: receiptId,
              deliveredAt,
              error: null,
            })
            .where(eq(outboxEvents.id, row.id));
        });
      } else {
        await db.update(outboxEvents)
          .set({
            state: "processed",
            deliveryStatus: "skipped",
            error: null,
          })
          .where(eq(outboxEvents.id, row.id));
      }
      processed += 1;
    } catch (error) {
      const message = (error as Error)?.message ?? "UNKNOWN";
      const exhausted = row.attempts >= maxAttempts;
      if (exhausted) {
        await db.update(outboxEvents)
          .set({
            state: "dead_letter",
            deliveryStatus: "dead_letter",
            error: message,
          })
          .where(eq(outboxEvents.id, row.id));
        deadLettered += 1;
      } else {
        const backoffMs = computeOutboxBackoffMs(row.attempts, backoffBaseMs, backoffCapMs);
        const nextAvailableAt = new Date(now.getTime() + backoffMs);
        await db.update(outboxEvents)
          .set({
            state: "failed",
            deliveryStatus: "failed",
            availableAt: nextAvailableAt,
            error: message,
          })
          .where(eq(outboxEvents.id, row.id));
        failed += 1;
      }
    }
  }
  return { claimed: rows.length, processed, failed, deadLettered, paused: false as const };
}

/**
 * Re-arms failed events with remaining attempts while preserving their backoff `available_at`
 * schedule (so `processOutbox` will not claim them until `available_at <= now()`).
 * Pass `{ forceImmediate: true }` for explicit admin requeue, and `{ includeDeadLetter: true }`
 * to rescue dead-lettered rows with reset attempts.
 */
export async function requeueFailedOutboxEvents(
  db: Db,
  input: {
    limit?: number;
    organizationId?: string;
    now?: Date;
    onlyDue?: boolean;
    forceImmediate?: boolean;
    includeDeadLetter?: boolean;
    maxAttempts?: number;
  } = {},
) {
  const limit = Math.min(input.limit ?? 100, 500);
  const now = input.now ?? new Date();
  const maxAttempts = input.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  const orgFilter = input.organizationId ? sql`AND organization_id = ${input.organizationId}` : sql``;

  if (input.includeDeadLetter) {
    const rows = await db.execute(sql`
      UPDATE outbox_events
      SET state = 'pending',
          delivery_status = 'queued',
          attempts = 0,
          error = NULL,
          available_at = ${now}
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE state = 'dead_letter'
          ${orgFilter}
        ORDER BY available_at ASC
        LIMIT ${limit}
      )
      RETURNING id
    `);
    return { requeued: (rows.rows as unknown[]).length };
  }

  const dueFilter = input.onlyDue ? sql`AND available_at <= ${now}` : sql``;
  const availableExpr = input.forceImmediate ? sql`${now}` : sql`available_at`;

  const rows = await db.execute(sql`
    UPDATE outbox_events
    SET state = 'pending',
        delivery_status = 'queued',
        error = NULL,
        available_at = ${availableExpr}
    WHERE id IN (
      SELECT id FROM outbox_events
      WHERE state = 'failed'
        AND attempts < ${maxAttempts}
        ${dueFilter}
        ${orgFilter}
      ORDER BY available_at ASC
      LIMIT ${limit}
    )
    RETURNING id
  `);
  return { requeued: (rows.rows as unknown[]).length };
}
