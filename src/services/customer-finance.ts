import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assertRole, type Principal } from "../core/context.js";

/**
 * The customer's own money view: what they have spent, what they still owe, what was refunded,
 * and where the money went.
 *
 * Scoped hard to `principal.userId` and to the caller's tenant. A customer can only ever see
 * their own rows, and a non-customer role is refused outright rather than being handed an empty
 * dashboard.
 *
 * "What they owe" is computed exactly the same way as in `finance-analytics.ts`: an invoice stays
 * a receivable until it is collected in full, and a refund creates a credit rather than driving
 * the receivable negative.
 */

export type CustomerOrderLedgerRow = {
  orderId: string;
  publicNumber: string;
  lifecycleState: string;
  createdAt: string;
  invoiceNumber: string | null;
  chargedKopeks: number;
  capturedKopeks: number;
  refundedKopeks: number;
  netPaidKopeks: number;
  outstandingKopeks: number;
  sharedWindowSavingsKopeks: number;
};

export type CustomerFinance = {
  currency: "RUB";
  totals: {
    orderCount: number;
    chargedKopeks: number;
    netPaidKopeks: number;
    refundedKopeks: number;
    outstandingKopeks: number;
    creditKopeks: number;
    averageOrderKopeks: number;
    sharedWindowSavingsKopeks: number;
  };
  byService: Array<{ serviceId: string; serviceName: string; unit: string; tier: "economy" | "protected"; orderCount: number; quantity: number; amountKopeks: number }>;
  byTier: Array<{ tier: "economy" | "protected"; orderCount: number; amountKopeks: number }>;
  orders: CustomerOrderLedgerRow[];
};

type OrderRow = {
  order_id: string;
  public_number: string;
  lifecycle_state: string;
  created_at: Date;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_total_kopeks: string | null;
  invoice_state: string | null;
  captured_kopeks: string | null;
  refunded_kopeks: string | null;
  off_pickup_kopeks: string | null;
  off_delivery_kopeks: string | null;
  fee_lines: Array<{ kind: string; source: string; amount_kopeks: string }> | null;
};

type ServiceRow = {
  service_id: string;
  service_name: string;
  unit: string;
  tier: "economy" | "protected";
  order_count: string;
  quantity: string;
  amount_kopeks: string;
};

type TierRow = {
  tier: "economy" | "protected";
  order_count: string;
  amount_kopeks: string;
};

export async function customerFinance(db: Db, principal: Principal): Promise<CustomerFinance> {
  assertRole(principal, "customer");
  const organizationId = principal.organizationId;
  const customerId = principal.userId;

  const [orderResult, serviceResult, tierResult] = await Promise.all([
    db.execute(sql`
      SELECT
        o.id                     AS order_id,
        o.public_number          AS public_number,
        o.lifecycle_state        AS lifecycle_state,
        o.created_at             AS created_at,
        i.id                     AS invoice_id,
        i.number                 AS invoice_number,
        i.total_kopeks           AS invoice_total_kopeks,
        i.state                  AS invoice_state,
        COALESCE(p.captured, 0)  AS captured_kopeks,
        COALESCE(r.refunded, 0)  AS refunded_kopeks,
        COALESCE(tv.off_schedule_pickup_kopeks, 0)   AS off_pickup_kopeks,
        COALESCE(tv.off_schedule_delivery_kopeks, 0) AS off_delivery_kopeks,
        (
          SELECT json_agg(json_build_object('kind', il.kind, 'source', il.source, 'amount_kopeks', il.amount_kopeks))
          FROM customer_invoice_lines il
          WHERE il.invoice_id = i.id AND il.kind IN ('pickup_fee', 'delivery_fee')
        ) AS fee_lines
      FROM orders o
      LEFT JOIN customer_invoices i
        ON i.order_id = o.id AND i.organization_id = o.organization_id
      LEFT JOIN quotes q ON q.id = o.quote_id
      LEFT JOIN tariff_versions tv ON tv.id = q.tariff_version_id
      LEFT JOIN LATERAL (
        SELECT SUM(amount_kopeks) AS captured
        FROM payment_intents pi
        WHERE pi.order_id = o.id
          AND pi.organization_id = o.organization_id
          AND pi.state IN ('captured', 'partially_refunded', 'refunded')
      ) p ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(rf.amount_kopeks) AS refunded
        FROM refunds rf
        JOIN payment_intents pi ON pi.id = rf.payment_intent_id
        WHERE pi.order_id = o.id
          AND rf.organization_id = o.organization_id
          AND rf.state = 'completed'
      ) r ON TRUE
      WHERE o.organization_id = ${organizationId}
        AND o.customer_id = ${customerId}
      ORDER BY o.created_at DESC
    `),
    db.execute(sql`
      SELECT
        ol.service_id            AS service_id,
        s.name                   AS service_name,
        s.unit                   AS unit,
        ol.tier                  AS tier,
        COUNT(DISTINCT ol.order_id) AS order_count,
        COALESCE(SUM(ol.quoted_quantity), 0) AS quantity,
        COALESCE(SUM(ol.quoted_amount_kopeks), 0) AS amount_kopeks
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN services s ON s.id = ol.service_id
      WHERE o.organization_id = ${organizationId}
        AND o.customer_id = ${customerId}
      GROUP BY ol.service_id, s.name, s.unit, ol.tier
      ORDER BY amount_kopeks DESC
    `),
    db.execute(sql`
      SELECT
        ol.tier                             AS tier,
        COUNT(DISTINCT ol.order_id)::int   AS order_count,
        COALESCE(SUM(ol.quoted_amount_kopeks), 0) AS amount_kopeks
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      WHERE o.organization_id = ${organizationId}
        AND o.customer_id = ${customerId}
      GROUP BY ol.tier
    `),
  ]);

  const orderRows = orderResult.rows as unknown as OrderRow[];
  const serviceRows = serviceResult.rows as unknown as ServiceRow[];
  const tierRows = tierResult.rows as unknown as TierRow[];

  let chargedKopeks = 0;
  let netPaidKopeks = 0;
  let refundedKopeks = 0;
  let outstandingKopeks = 0;
  let creditKopeks = 0;
  let sharedWindowSavingsKopeks = 0;

  const orders: CustomerOrderLedgerRow[] = orderRows.map(row => {
    const total = Number(row.invoice_total_kopeks ?? 0);
    const captured = Number(row.captured_kopeks ?? 0);
    const refunded = Number(row.refunded_kopeks ?? 0);
    const net = captured - refunded;
    const outstanding = Math.max(0, total - net);
    const credit = Math.max(0, net - total);

    chargedKopeks += total;
    netPaidKopeks += net;
    refundedKopeks += refunded;
    outstandingKopeks += outstanding;
    creditKopeks += credit;

    // A shared group window costs 0 ₽; the off-schedule leg it replaced costs the tariff fee.
    // The saving is what the customer avoided by taking the group window.
    let savings = 0;
    for (const line of row.fee_lines ?? []) {
      if (line.source !== "tariff") continue;
      if (Number(line.amount_kopeks) !== 0) continue;
      if (line.kind === "pickup_fee") savings += Number(row.off_pickup_kopeks ?? 0);
      if (line.kind === "delivery_fee") savings += Number(row.off_delivery_kopeks ?? 0);
    }
    sharedWindowSavingsKopeks += savings;

    return {
      orderId: row.order_id,
      publicNumber: row.public_number,
      lifecycleState: row.lifecycle_state,
      createdAt: new Date(row.created_at).toISOString(),
      invoiceNumber: row.invoice_number,
      chargedKopeks: total,
      capturedKopeks: captured,
      refundedKopeks: refunded,
      netPaidKopeks: net,
      outstandingKopeks: outstanding,
      sharedWindowSavingsKopeks: savings,
    };
  });

  const tierMap = new Map<string, { orderCount: number; amountKopeks: number }>();
  for (const row of tierRows) {
    const tier = row.tier === "protected" ? "protected" : "economy";
    tierMap.set(tier, {
      orderCount: Number(row.order_count ?? 0),
      amountKopeks: Number(row.amount_kopeks ?? 0),
    });
  }

  const paidOrderCount = orderRows.filter(row => row.invoice_id).length;

  return {
    currency: "RUB",
    totals: {
      orderCount: orderRows.length,
      chargedKopeks,
      netPaidKopeks,
      refundedKopeks,
      outstandingKopeks,
      creditKopeks,
      averageOrderKopeks: paidOrderCount > 0 ? Math.round(chargedKopeks / paidOrderCount) : 0,
      sharedWindowSavingsKopeks,
    },
    byService: serviceRows.map(row => ({
      serviceId: row.service_id,
      serviceName: row.service_name,
      unit: row.unit,
      tier: row.tier === "protected" ? "protected" : "economy",
      orderCount: Number(row.order_count ?? 0),
      quantity: Number(row.quantity ?? 0),
      amountKopeks: Number(row.amount_kopeks ?? 0),
    })),
    byTier: (["economy", "protected"] as const).map(tier => ({
      tier,
      orderCount: tierMap.get(tier)?.orderCount ?? 0,
      amountKopeks: tierMap.get(tier)?.amountKopeks ?? 0,
    })),
    orders,
  };
}
