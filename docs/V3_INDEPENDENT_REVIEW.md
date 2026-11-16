# Independent v3 audit — schema, API, finance and capacity

## Method
Second pass checked proposed database constraints against API workflows, role matrix, custody, payments and operational edge cases. This is design review, not running tests.

| ID | Severity | Gap | Remediation |
|---|---|---|---|
| V3-01 | Critical | Quote accepted without a valid reservation may create orphan payment | Reservation hold + payment authorization saga, TTL, compensation and reconciliation |
| V3-02 | Critical | Double journal posting on webhook retry | Unique source-event posting and balanced journal transaction |
| V3-03 | Critical | Scan event can be forged with guessed QR | Authenticate actor/device, verify assignment and version; QR only opaque reference |
| V3-04 | High | Package-level Economy manifest cannot prove individual contents | Preserve package evidence and transparent scope; no unlawful waiver of liability |
| V3-05 | High | Fiscal receipts omitted from early domain states | Add independent fiscal receipt machine and provider reconciliation |
| V3-06 | High | Expired quote accepted while tariff changed | Immutable quote hash, expiry and approval version; require re-quote |
| V3-07 | High | Mixed protected/economy items may be repacked incorrectly | Garment lineage and distinct container assignments |
| V3-08 | High | Partner can see address/door code through generic order API | Field-level projections and partner-scoped endpoints |
| V3-09 | High | Refund and chargeback may overlap | Financial hold, provider reconciliation, no double payout |
| V3-10 | High | Slot holds may oversell capacity under concurrency | DB row locking and atomic reservations |
| V3-11 | Medium | Schema plan lacks exact Drizzle migration code | Generate only after final policy/contract approval; include upgrade tests |
| V3-12 | Medium | Some enum definitions and status transition guards still prose | Formal transition tables and executable model tests |
| V3-13 | High | Video retention and consent schedules not finalized | Legal review, data minimization and evidence retention by purpose |
| V3-14 | Medium | Partial delivery needs item-level reconciliation and customer UI | Delivery attempts and garment status linked to outstanding items |
| V3-15 | High | Russian principal/agent role not chosen | Block fiscal and contract release pending counsel decision |
| V3-16 | Medium | Route economics not validated with real data | Pilot simulation with partner quotes and measured courier stops |

## Outcome
All findings tracked as requirements in existing v2/v3 documents or remain open gates. No claim of code readiness. Prioritize legal principal/agent decision, fiscal flows, exact transition guards, real pilot costs and executable migration tests before implementation.

## Next phase: schema implementation prerequisites
1. Approve legal entity and contract role.
2. Choose payment/fiscal providers and tax configuration.
3. Confirm protected-intake valuation procedure.
4. Approve cancel/no-show/refund matrix.
5. Approve partner price contract and reconciliation rules.
6. Generate Drizzle migration files and TypeScript domain types with tests.
