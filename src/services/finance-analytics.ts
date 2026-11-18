import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assertRole, type Principal, ROLE_GROUPS } from "../core/context.js";

/**
 * Financial analytics for the tenant: what customers owe us, what we owe partners, and what the
 * book of business looks like right now.
 *
 * Every number is derived from live rows of the caller's own tenant. Nothing is estimated, nothing
 * is cached, and no figure is fabricated: an empty tenant reports zeros, not a plausible-looking
 * demo number.
 *
 * Money is integer kopeks throughout. The signed conventions are:
 *
 * - an invoice is **receivable** until it is collected in full; a refund creates a **credit**
 *   (we owe the customer back) rather than reducing the receivable below zero;
 * - a partner accrual is **payable** until a payout is scheduled for it;
 * - a disputed accrual is **not** payable — it is held out of the payable total and reported
 *   separately, because a disputed line may never become a debt at all;
 * - the margin reported here is a contribution **before courier cost**, because the platform has
 *   no courier cost field yet. It is labelled as such everywhere it is shown.
 */

export type AgingBucket = {
  key: "d0_7" | "d8_30" | "d31_90" | "d90_plus";
  label: string;
  invoiceCount: number;
  receivableKopeks: number;
};

export type ReceivableRow = {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  publicNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  invoiceTotalKopeks: number;
  capturedKopeks: number;
  refundedKopeks: number;
  netCollectedKopeks: number;
  receivableKopeks: number;
  creditKopeks: number;
  ageDays: number;
  issuedAt: string;
};

export type PartnerPayableRow = {
  partnerId: string;
  partnerName: string;
  accruedKopeks: number;
  invoicedKopeks: number;
  estimatedKopeks: number;
  disputedKopeks: number;
  paidKopeks: number;
  payableKopeks: number;
};

export type MonthPoint = {
  month: string;
  invoicedKopeks: number;
  netCollectedKopeks: number;
};

export type FinanceAnalytics = {
  currency: "RUB";
  receivables: {
    invoicedKopeks: number;
    netCollectedKopeks: number;
    refundedKopeks: number;
    receivableKopeks: number;
    creditKopeks: number;
    invoiceCount: number;
    aging: AgingBucket[];
    openInvoices: ReceivableRow[];
    topDebtors: Array<{
      customerId: string;
      customerName: string;
      customerPhone: string | null;
      receivableKopeks: number;
      invoiceCount: number;
    }>;
  };
  payables: {
    accruedKopeks: number;
    estimatedKopeks: number;
    invoicedKopeks: number;
    disputedKopeks: number;
    paidKopeks: number;
    payableKopeks: number;
    partners: PartnerPayableRow[];
  };
  margin: {
    netCollectedKopeks: number;
    partnerCogsKopeks: number;
    contributionKopeks: number;
    takeRate: number | null;
    note: string;
  };
  exposure: {
    adjustmentsPendingConsentKopeks: number;
    compensationsProposedKopeks: number;
    compensationsApprovedKopeks: number;
    chargebackAtRiskKopeks: number;
  };
  monthly: MonthPoint[];
};

const AGING_BUCKETS: Array<{ key: AgingBucket["key"]; label: string; maxDays: number }> = [
  { key: "d0_7", label: "до 7 дней", maxDays: 7 },
  { key: "d8_30", label: "8–30 дней", maxDays: 30 },
  { key: "d31_90", label: "31–90 дней", maxDays: 90 },
  { key: "d90_plus", label: "более 90 дней", maxDays: Number.POSITIVE_INFINITY },
];

function bucketFor(ageDays: number): AgingBucket["key"] {
  for (const bucket of AGING_BUCKETS) {
    if (ageDays <= bucket.maxDays) return bucket.key;
  }
  return "d90_plus";
}

function daysSince(iso: string, now: Date): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

type InvoiceSqlRow = {
  invoice_id: string;
  invoice_number: string;
  order_id: string;
  public_number: string;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  invoice_total_kopeks: string;
  captured_kopeks: string | null;
  refunded_kopeks: string | null;
  created_at: Date;
};

type AccrualSqlRow = {
  partner_id: string;
  partner_name: string | null;
  status: string;
  disputed: boolean;
  total_kopeks: string;
};

type PayoutSqlRow = {
  partner_id: string;
  total_kopeks: string;
};

type AdjustmentSqlRow = { total_kopeks: string | null };
type CompensationSqlRow = { state: string; total_kopeks: string | null };
type ChargebackSqlRow = { total_kopeks: string | null };
type MonthSqlRow = { month: string; invoiced_kopeks: string; net_collected_kopeks: string };

/**
 * Tenant-scoped financial analytics. Finance and admin roles only — a customer has their own,
 * narrower view in `customerFinance`.
 */
export async function financeAnalytics(db: Db, principal: Principal): Promise<FinanceAnalytics> {
  assertRole(principal, ...ROLE_GROUPS.finance, ...ROLE_GROUPS.admin);
  const organizationId = principal.organizationId;
  const now = new Date();

  const [invoiceResult, accrualResult, payoutResult, adjustmentResult, compensationResult, chargebackResult, monthResult] =
    await Promise.all([
      db.execute(sql`
        SELECT
          i.id                     AS invoice_id,
          i.number                 AS invoice_number,
          o.id                     AS order_id,
          o.public_number          AS public_number,
          o.customer_id            AS customer_id,
          u.display_name           AS customer_name,
          u.phone                  AS customer_phone,
          i.total_kopeks           AS invoice_total_kopeks,
          COALESCE(p.captured, 0)  AS captured_kopeks,
          COALESCE(r.refunded, 0)  AS refunded_kopeks,
          i.created_at             AS created_at
        FROM customer_invoices i
        JOIN orders o
          ON o.id = i.order_id AND o.organization_id = i.organization_id
        LEFT JOIN users u ON u.id = o.customer_id
        LEFT JOIN LATERAL (
          SELECT SUM(amount_kopeks) AS captured
          FROM payment_intents pi
          WHERE pi.order_id = i.order_id
            AND pi.organization_id = i.organization_id
            AND pi.state IN ('captured', 'partially_refunded', 'refunded')
        ) p ON TRUE
        LEFT JOIN LATERAL (
          SELECT SUM(rf.amount_kopeks) AS refunded
          FROM refunds rf
          JOIN payment_intents pi ON pi.id = rf.payment_intent_id
          WHERE pi.order_id = i.order_id
            AND rf.organization_id = i.organization_id
            AND rf.state = 'completed'
        ) r ON TRUE
        WHERE i.organization_id = ${organizationId}
          AND i.state <> 'cancelled'
        ORDER BY i.created_at DESC
      `),
      db.execute(sql`
        SELECT
          a.partner_id                        AS partner_id,
          p.name                              AS partner_name,
          a.status                            AS status,
          a.disputed                          AS disputed,
          COALESCE(SUM(a.amount_kopeks), 0)   AS total_kopeks
        FROM partner_service_accruals a
        LEFT JOIN partners p ON p.id = a.partner_id
        WHERE a.organization_id = ${organizationId}
        GROUP BY a.partner_id, p.name, a.status, a.disputed
      `),
      db.execute(sql`
        SELECT partner_id, COALESCE(SUM(amount_kopeks), 0) AS total_kopeks
        FROM partner_payouts
        WHERE organization_id = ${organizationId}
        GROUP BY partner_id
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(delta_kopeks), 0) AS total_kopeks
        FROM order_adjustments
        WHERE organization_id = ${organizationId} AND state = 'proposed'
      `),
      db.execute(sql`
        SELECT state, COALESCE(SUM(amount_kopeks), 0) AS total_kopeks
        FROM compensations
        WHERE organization_id = ${organizationId}
        GROUP BY state
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(amount_kopeks), 0) AS total_kopeks
        FROM payment_intents
        WHERE organization_id = ${organizationId}
          AND state IN ('disputed', 'chargeback_lost')
      `),
      db.execute(sql`
        SELECT
          to_char(date_trunc('month', i.created_at), 'YYYY-MM')                AS month,
          COALESCE(SUM(i.total_kopeks), 0)                                     AS invoiced_kopeks,
          COALESCE(SUM(GREATEST(0, COALESCE(p.captured, 0) - COALESCE(r.refunded, 0))), 0)
                                                                            AS net_collected_kopeks
        FROM customer_invoices i
        LEFT JOIN LATERAL (
          SELECT SUM(amount_kopeks) AS captured
          FROM payment_intents pi
          WHERE pi.order_id = i.order_id
            AND pi.organization_id = i.organization_id
            AND pi.state IN ('captured', 'partially_refunded', 'refunded')
        ) p ON TRUE
        LEFT JOIN LATERAL (
          SELECT SUM(rf.amount_kopeks) AS refunded
          FROM refunds rf
          JOIN payment_intents pi ON pi.id = rf.payment_intent_id
          WHERE pi.order_id = i.order_id
            AND rf.organization_id = i.organization_id
            AND rf.state = 'completed'
        ) r ON TRUE
        WHERE i.organization_id = ${organizationId}
          AND i.state <> 'cancelled'
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT 12
      `),
    ]);

  const invoiceRows = invoiceResult.rows as unknown as InvoiceSqlRow[];
  const accrualRows = accrualResult.rows as unknown as AccrualSqlRow[];
  const payoutRows = payoutResult.rows as unknown as PayoutSqlRow[];
  const adjustmentRows = adjustmentResult.rows as unknown as AdjustmentSqlRow[];
  const compensationRows = compensationResult.rows as unknown as CompensationSqlRow[];
  const chargebackRows = chargebackResult.rows as unknown as ChargebackSqlRow[];
  const monthRows = monthResult.rows as unknown as MonthSqlRow[];

  // --- Receivables -------------------------------------------------------------------------
  const aging: AgingBucket[] = AGING_BUCKETS.map(bucket => ({
    key: bucket.key,
    label: bucket.label,
    invoiceCount: 0,
    receivableKopeks: 0,
  }));
  const debtorMap = new Map<string, { customerId: string; customerName: string; customerPhone: string | null; receivableKopeks: number; invoiceCount: number }>();

  let invoicedKopeks = 0;
  let netCollectedKopeks = 0;
  let refundedKopeks = 0;
  let receivableKopeks = 0;
  let creditKopeks = 0;

  const receivables: ReceivableRow[] = invoiceRows.map(row => {
    const invoiceTotalKopeks = Number(row.invoice_total_kopeks ?? 0);
    const capturedKopeks = Number(row.captured_kopeks ?? 0);
    const refunded = Number(row.refunded_kopeks ?? 0);
    const net = capturedKopeks - refunded;
    const receivable = Math.max(0, invoiceTotalKopeks - net);
    const credit = Math.max(0, net - invoiceTotalKopeks);
    const ageDays = daysSince(new Date(row.created_at).toISOString(), now);

    invoicedKopeks += invoiceTotalKopeks;
    netCollectedKopeks += net;
    refundedKopeks += refunded;
    receivableKopeks += receivable;
    creditKopeks += credit;

    if (receivable > 0) {
      const bucket = aging.find(entry => entry.key === bucketFor(ageDays))!;
      bucket.invoiceCount += 1;
      bucket.receivableKopeks += receivable;

      const debtor = debtorMap.get(row.customer_id) ?? {
        customerId: row.customer_id,
        customerName: row.customer_name ?? "Клиент",
        customerPhone: row.customer_phone,
        receivableKopeks: 0,
        invoiceCount: 0,
      };
      debtor.receivableKopeks += receivable;
      debtor.invoiceCount += 1;
      debtorMap.set(row.customer_id, debtor);
    }

    return {
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      orderId: row.order_id,
      publicNumber: row.public_number,
      customerId: row.customer_id,
      customerName: row.customer_name ?? "Клиент",
      customerPhone: row.customer_phone,
      invoiceTotalKopeks,
      capturedKopeks,
      refundedKopeks: refunded,
      netCollectedKopeks: net,
      receivableKopeks: receivable,
      creditKopeks: credit,
      ageDays,
      issuedAt: new Date(row.created_at).toISOString(),
    };
  });

  // --- Payables ---------------------------------------------------------------------------
  const partnerMap = new Map<string, PartnerPayableRow>();
  const partnerFor = (partnerId: string, partnerName: string | null): PartnerPayableRow => {
    const existing = partnerMap.get(partnerId);
    if (existing) return existing;
    const created: PartnerPayableRow = {
      partnerId,
      partnerName: partnerName ?? "Партнёр",
      accruedKopeks: 0,
      invoicedKopeks: 0,
      estimatedKopeks: 0,
      disputedKopeks: 0,
      paidKopeks: 0,
      payableKopeks: 0,
    };
    partnerMap.set(partnerId, created);
    return created;
  };

  let accruedKopeks = 0;
  let estimatedKopeks = 0;
  let invoicedAccrualKopeks = 0;
  let disputedKopeks = 0;

  for (const row of accrualRows) {
    const total = Number(row.total_kopeks ?? 0);
    const partner = partnerFor(row.partner_id, row.partner_name);
    accruedKopeks += total;
    partner.accruedKopeks += total;
    if (row.disputed) {
      disputedKopeks += total;
      partner.disputedKopeks += total;
      continue;
    }
    if (row.status === "estimated") {
      estimatedKopeks += total;
      partner.estimatedKopeks += total;
    } else {
      invoicedAccrualKopeks += total;
      partner.invoicedKopeks += total;
    }
  }

  let paidKopeks = 0;
  for (const row of payoutRows) {
    const total = Number(row.total_kopeks ?? 0);
    paidKopeks += total;
    const partner = partnerFor(row.partner_id, null);
    partner.paidKopeks += total;
  }

  // A payable is what we still owe: every non-disputed accrual minus what has already been paid.
  let payableKopeks = 0;
  for (const partner of partnerMap.values()) {
    partner.payableKopeks = Math.max(0, partner.accruedKopeks - partner.disputedKopeks - partner.paidKopeks);
    payableKopeks += partner.payableKopeks;
  }

  // --- Margin ------------------------------------------------------------------------------
  // Contribution before courier cost: the platform has no courier cost field, so this must never
  // be presented as a profit figure.
  const partnerCogsKopeks = accruedKopeks - disputedKopeks;
  const contributionKopeks = netCollectedKopeks - partnerCogsKopeks;
  const takeRate = netCollectedKopeks > 0 ? contributionKopeks / netCollectedKopeks : null;

  // --- Exposure ----------------------------------------------------------------------------
  const adjustmentsPendingConsentKopeks = Number(adjustmentRows[0]?.total_kopeks ?? 0);
  let compensationsProposedKopeks = 0;
  let compensationsApprovedKopeks = 0;
  for (const row of compensationRows) {
    const total = Number(row.total_kopeks ?? 0);
    if (row.state === "proposed") compensationsProposedKopeks += total;
    if (row.state === "approved") compensationsApprovedKopeks += total;
  }
  const chargebackAtRiskKopeks = Number(chargebackRows[0]?.total_kopeks ?? 0);

  const monthly: MonthPoint[] = monthRows.map(row => ({
    month: row.month,
    invoicedKopeks: Number(row.invoiced_kopeks ?? 0),
    netCollectedKopeks: Number(row.net_collected_kopeks ?? 0),
  }));

  return {
    currency: "RUB",
    receivables: {
      invoicedKopeks,
      netCollectedKopeks,
      refundedKopeks,
      receivableKopeks,
      creditKopeks,
      invoiceCount: invoiceRows.length,
      aging,
      openInvoices: receivables,
      topDebtors: [...debtorMap.values()]
        .sort((a, b) => b.receivableKopeks - a.receivableKopeks)
        .slice(0, 10),
    },
    payables: {
      accruedKopeks,
      estimatedKopeks,
      invoicedKopeks: invoicedAccrualKopeks,
      disputedKopeks,
      paidKopeks,
      payableKopeks,
      partners: [...partnerMap.values()].sort((a, b) => b.payableKopeks - a.payableKopeks),
    },
    margin: {
      netCollectedKopeks,
      partnerCogsKopeks,
      contributionKopeks,
      takeRate,
      note: "Вклад до затрат курьера: в системе нет учёта стоимости курьера, это не прибыль.",
    },
    exposure: {
      adjustmentsPendingConsentKopeks,
      compensationsProposedKopeks,
      compensationsApprovedKopeks,
      chargebackAtRiskKopeks,
    },
    monthly,
  };
}
