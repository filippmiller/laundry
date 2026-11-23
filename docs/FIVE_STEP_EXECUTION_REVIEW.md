# Five-step engineering execution and independent review — 2026-11-16

## Step 1 — Baseline CI
Verified earlier GitHub Actions CI run #3 succeeded for commit 8f9fc9c (unit, typecheck, generated migrations and PostgreSQL integration workflow). This does **not** validate later changes. Newer CI run #7 was still in progress when inspected.

## Step 2 — Tenant isolation
Changed holdSlot input to require organizationId. Window ownership checked by joining service_windows to buildings in the transaction. Cross-tenant requests return WINDOW_NOT_FOUND without consuming capacity. This is only one operation; other slot functions still require caller authorization and must not be exposed directly.

## Step 3 — Idempotency and capacity integrity
Added SHA-256 request fingerprint persisted on slot_reservations. Same key with different expiry or tenant fails rather than silently replays. On release/expire, failure to decrement the capacity counter throws and rolls back the reservation-state change. Counter still requires reconciliation worker and repair tooling.

## Step 4 — Tests and research
Extended PostgreSQL integration suite with cross-tenant and mismatched-idempotency tests; adjusted unit fixtures to require tenant ID. Sourced and reviewed OSS candidates in OPEN_SOURCE_SOURCING_2026_11.md. No source code imported; shortlist and license notes are preliminary.

## Step 5 — Independent critical review
- CRITICAL: confirmSlot, releaseSlot and expireSlot take bare reservation IDs without tenant context. Must require organization scope and authorized actor before public API.
- HIGH: same idempotency key with different body is checked, but input hash does not include customer, order, service or price. Extend command scope and hash before checkout.
- HIGH: terminal replay returns released/expired states; callers must not interpret replay as a new successful hold.
- HIGH: expiry sweep worker and provider payment compensation not implemented.
- HIGH: schema migration for requestHash is generated in CI only, not committed or tested as an upgrade against prior populated DB.
- HIGH: evidence/custody and partner accounting not yet implemented.
- MEDIUM: integration suite uses deterministic clock and shares one test window; isolate fixtures per test when suite grows.
- MEDIUM: production money should use bigint/string at API boundaries if amounts can exceed JS safe integers.
- MEDIUM: OSS licenses must be pinned to exact commits, not just repo root.
- HIGH: Russian 54-FZ, consumer protection, personal data and partner document flow need local legal/accounting sign-off.

## Acceptance outcome
Completed five scoped actions: baseline CI inspection, booking ownership guard, idempotency/counter hardening, tests plus OSS sourcing, and second-pass review. **Not complete:** fully secured reservation API, production payment integration, entire OSS port, or green CI on final commit. This PR remains Draft.

## Next coding gate
Make all slot operations tenant-scoped and test them, implement expiry sweep and capacity reconciliation, introduce payment reservation saga with fake provider, generate checked-in SQL migrations and upgrade tests, then implement courier custody acceptance.
