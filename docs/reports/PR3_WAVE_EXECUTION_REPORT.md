# PR #3 — wave execution report (W0–W1), 2026-11-16

**Branch:** `docs/pr2-independent-audit-autonomous-wave` (Draft PR #3)
**Code commit under test:** `0b7b4e81b4a49c0c12ea460538bd2d5e010d9579`
**Scope of this wave:** W0 baseline + W1 security/money/custody P0 remediation with executable regressions.
**Not done in this wave:** W2 provider simulator beyond the fake adapter, W3 custody proof model, W4 role UIs, W5 offline/OSS, W6 outbox/media/restore, W7 12 E2E journeys, W8 independent adversarial review.

This report replaces "planned" claims with what is actually on disk and verified locally. Nothing here authorizes a pilot or deployment.

## 1. Baseline (W0), verified locally

| Item | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | node_modules present; lockfile untouched |
| Lint | `npm run lint` | PASS |
| Types | `npm run typecheck` | PASS (API + web) |
| Unit/integration | `npm test` | PASS — 8 files, 62 tests (was 39 in the hosted run at `43911616273`) |
| Web build | `npm run web:build` | PASS — `dist/web` 208 kB JS / 4 kB CSS |
| Migration drift | `npm run db:generate` + `git diff --exit-code -- drizzle` | PASS — "No schema changes"; 14 journal entries through `0013` |
| Database | embedded PostgreSQL 18 (`test/global-setup.ts`) | PASS — migrations applied to a disposable database |
| Smoke | `npm run smoke` | NOT_RUN in this wave (requires a separately started API); the previous hosted run covered 5 assertions |

Node 24.19.0, npm 11.17.0, Windows 11. The hosted workflow checks out the PR merge ref, so local evidence is always captured against an explicit commit (`0b7b4e8`).

## 2. Findings closed in this wave

Each finding has: a source-level root cause, a minimal fix, a regression test, and a mutation check proving the test is not vacuous.

### LND3-P0-01 — authenticated reads leaked rows across roles/customers
* `GET /orders` returned every order of the tenant to any authenticated role, including `accepted_quote_hash`.
* `GET /claims`, `/finance/fiscal-receipts`, `/dispatch/pickup-queue`, `/dispatch/capacity-reconciliation`, `/finance/reconciliation`, `/partner/expected-receipts` had no role gate.
* `GET /orders/:id` returned the full row to any role in the tenant.

Fix: declarative `roles` on the route table (enforced before the handler), customer/partner list scoping, `loadOrderView` projection that never exposes terms hash/address/quote to a partner or courier, and partner-manifest joins on `orders.assigned_partner_id`.
Tests: `test/security-regressions.integration.test.ts` → "role-scoped reads" (3 tests).

### LND3-P0-02 — partner could take custody of unassigned orders
Received handoff assigned `assigned_partner_id` to whoever asked first, and inspection/processing/QC never checked ownership. Partner finance could dispute any invoice line.

Fix: `assertAssignedPartner` on receive, inspection, adjustment, processing and QC; explicit dispatcher command `POST /dispatch/orders/:id/partner`; partner finance ownership check on disputes.
Residual: `POST /dispatch/orders/:id/partner` is not surfaced in the dispatcher UI yet (W4).
Tests: 3 tests (unassigned receive, foreign inspection/processing, foreign partner dispute).

### LND3-P0-03 — idempotency keys were replayable across principals
`withIdempotency` compared org/scope/key/hash only, and several command hashes omitted the actor. A leaked key returned another actor's cached response; a stale authorization was never re-checked.

Fix: keys are bound to `actorId` (`IDEMPOTENCY_OWNER_MISMATCH`, 409); all mutation hashes include the actor; an optional `replayGuard` re-authorizes the target on replay (used by `scheduleOrder` and `openClaim`).
Residual: `replayGuard` is applied to the externally reachable financial/booking commands; other commands rely on actor binding plus route-level role checks. Full per-command guard coverage is a W2 follow-up.
Tests: 3 tests (cross-principal quote, reassigned-order schedule replay, cross-customer claim replay). Mutation check: removing the actor comparison fails the test.

### LND3-P0-04 — double capture and over-refund under concurrency
`capturePayment` allowed a second full capture with a different key; `refundPayment` read `sum(refunds)` without a row lock.

Fix: `SELECT … FOR UPDATE` on the order row then a single-capture guard (`ORDER_ALREADY_CAPTURED`); `SELECT … FOR UPDATE` on the payment intent before the refundable-balance computation.
Tests: 3 tests, two of them genuinely concurrent (`Promise.allSettled` over two pool connections): exactly one capture and exactly one full refund succeed.
Residual: no provider-side idempotency test yet (no real provider); chargebacks are not modelled.

### LND3-P0-05 — order could be scheduled with no or foreign capacity
Fix: both legs are required (`BOTH_RESERVATIONS_REQUIRED`); each hold must belong to the order customer, be unbound or bound to this order/quote, still `held`, and point at a window of the order's building and the correct kind. Confirmation happens inside the same transaction that marks the order `scheduled`.
Tests: 4 tests (zero reservations, foreign customer's hold, wrong-kind leg, expired hold).

### LND3-P0-06 — claims could attach another order's garments/evidence
Fix: garment ids must belong to the claim's order; evidence must be `ownerType='order'`, `ownerId=order.id`, `verified|legal_hold`, and have a claim-appropriate purpose; duplicates are rejected.
Tests: 2 tests plus a positive control.

### LND3-P0-07 — webhook was session-authenticated and unverified
Fix: the endpoint is public but requires `x-provider-signature` = HMAC-SHA256 of `provider:eventId:eventType:sha256(canonical payload)` with `PAYMENT_WEBHOOK_SECRET`; the tenant is derived from the stored payment intent (never from the body); unsupported providers return 503 instead of pretending to work.
Tests: 2 API tests (401 unsigned/forged, recorded/duplicate/foreign-tenant/unsupported).
Residual: the fake provider remains the only supported provider; there is no durable inbox processor/retry loop yet (W2/W6), so `recorded` means "stored once", not "applied to the ledger".

### LND3-P1-01 — delivery counted length, not the exact set
Fix: duplicate ids are rejected (`DUPLICATE_GARMENT_ID`), `delivered` requires set equality (`DELIVERY_SET_MISMATCH`), Economy bag orders complete at bag level, and a partial delivery creates a pending recovery stop.
Tests: 3 tests (duplicates, incomplete/full, bag partial → recovery → delivered). Mutation check: disabling the duplicate or set-equality guard fails 2 tests.

## 3. Still open (visible, not silently closed)

| ID | Status | Why |
| --- | --- | --- |
| LND3-P1-02 | PARTIAL | Adjustment acceptance still does not issue a revised invoice or a versioned consent record; QC coverage is now enforced but the decline/return path has no customer return flow. |
| LND3-P1-03 | PARTIAL | Intake confirmations are still booleans; `deviceId` ownership and `payloadHash` recomputation are not enforced for container/seal scans. |
| LND3-P1-04 | NOT_RUN | Outbox worker still counts pending rows; no lease/ack/retry. |
| LND3-P1-05 | PARTIAL | No CSRF/origin enforcement for cookie mutations; demo login remains available outside production by design. |
| LND3-P1-06 | NOT_RUN | Role workspaces (partner/support/finance) not built. |
| LND3-P1-07 | PARTIAL | Compose still runs `dev:api`; populated-DB upgrade and restore drill not executed. |
| LND3-P2-01 | DONE | README table/test counts corrected; this report is the dated ledger. |
| LND3-P2-02 | PARTIAL | This wave did not rewrite broad Beads epics; issue state must be reconciled before any "done" claim. |

## 4. Next wave (concrete order)

1. W2: durable inbox processor with leases and a reconciler for `payment_events`; refund/chargeback interplay; provider simulator with signed events.
2. W3: two-party custody proof (device ownership, payload hash, seal/QR binding) and the adjustment→invoice→consent chain.
3. W6: outbox worker (notification retries), populated-DB upgrade test, backup/restore drill.
4. W4/W5 only after P0/P1 records stay green; independent review (W8) must be performed by a different model/owner, not by the author of these fixes.

## 5. Wave 2 (same day, continuation) — closing customer/admin/support paths

**Commits:** `30fae60` (customer lifecycle), `4f76385` (admin + fraud), `3ec3a19` (support, reviews, rate limiting, test harness), `53670d7` (money/claim reads). Local suite: **83 tests / 12 files**, lint/typecheck/build clean.

Shipped and tested:

* `POST /orders/:id/cancel` — releases both live holds inside the cancellation transaction; a foreign customer gets 404; a repeat cancel does not double-release.
* `POST /orders/:id/reschedule` — atomic swap of both legs; a rejected leg rolls back and keeps the original confirmed capacity.
* `GET /quotes/:id` and `POST /courier/stops/:id/start`; the courier stop list joins the order number/state and hides finished stops.
* Admin: member listing, audited role grant/revoke (self-grant and last-admin blocked), session revocation, audit feed.
* Fraud: read-only signals (claim velocity, refund without delivery, shared devices, repeated partials, cancel velocity) scoped per tenant; no automatic blocking.
* Support: threads anchored to the customer's order, participant-scoped reads, replies, close.
* Reviews/likes: migration `0014` (`reviews`, `review_likes`), one review per delivered/closed order, idempotent likes, audited hide.
* External import: `@fastify/rate-limit` 10.3.0 (MIT) — 600/min global, 20/min demo login, 120/min webhooks.
* Money and claim reads: `GET /orders/:id/finance` (invoice, payments, refunds, fiscal state, explicit fake-provider marker), `GET /claims/:id` (items, decisions, held evidence ids), `GET /partner/accruals` (own accruals and invoices only).

Environment trap found and fixed: a killed test run left `.pgdata-test` in a state where embedded PostgreSQL hung, and Vitest reported it as "No test files found / Unknown Error: undefined". `test/global-setup.ts` now fails fast after 45s, rebuilds the disposable cluster and retries; the trap is recorded here because it will recur on any interrupted run.

Still open after Wave 2: customer-facing UI for cancel/reschedule/support/reviews, partner/support/finance workspaces, outbox worker, payment inbox processor, custody proof model, populated-DB upgrade/restore, and the independent reviewer verdict.

## 6. Wave 3 (same day) — UI, payment inbox, custody proof

**Commits:** `339366a` (web), `9b395fb` (payment inbox/chargeback/drift), `8bbbffb` (custody proof). Suite: **92 tests / 14 files**, lint/typecheck/build clean, migrations `0015`–`0016` generated with no drift.

* **W4 UI** — customer: two-leg booking fix (the old screen scheduled with a pickup hold only and was broken by P0-05), cancel, finance panel, review form, support thread. Courier: IndexedDB queue with canonical client hash, pending counter, flush and rejection reason. Support workspace: threads, detail, reply, close. Admin workspace: members, fraud queue, audit feed. No browser test/trace was executed for these screens; that remains a gap.
* **W2 money** — `payment_events` gains `state/attempts/processed_at/error` (`0015`); `processPaymentInbox` claims rows with `FOR UPDATE SKIP LOCKED`, applies captured/refunded/chargeback, and marks failures with a reason; `requeueFailedPaymentEvents` re-arms them; the worker drains the inbox each cycle. `markChargeback` moves a capture to `disputed` and refunds stop; `paymentDrift` reports intent-vs-refund disagreement.
* **W3 custody** — `courier_devices` (`0016`), `registerCourierDevice`, server-side canonical hash recomputation, device ownership per courier, and container/seal scans must belong to an order assigned to that courier. Tests: unregistered device, tampered hash, foreign seal, device sharing, cross-courier binding.


## 7. Wave 4 (same day) - outbox worker and restore drill

**Commit:** `1f615b6`. Suite: **96 tests / 15 files**, lint/typecheck/build clean, migration `0017` no drift.

* **Outbox notification worker** - `outbox_events` gains an `error` column (`0017`). `processOutbox` claims pending rows with `FOR UPDATE SKIP LOCKED` and maps customer-visible event types (order confirmed/scheduled/cancelled/rescheduled, invoice created, payment captured/refunded, claim opened/decided, delivery failed/partial) to `notifications` rows with `dedupeKey = outbox:<eventId>`, so a replay of the worker can never double-send. Events the screens already notify directly (`order.accept_handoff`, `delivery.delivered`) are deliberately excluded from the map. Unmappable rows stay `failed` with a reason and are re-armed by `requeueFailedOutboxEvents`. The worker drains the outbox every cycle.
* **Populated-DB upgrade/restore drill** - `npm run db:drill` boots a throwaway embedded cluster and proves, in order: the full migration chain (`0000..0017`) applies to an empty database; the demo seed plus a real scheduled order populate orders/quotes/outbox/audit and one worker cycle drains the outbox (7 events, 2 notifications); re-running migrations on the populated database is a no-op; a physical clone (`CREATE DATABASE ... TEMPLATE`) preserves every checked row exactly. Because the machine has no `pg_dump`, the restore leg uses the server-side physical clone; a real `pg_dump`/`pg_restore` leg should be added when production tooling is chosen.

## 8. Wave 5 (same day) - CSRF/origin hardening

**Commit:** `fe6ce7c`. Suite: **99 tests / 15 files**, lint/typecheck clean.

* Cookie-authenticated POSTs now verify the `Origin` authority against the serving host or a configured `WEB_ORIGIN` (`ORIGIN_MISMATCH` -> 403). This is defense-in-depth on top of `sameSite=lax` for browsers that ignore SameSite. Absent Origin (curl, integration tests) stays allowed because those clients carry no ambient cookies. The signature-authenticated payment webhook is exempt: providers are not browsers.
* 3 new regressions in the security suite (LND3-P1-09): hijacked-origin POST rejected, same-origin/originless POSTs accepted, provider webhook with foreign origin still processed.
