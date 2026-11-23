# Review of v2 engineering contracts — second independent pass

Reviewed state machines, RBAC, pricing/refunds and 12 E2E seed scenarios against cross-domain invariants.

## Findings
| ID | Severity | Finding | Resolution |
|---|---|---|---|
| V2-01 | Critical | Order close after partial delivery can mask missing items | Require item reconciliation or explicit exception record; claim remains independent |
| V2-02 | Critical | Fee could be charged before slot reservation | Reservation and authorization orchestration must compensate failed steps; release holds |
| V2-03 | High | Customer approval after partner inspection might be stale | Approval binds to immutable quote/version and expires; re-quote on changes |
| V2-04 | High | A driver may scan but must not inspect protected items | Driver transport-only permissions; no garment detail |
| V2-05 | High | Admin could access all evidence by default | Deny by default; case-scoped grants and audit |
| V2-06 | High | Payment/refund chargeback race can double-pay | Financial hold, idempotency and reconciliation |
| V2-07 | High | Partial order fulfillment cannot be represented by one delivered flag | Item-level delivery plus exceptions; UI aggregate derives from items |
| V2-08 | Medium | Precise-time and night surcharges lack real capacity validation | Disabled until staffing, safety, legal and economics validated |
| V2-09 | Medium | Customer cancels after courier dispatch | No blanket penalty; assess actual lawful expenses and disclosure |
| V2-10 | High | Partner receipt without counterpart proof weakens chain | Dual-party manifest or explicit pending-handoff incident |
| V2-11 | Medium | Quote price may change while customer approves | Price snapshot, expiry and optimistic concurrency |
| V2-12 | High | A legally required cash-register receipt cannot be inferred from invoice | Separate fiscal receipt lifecycle and 54-FZ integration required |

## Further remediation required before coding
1. Add **fiscal_receipt** state machine (not_created, pending, registered, correction_pending, corrected, failed), with tax/fiscal provider and legal review.
2. Define capacity reservation TTL and expiry/release worker, plus recovery from payment succeeded / reservation failed.
3. Define item-level reconciliation invariant with missing/rejected/returned dispositions before operational closure.
4. Add approval version and expiry checks for any partner change request.
5. Add data retention schedules per evidence category and jurisdiction.
6. Create concrete Drizzle schemas and API/OpenAPI contracts after sign-off of legal role and accounting model.

## Review conclusion
The v2 documents improve implementability but are not yet a production-ready build specification. No executable code, database migration or automated test has been created. Keep Draft PR open.