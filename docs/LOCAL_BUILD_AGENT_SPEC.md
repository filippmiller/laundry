# LOCAL_BUILD_AGENT_SPEC.md — implementation contract for local coding agent
Status: actionable implementation brief. Existing PR #1 is Draft. Do not assume all 800 matrix entries are executable or complete. Read in order: FOUNDATION, OPERATING_CONTRACTS, SCENARIO_MATRIX_800, STATE_MACHINES_V2, RBAC_MATRIX_V2, SCHEMA_CONTRACT_V3, API_CONTRACT_V3, FINANCE_AND_CAPACITY_V3, OSS_FULL_REAUDIT_AND_MODULE_MAP, FIVE_STEP_EXECUTION_REVIEW.

## Goal
Build a usable Russian-language Laundry MVP for scheduled shared-building pickup, processing by a contracted laundry partner, and return delivery. Two tariffs: Economy bag/weight intake with clearly disclosed limited evidence, Protected itemized intake with condition/photo/video where necessary. Legal terms must not purport to waive nonwaivable consumer rights. Offer optional paid off-schedule pickup/delivery, illustrative +500 RUB each, configurable and versioned.

## Local environment and stack
Node 22 LTS, TypeScript strict, PostgreSQL 16+, Drizzle ORM, Vitest, OpenAPI 3.1/Zod, React + Vite (or Next.js only with justified ADR), Refine for operator/partner/admin screens, mobile-first courier PWA, Docker Compose for local PostgreSQL and isolated optional services. Use npm initially to avoid unnecessary lockfile migration; commit package-lock.json after install. Do not import unreviewed vendor code.

## Architecture modules
apps/api (HTTP, auth, tenant context, OpenAPI);
apps/customer (address, quote, checkout, tracking, claims);
apps/ops (Refine: dispatch, finance, claims, partner portal with RBAC);
apps/courier (offline-capable PWA);
packages/domain (pure state/price/custody/financial rules);
packages/db (Drizzle schema, migrations, transaction services);
packages/contracts (Zod/OpenAPI DTOs);
packages/integrations (VROOM, payment, fiscal, SMS, object store adapters);
packages/testkit (fixtures, test factories).
Current src/* can be moved via incremental refactor; keep tests green. Do not restructure until tests and migration baseline are stable.

## Strict engineering rules
- Authenticated organization context from server session, never trusted solely from request JSON.
- Every mutation idempotent where external/financial/custody effects occur, with body fingerprint.
- All custody events and financial postings append-only with explicit reversal/correction events.
- PostgreSQL transactions and conditional updates for slot capacity, one-way state guards.
- Integer kopeks, immutable tariff/partner contract snapshots, timezone-aware slots.
- QR is opaque ID, not proof of contents; two-party signed/confirmed handoff.
- Evidence private object storage with hashes, access audit, legal hold and retention policy.
- Outbox/inbox for webhooks and side effects; retries safe; never conflate payment capture and fiscal receipt.
- Each UI role has least privilege and server-enforced scopes.
- No fake 'green' status: record exact commands, outputs and workflow URLs.
- No external service integration without pinned version/license/secret-handling review.

## Vertical slices and completion gates
### Slice A — foundational DB + identity + capacity
1. Fix remaining bare-ID confirm/release/expire tenant authorization; add organization scoping to all commands.
2. Implement expiry worker, reconciliation and repair audit; request-hash includes authenticated principal/order/quote where applicable.
3. Commit generated SQL migrations and upgrade tests with PostgreSQL service.
4. Add OpenAPI booking endpoints and mock-auth-only test environment, production auth mandatory before public exposure.
5. Acceptance: 2 simultaneous clients for last slot → 1 win; same key/different body → 409; cross-tenant → 404; expire vs confirm exactly once; counter invariant always holds.

### Slice B — customer quote to pickup
1. Address/zone/building lookup, catalog and versioned quote, Economy/Protected choice.
2. Shared pickup and delivery free fee lines; off-schedule request quote and explicit approval.
3. Customer order timeline and cancellation policy with legal review gate.
4. Courier shift, route stop, scan and bag/seal intake; offline sync with dedupe.
5. Acceptance: user completes order, courier receives assigned stop, scans container, customer gets confirmation; unauthorized courier cannot accept.

### Slice C — partner receipt to ready
1. Dual-party handoff; discrepancy blocks automatic custody transfer.
2. Partner inspection, processing batch, QC, rewash and rejected-item handling.
3. Item/weight reconciliation and protected evidence; Economy bag-level limitations disclosed.
4. Ready-for-return manifest and route allocation.
5. Acceptance: missing bag produces incident; only accepted items processed; QC failure triggers rewash not delivery.

### Slice D — return delivery and exceptions
1. Grouped return windows; off-schedule surcharge quote and payment authorization.
2. Driver delivery proof, failed attempt, reschedule and customer no-show policy.
3. Partial delivery, damaged/missing item, customer dispute and claims workflow.
4. Notification templates with deduped delivery and fallback.
5. Acceptance: partial delivery cannot mark whole order closed; customer claim traceable to custody chain.

### Slice E — money, Russian compliance adapters and dashboards
1. Double-entry journal, provider webhooks, refunds and chargeback hold.
2. Partner contract accruals, invoices/acts/UPD adapter and reconciliation.
3. Russian KKT/OFD adapter interface and fiscal receipt state machine, implementation gated on selected legal model/provider.
4. Refine ops dashboards: SLA, routes, outstanding claims, unit economics, unpaid invoices; partner dashboard with assigned orders and accruals.
5. Acceptance: no double posting, refund <= captured, failed fiscalization visible, partner never sees customer door code.

## UI navigation
Customer: Home → Address → Services → Tier → Slot → Quote → Confirm/Pay → Track → Delivery → Claim/Repeat.
Courier: Login → Shift → Building stop → Arrive → Scan bag/seal → Economy weigh OR Protected itemize/photo → Customer confirmation → Handoff → Return route → Delivery proof.
Partner: Expected intake → Scan/verify → Discrepancy → Inspection → Batch → QC → Ready → Invoice reconciliation.
Dispatcher: Buildings/Windows → Capacity → Routes → Live exceptions → Courier/partner handoffs.
Finance: Payments → Receipts → Refunds → Partner accruals → Reconciliation → Margin dashboard.
Support: Customer/order lookup → Evidence access reason → Claim → Decision approval → Resolution.

## User scenarios that must become executable tests
A01 competing last slot; A02 stale price/quote; A03 cross-tenant access; A04 replay changed body; A05 expired hold and authorized payment; B01 shared zero-fee pickup; B02 paid exception +500 RUB; B03 Economy bag sealed with weight; B04 Protected high-value item photo + item manifest; B05 offline scan replay; C01 partner bag mismatch; C02 seal broken; C03 partial processing; C04 customer rejects extra fee; C05 QC rewash; D01 customer not home; D02 wrong recipient; D03 partial delivery; D04 damaged garment; D05 claim after closure; E01 duplicate webhook; E02 refund/chargeback overlap; E03 fiscal receipt pending; E04 partner disputed invoice; E05 operator cross-tenant access. Extend to each of the 800 test inventory entries with explicit fixtures and assertions, not blind generated variants.

## First local agent work order (do this before UI)
- Clone repository and checkout docs/foundation-v1.
- npm install, npm run typecheck, npm test, npm run db:generate, npm run db:migrate with disposable PostgreSQL; capture outputs.
- Fix all failing tests, generate/commit actual migrations and package lock.
- Implement full tenant authorization for all reservation commands; test with two organizations.
- Implement expiry sweep, reconciliation and concurrency tests.
- Submit separate Draft PR (or stacked PR) with migrations, tests, CI evidence, docs and a clear next-slice checklist. Avoid overwriting existing PR #1 without explicit coordination.

## Local verification
docker compose up -d postgres (compose file to create);
npm ci; npm run typecheck; npm test; npm run db:generate; npm run db:migrate;
TEST_DATABASE_URL=postgres://... npx vitest run test/slot-postgres.integration.test.ts;
then run API contract and E2E tests. For every PR: list failing and skipped tests explicitly, show PostgreSQL version, migration status and screenshots for UI changes.

## Stop/approval gates
Russian merchant/agent contract and 54-FZ receipt provider, personal-data/video policy, partner terms, compensation policy, and real tariff economics require explicit approval before production. Never present the app as compliant until verified. OSS adoption requires license/version/security review and a proof-of-concept with benchmark. No blanket waiver of mandatory liability.
