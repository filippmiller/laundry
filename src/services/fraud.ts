import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assertRole, type Principal } from "../core/context.js";

/**
 * Read-only fraud/abuse signals. These never block a customer or a payment on their own;
 * they produce a review queue for a human. Every signal is scoped to one tenant.
 */
export type FraudSignal = {
  kind: string;
  severity: "low" | "medium" | "high";
  subjectType: "customer" | "courier" | "order" | "device";
  subjectId: string;
  facts: Record<string, unknown>;
  recommendation: "manual_review";
};

const FRAUD_ROLES = [
  "platform_admin", "security_auditor", "claims_investigator", "platform_finance",
] as const;

export async function fraudSignals(db: Db, principal: Principal, input: { limit?: number } = {}): Promise<FraudSignal[]> {
  assertRole(principal, ...FRAUD_ROLES);
  const org = principal.organizationId;
  const limit = Math.min(input.limit ?? 50, 200);

  const claimVelocity = await db.execute(sql`
    SELECT c.opened_by AS "subjectId", count(*)::int AS "claims",
           max(c.opened_at) AS "lastClaimAt"
    FROM claims c
    WHERE c.organization_id = ${org} AND c.opened_at > now() - interval '90 days'
    GROUP BY c.opened_by
    HAVING count(*) >= 3
    ORDER BY count(*) DESC
    LIMIT ${limit}
  `);

  const refundsWithoutDelivery = await db.execute(sql`
    SELECT o.id AS "subjectId", o.public_number AS "publicNumber",
           sum(r.amount_kopeks)::bigint AS "refundedKopeks", o.lifecycle_state AS "state"
    FROM refunds r
    JOIN payment_intents pi ON pi.id = r.payment_intent_id
    JOIN orders o ON o.id = pi.order_id
    WHERE o.organization_id = ${org}
      AND r.state = 'completed'
      AND o.lifecycle_state NOT IN ('delivered', 'closed')
      AND NOT EXISTS (
        SELECT 1 FROM delivery_attempts d
        WHERE d.order_id = o.id AND d.outcome IN ('delivered', 'partial')
      )
    GROUP BY o.id, o.public_number, o.lifecycle_state
    ORDER BY sum(r.amount_kopeks) DESC
    LIMIT ${limit}
  `);

  const sharedDevices = await db.execute(sql`
    SELECT s.device_id AS "subjectId", count(DISTINCT s.actor_id)::int AS "actors",
           min(s.captured_at) AS "firstSeenAt", max(s.captured_at) AS "lastSeenAt"
    FROM scan_events s
    WHERE s.organization_id = ${org} AND s.captured_at > now() - interval '30 days'
    GROUP BY s.device_id
    HAVING count(DISTINCT s.actor_id) > 1
    ORDER BY count(DISTINCT s.actor_id) DESC
    LIMIT ${limit}
  `);

  const repeatedPartial = await db.execute(sql`
    SELECT d.order_id AS "subjectId", count(*)::int AS "partialAttempts", o.public_number AS "publicNumber"
    FROM delivery_attempts d
    JOIN orders o ON o.id = d.order_id
    WHERE o.organization_id = ${org} AND d.outcome = 'partial'
    GROUP BY d.order_id, o.public_number
    HAVING count(*) >= 2
    ORDER BY count(*) DESC
    LIMIT ${limit}
  `);

  const cancelVelocity = await db.execute(sql`
    SELECT o.customer_id AS "subjectId", count(*)::int AS "cancellations"
    FROM orders o
    WHERE o.organization_id = ${org}
      AND o.lifecycle_state = 'cancelled'
      AND o.created_at > now() - interval '30 days'
    GROUP BY o.customer_id
    HAVING count(*) >= 3
    ORDER BY count(*) DESC
    LIMIT ${limit}
  `);

  const signals: FraudSignal[] = [];
  for (const row of claimVelocity.rows as Array<Record<string, unknown>>) {
    signals.push({
      kind: "claim_velocity", severity: "medium", subjectType: "customer",
      subjectId: String(row.subjectId), facts: { claims: Number(row.claims), windowDays: 90, lastClaimAt: row.lastClaimAt },
      recommendation: "manual_review",
    });
  }
  for (const row of refundsWithoutDelivery.rows as Array<Record<string, unknown>>) {
    signals.push({
      kind: "refund_without_delivery", severity: "high", subjectType: "order",
      subjectId: String(row.subjectId),
      facts: { publicNumber: row.publicNumber, refundedKopeks: Number(row.refundedKopeks), state: row.state },
      recommendation: "manual_review",
    });
  }
  for (const row of sharedDevices.rows as Array<Record<string, unknown>>) {
    signals.push({
      kind: "shared_devices", severity: "medium", subjectType: "device",
      subjectId: String(row.subjectId),
      facts: { actors: Number(row.actors), firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt },
      recommendation: "manual_review",
    });
  }
  for (const row of repeatedPartial.rows as Array<Record<string, unknown>>) {
    signals.push({
      kind: "repeated_partial_delivery", severity: "low", subjectType: "order",
      subjectId: String(row.subjectId),
      facts: { partialAttempts: Number(row.partialAttempts), publicNumber: row.publicNumber },
      recommendation: "manual_review",
    });
  }
  for (const row of cancelVelocity.rows as Array<Record<string, unknown>>) {
    signals.push({
      kind: "cancel_velocity", severity: "low", subjectType: "customer",
      subjectId: String(row.subjectId), facts: { cancellations: Number(row.cancellations), windowDays: 30 },
      recommendation: "manual_review",
    });
  }
  return signals;
}
