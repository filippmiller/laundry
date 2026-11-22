import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";

export type PartnerAccrualTotalsRow = {
  partnerId: string;
  partnerName: string | null;
  /** Net non-voided accrual sum (includes positive accruals and negative credit/reconciliation offsets). */
  accruedKopeks: number;
  /**
   * Net disputed hold across currently disputed accruals.
   * Each disputed accrual holds only its remaining uncredited balance:
   * `GREATEST(0, a.amount_kopeks - COALESCE(non_rejected_credit_notes_for_line, 0))`
   * so prior partial credit offsets (which already reduce `accruedKopeks`) are never double-deducted.
   */
  disputedKopeks: number;
  /** Non-disputed estimated accruals not yet billed onto a partner invoice. */
  estimatedKopeks: number;
  /** Non-disputed billed/credited net accrual balance (`accruedKopeks - disputedKopeks - estimatedKopeks`). */
  invoicedKopeks: number;
  /** Non-disputed net payable before payouts/reserves (`accruedKopeks - disputedKopeks`). */
  grossPayableKopeks: number;
};

type RawPartnerAccrualTotalsRow = {
  partner_id: string;
  partner_name: string | null;
  accrued_kopeks: string | number;
  disputed_kopeks: string | number;
  estimated_kopeks: string | number;
};

/**
 * Single source of truth for partner accrual totals and net disputed holds.
 * Shared by payout authorization (`computePartnerBalanceTx`) and `financeAnalytics`
 * so available payable, disputed hold, and advance metrics never diverge.
 */
export async function queryPartnerAccrualTotals(
  executor: Db | Tx,
  organizationId: string,
  partnerId?: string,
): Promise<PartnerAccrualTotalsRow[]> {
  const partnerFilter = partnerId ? sql`AND a.partner_id = ${partnerId}` : sql``;
  const result = await executor.execute(sql`
    SELECT
      a.partner_id AS partner_id,
      p.name AS partner_name,
      COALESCE(SUM(a.amount_kopeks), 0)::bigint AS accrued_kopeks,
      COALESCE(SUM(
        CASE WHEN a.disputed THEN
          GREATEST(0, a.amount_kopeks - COALESCE(cn.credited_kopeks, 0))
        ELSE 0 END
      ), 0)::bigint AS disputed_kopeks,
      COALESCE(SUM(
        CASE WHEN NOT a.disputed AND a.status = 'estimated' THEN a.amount_kopeks ELSE 0 END
      ), 0)::bigint AS estimated_kopeks
    FROM partner_service_accruals a
    LEFT JOIN partners p ON p.id = a.partner_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(pcn.amount_kopeks), 0)::bigint AS credited_kopeks
      FROM partner_invoice_lines pil
      JOIN partner_invoices pi
        ON pi.id = pil.invoice_id
       AND pi.organization_id = a.organization_id
      JOIN partner_credit_notes pcn
        ON pcn.original_line_id = pil.id
       AND pcn.organization_id = a.organization_id
       AND pcn.state <> 'rejected'
      WHERE pil.accrual_id = a.id
    ) cn ON a.disputed = TRUE
    WHERE a.organization_id = ${organizationId}
      AND a.status <> 'voided'
      ${partnerFilter}
    GROUP BY a.partner_id, p.name
  `);

  return (result.rows as unknown as RawPartnerAccrualTotalsRow[]).map(row => {
    const accruedKopeks = Number(row.accrued_kopeks ?? 0);
    const disputedKopeks = Number(row.disputed_kopeks ?? 0);
    const estimatedKopeks = Number(row.estimated_kopeks ?? 0);
    const invoicedKopeks = accruedKopeks - disputedKopeks - estimatedKopeks;
    const grossPayableKopeks = accruedKopeks - disputedKopeks;
    return {
      partnerId: row.partner_id,
      partnerName: row.partner_name,
      accruedKopeks,
      disputedKopeks,
      estimatedKopeks,
      invoicedKopeks,
      grossPayableKopeks,
    };
  });
}
