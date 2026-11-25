import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { assertRole, hasRole, type Principal, type Role, ROLE_GROUPS } from "../core/context.js";

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
  /**
   * The customer's phone. Masked (`+7999•••0103`) for every role that has no need to dial it;
   * the full number is handed out only to the roles that actually call the customer.
   */
  phone: string | null;
  /** True when `phone` is masked and not the real number. */
  phoneMasked: boolean;
  failedAttempts: number;
  lastOutcome: string;
  lastAttemptAt: string;
  orderCount: number;
};

export type ChurnSignal = {
  windowDays: number;
  threshold: number;
  atRisk: ChurnRisk[];
  /** True when every phone in `atRisk` is masked. */
  phoneMasked: boolean;
  note: string;
};

/**
 * The roles that pick up the phone and call the customer about the failed delivery. Every other
 * role reads the signal with the number masked: the signal says who to call, it is not a
 * directory of everybody's phone number.
 */
const CHURN_PHONE_ROLES: Role[] = ["dispatcher", "customer_support"];

/**
 * Masks a phone number, keeping the country and operator prefix and the last four digits:
 * `+79990000103` becomes `+7999•••0103`.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return `+${"•".repeat(Math.max(digits.length, 3))}`;
  const head = digits.slice(0, 4);
  const tail = digits.slice(-4);
  return `+${head}${"•".repeat(digits.length - 8)}${tail}`;
}

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
  // The number is personal data of somebody who never asked for it: it is masked unless the
  // caller is one of the roles that has to dial the customer.
  const phoneMasked = !hasRole(principal, ...CHURN_PHONE_ROLES);
  const atRisk: ChurnRisk[] = rows.map(row => ({
    customerId: row.customer_id,
    displayName: row.display_name ?? "",
    phone: phoneMasked ? maskPhone(row.phone) : (row.phone ?? null),
    phoneMasked,
    failedAttempts: Number(row.failed_attempts ?? 0),
    lastOutcome: row.last_outcome ?? "",
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : "",
    orderCount: Number(row.order_count ?? 0),
  }));

  // Reading the signal is itself an access to personal data: it is written down who looked at
  // which customers, so the access can be reviewed afterwards.
  await db.insert(auditEvents).values({
    organizationId: principal.organizationId,
    actorId: principal.userId,
    action: "privacy.churn_read",
    resourceType: "churn_signal",
    resourceId: null,
    scopeJson: {
      customerIds: atRisk.map(risk => risk.customerId),
      count: atRisk.length,
      windowDays: days,
      threshold,
      phoneMasked,
    },
    requestId: principal.requestId,
  });

  return {
    windowDays: days,
    threshold,
    atRisk,
    phoneMasked,
    note: "Сигнал оттока: клиенты, у которых доставка не состоялась дважды и больше за период. Причина — недовыполненная доставка, а не жалоба.",
  };
}
