import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";

/**
 * "This customer is about to leave."
 *
 * A failed delivery is the loudest signal a laundry has: the courier stood at the
 * door and nobody took the parcel. One miss is a coincidence, two or three in a row
 * is a customer who is already gone. This service counts the misses per customer and
 * puts the accounts that need a phone call on top of the list.
 *
 * The counter counts only what really happened — the delivery attempts recorded by the
 * courier — and it never guesses who is "at risk" beyond the number of failures.
 */

/** The outcomes that mean the customer did not get the parcel. */
export const FAILED_DELIVERY_OUTCOMES = ["recipient_unavailable", "wrong_recipient", "refused"] as const;

export type ChurnRisk = {
  customerId: string;
  displayName: string;
  phone: string | null;
  failedAttempts: number;
  lastOutcome: string;
  lastAttemptAt: string;
  orderCount: number;
};

export type ChurnSignal = {
  windowDays: number;
  threshold: number;
  atRisk: ChurnRisk[];
  note: string;
};

const DAY_MS = 86_400_000;

type ChurnRow = {
  customer_id: string;
  display_name: string | null;
  phone: string | null;
  failed_attempts: string;
  last_outcome: string | null;
  last_attempt_at: string | null;
  order_count: string;
};

/**
 * The customers whose deliveries keep failing over the window.
 */
export async function churnSignal(
  db: Db,
  principal: Principal,
  input: { days?: number; threshold?: number } = {},
): Promise<ChurnSignal> {
  assertRole(principal, ...ROLE_GROUPS.dispatcher, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin, ...ROLE_GROUPS.support);
  const organizationId = principal.organizationId;
  const days = Math.min(Math.max(Math.trunc(input.days ?? 90), 1), 365);
  const threshold = Math.min(Math.max(Math.trunc(input.threshold ?? 2), 1), 20);
  const since = new Date(Date.now() - days * DAY_MS);

  const result = await db.execute(sql`
    SELECT o.customer_id::text                                   AS customer_id,
           u.display_name                                        AS display_name,
           u.phone                                               AS phone,
           COUNT(*)::int                                         AS failed_attempts,
           (ARRAY_AGG(da.outcome ORDER BY da.occurred_at DESC))[1] AS last_outcome,
           MAX(da.occurred_at)                                   AS last_attempt_at,
           COUNT(DISTINCT da.order_id)::int                      AS order_count
    FROM delivery_attempts da
    JOIN orders o ON o.id = da.order_id AND o.organization_id = da.organization_id
    JOIN users u ON u.id = o.customer_id
    WHERE da.organization_id = ${organizationId}
      AND da.occurred_at >= ${since}
      AND da.outcome IN ('recipient_unavailable', 'wrong_recipient', 'refused')
    GROUP BY o.customer_id, u.display_name, u.phone
    HAVING COUNT(*) >= ${threshold}
    ORDER BY COUNT(*) DESC, MAX(da.occurred_at) DESC
  `);

  const rows = (result.rows ?? []) as unknown as ChurnRow[];
  const atRisk: ChurnRisk[] = rows.map(row => ({
    customerId: row.customer_id,
    displayName: row.display_name ?? "",
    phone: row.phone ?? null,
    failedAttempts: Number(row.failed_attempts ?? 0),
    lastOutcome: row.last_outcome ?? "",
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : "",
    orderCount: Number(row.order_count ?? 0),
  }));

  return {
    windowDays: days,
    threshold,
    atRisk,
    note: "Сигнал оттока: клиенты, у которых доставка не состоялась дважды и больше за период. Причина — недовыполненная доставка, а не жалоба.",
  };
}
