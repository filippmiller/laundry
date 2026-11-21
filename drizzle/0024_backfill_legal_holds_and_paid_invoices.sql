-- Populated-DB backfill:
-- 1. Reconcile evidence_assets.legal_hold_count and status against active (released_at IS NULL) evidence_legal_holds.
WITH active_holds AS (
  SELECT asset_id, COUNT(*)::integer AS cnt
  FROM evidence_legal_holds
  WHERE released_at IS NULL
  GROUP BY asset_id
),
reconciled AS (
  SELECT ea.id, COALESCE(ah.cnt, 0) AS cnt
  FROM evidence_assets ea
  LEFT JOIN active_holds ah ON ah.asset_id = ea.id
)
UPDATE evidence_assets ea
   SET legal_hold_count = r.cnt,
       status = CASE
         WHEN r.cnt > 0 THEN 'legal_hold'::evidence_state
         WHEN ea.status = 'legal_hold'::evidence_state AND r.cnt = 0 THEN 'retained'::evidence_state
         ELSE ea.status
       END
  FROM reconciled r
 WHERE ea.id = r.id
   AND (
     ea.legal_hold_count IS DISTINCT FROM r.cnt
     OR (r.cnt > 0 AND ea.status <> 'legal_hold'::evidence_state)
     OR (r.cnt = 0 AND ea.status = 'legal_hold'::evidence_state)
   );
--> statement-breakpoint
-- 2. Mark pre-upgrade open customer_invoices as 'paid' when captured payment_intents cover cumulative invoice totals.
WITH captured_per_order AS (
  SELECT organization_id, order_id, COALESCE(SUM(amount_kopeks), 0) AS captured_kopeks
  FROM payment_intents
  WHERE state IN ('captured', 'partially_refunded', 'refunded')
  GROUP BY organization_id, order_id
),
ordered_invoices AS (
  SELECT
    ci.id,
    ci.organization_id,
    ci.order_id,
    SUM(ci.total_kopeks) OVER (
      PARTITION BY ci.organization_id, ci.order_id
      ORDER BY ci.created_at ASC, ci.id ASC
    ) AS cumulative_kopeks
  FROM customer_invoices ci
  WHERE ci.state <> 'cancelled'
)
UPDATE customer_invoices ci
   SET state = 'paid'
  FROM ordered_invoices oi
  JOIN captured_per_order cpo
    ON cpo.organization_id = oi.organization_id
   AND cpo.order_id = oi.order_id
 WHERE ci.id = oi.id
   AND ci.state = 'open'
   AND cpo.captured_kopeks >= oi.cumulative_kopeks;
