# Laundry — financial, fiscal and capacity invariants v3

## Accounting separation
Order lifecycle, customer invoice, payment provider event, fiscal receipt and partner settlement are independent. Amounts in integer kopeks. Journal postings immutable, balanced by currency; corrections via reversal journals. Exact accounts and recognition policies require accountant approval.

Illustrative accounts: provider clearing, bank, customer advances, revenue, partner payable, partner processing expense, courier expense, payment fees, refunds liability, claims expense, taxes as applicable.

Illustrative entries (not accounting advice):
Customer prepays 2200 RUB: debit clearing 220000; credit advances 220000.
After service recognized: debit advances 220000; credit revenue 220000, with tax splits as approved.
Partner cost 600 RUB: debit processing expense 60000; credit partner payable 60000.
Partner payout: debit partner payable 60000; credit bank 60000.
Each event posts once; no retroactive editing.

## Fiscal receipt state machine
not_created → pending_registration → registered. On failure: retry_pending; correction_requested → correction_pending → corrected. Exact 54-FZ receipt types and timing depend on legal role, provider and tax scheme. An invoice PDF is not a fiscal receipt.

## Invariants
- Every posted journal balanced; never delete or update posted entry.
- Net customer refunds cannot exceed net captured payments; compensation separate.
- Payment, refund, payout, fiscal request and incoming webhook each have scoped idempotency.
- Partner accruals use effective contract price version; contested lines tracked separately.
- Chargeback and refund overlap triggers hold and reconciliation.
- Partner credit note references original invoice and line.
- Fee cannot be captured for an unavailable off-schedule slot; failure must void or refund.
- Actual weight changes create proposed adjustment; no unapproved delta charge.

## Capacity
service_window stores capacity_orders, capacity_weight_grams, safety buffer. Held and confirmed reservations both consume capacity. Proposed hold TTL: 10 minutes, configurable. Under transaction lock the window row, recompute capacity, reserve or reject; never rely on stale cached availability.

Example: 10 total orders, 8 confirmed, 1 held, 2 concurrent requests for last slot → exactly one succeeds. Expiry worker releases held capacity exactly once. Confirmed reservation is never released by TTL. Payment pending when TTL expires triggers void/reconciliation. Route assignment checks vehicle weight/volume, stop time, access restrictions and shift hours separately.

## Premium fee policy
Shared building pickup and delivery: 0 RUB fee (not zero actual cost). Special pickup: illustrative +500 RUB. Special delivery: illustrative +500 RUB. Both: illustrative +1000 RUB, independent line items. No fee when the operator failed to provide a paid slot; do not charge rewash to remedy a service defect. All exceptions require feasibility, explicit customer acceptance and versioned fee rule.

## Economics
Marginal cost of special stop = added travel minutes × loaded labor cost + added km × vehicle cost + parking + handling time + failure probability × retry cost + payment fee + expected claim cost. Disable offer if fee is insufficient or route infeasible. Group-route costs allocated over served orders, not assumed free.

## Reconciliation
Daily: payment captures/refunds vs provider and fiscal receipts; custody discrepancies. Per partner billing cycle: accruals vs partner invoices and credits. Monthly: route contribution margin, chargeback aging, claims reserve, unpaid partner balance.
