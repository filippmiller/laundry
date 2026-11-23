# Slot reservation implementation and outstanding risks

## Implemented in starter kernel
- holdSlot: unique idempotency key per window, insert-first transaction, conditional atomic capacity increment, rollback when no capacity.
- confirmSlot: compare-and-swap held to confirmed before expiration.
- releaseSlot: held/confirmed to released once, decrement window counter.
- expireSlot: held to expired once after TTL, decrement counter.
- GitHub Actions workflow for TypeScript typecheck, Vitest and Drizzle SQL generation.

## Important limitations and remediation before deployment
1. **No tenant authorization inside service.** The caller must verify the authenticated tenant owns the window. Add tenant scope in database query and RBAC before exposing API.
2. **Idempotency key does not bind request body.** Same key with different expiration is currently replayed, not rejected. Add request hash and enforce mismatch conflict.
3. **Counter invariant:** release/expire decrements only if reservedOrders > 0, but a corruption could leave reservation terminal and counter inconsistent. Add a transactional invariant that raises if counter update affects zero rows; reconciliation worker must compare held+confirmed count to counter.
4. **Payment saga not implemented.** Do not capture fees until reservation and payment state reconcile; handle expiration during payment authorization.
5. **Confirmed cancellation policy not implemented.** Call releaseSlot only after lawful fee/refund decision.
6. **Expired holds occupy capacity until worker processes them.** Add background expiry sweep and metrics.
7. **No end-to-end DB tests run.** Current tests validate inputs only; concurrency and retry correctness require real PostgreSQL integration tests.
8. **Migration generation has not been executed by this connector.** CI is proposed, not confirmed passing.
9. **Window capacity is by order count only.** Add weight/volume/route time constraints before real operations.
10. **Schema is incomplete.** This module is an engineering seed, not a deployable booking service.

## Required integration tests
- 2 concurrent clients compete for last capacity: exactly 1 succeeds.
- 10 retries with same key: one reservation and one increment.
- Same key different request body: conflict after request-hash enforcement.
- Capacity zero: no persistent reservation.
- Expire twice: one decrement.
- Confirm vs expire race: exactly one terminal result.
- Release vs expire race: exactly one decrement.
- Confirmed booking not expired by worker.
- Cross-tenant window cannot be booked.
- Counter reconciliation catches mismatch and alerts.
- Payment authorized but booking fails: authorization voided.
- No stale hold survives recovery sweep.
