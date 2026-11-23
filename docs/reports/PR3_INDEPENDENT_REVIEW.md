# PR #3 — Independent Dual Red-Team Review Record (2026-11-19)

**Audit scope:** commits `bd48e57..388ddee` (Waves 1–4A: UI primitive system, WCAG 2.2 AA, Group A finance/partner, Group B orders/security, Group C reliability/infra, 217-scenario & 36 cross-role catalog execution)  
**Remediation commit:** `b6ae600` (`test/wave4b-remediation.integration.test.ts` + `drizzle/0024_backfill_legal_holds_and_paid_invoices.sql`)  
**Reviewers:** Cold Red-Team Reviewer (`pro` model, fresh context) + OpenAI Codex (`gpt-6.2-sol`), independent from the Wave 1–4A implementation turns.

---

## Verdict

- **Code-level P0/P1 findings:** **20 / 20 closed and verified** on commit `b6ae600` (with 12 targeted regression suites in `test/wave4b-remediation.integration.test.ts`, migration `0024`, and updated `smoke-e2e.mjs` / `smoke-local.mjs`).
- **Remaining open items (`bd list --status=open`):** **3 human/owner-only gates** (`lnd-9l7`, `lnd-5me`, `lnd-8ev`), plus **10 `BLOCKED`** catalog scenarios requiring external hardware/providers (SMS carrier, live acquiring, 54-FZ KKT/OFD, real geocoding/routing engine, off-host PG16 PITR/DR, device camera) and **70 `SPEC`** catalog scenarios deferred beyond this slice.
- **Release status:** Ready for controlled demo / pre-pilot review; **NOT** authorized for live production launch until the 3 owner gates and external provider integrations are completed.

---

## 20 P0/P1 Findings Caught and Closed (Commit `b6ae600`)

### A. Financial & Concurrency Locks

| # | Severity | Finding | Root Cause & Fix | Regression Evidence |
| --- | --- | --- | --- | --- |
| 1 | P0 | Concurrent `decideAdjustment` race | Distinct idempotency keys raced on `orderAdjustments.state` and `orders.version`. Added `SELECT id FROM orders ... FOR UPDATE`, conditional `UPDATE order_adjustments ... WHERE state = 'proposed' RETURNING`, and `.returning()` version check in `src/services/partner.ts`. | `wave4b-remediation` test `1a` |
| 2 | P0 | Open-invoice mutated after concurrent payment | Between reading an open invoice and updating its total, a concurrent payment could mark it `paid`. Added conditional `UPDATE customer_invoices ... WHERE state = 'open' RETURNING` and atomic fallback to issuing a separate `supplementalInvoiceId` (`src/services/partner.ts`). | `wave4b-remediation` test `1a` |
| 3 | P0 | `decideAdjustment(returnUnprocessed)` financial/capacity leaks | Did not reject already-charged orders (`ORDER_ALREADY_CHARGED`), did not cancel open invoices, did not release live `held`/`confirmed` slot reservations, and lacked version CAS. Fixed all four in `src/services/partner.ts`. | `wave4b-remediation` test `1b` |
| 4 | P0 | Invoicing `returned_unprocessed` orders | `createCustomerInvoice` (`src/services/finance.ts`) could still invoice an order returned unprocessed. Added `SELECT ... FOR UPDATE` on `orders` plus check for `garments.status = 'returned_unprocessed'` or `order.return_unprocessed` outbox event (`FINANCIAL_HOLD / ORDER_RETURNED_UNPROCESSED`). | `wave4b-remediation` test `1b` |
| 5 | P0 | Concurrent `receiveHandoff` double-accrual | Distinct idempotency keys on `receiveHandoff` could race before `orders.lifecycle_state` advanced and double-credit `partner_service_accruals`. Added `SELECT id FROM orders ... FOR UPDATE` and `.returning()` version guard (`src/services/partner.ts`). | `wave4b-remediation` test `1c` |
| 6 | P1 | Accrual reconciliation & negative invoiced reversal | `reconcilePartnerAccrualsForOrder` could overwrite concurrently invoiced rows; `voidPartnerAccrualsForOrder` failed to reverse negative already-invoiced accruals. Added `WHERE status = 'estimated' RETURNING` guards and symmetric negative/positive reversal entries (`src/services/partner.ts`). | `wave4b-remediation` test `1d` |
| 7 | P0/P1 | Partner invoice ledger gap, NULL-creator SoD bypass, analytics payable undercount | `createPartnerInvoice` omitted `processing_expense` / `partner_payable` journal posting; `approvePartnerPayout` allowed `createdBy === NULL` (`403 DUAL_CONTROL_REQUIRED` now enforced); `financeAnalytics` deducted unapproved `scheduled` payouts instead of `WHERE state IN ('approved', 'paid')` (`src/services/finance.ts`, `src/services/finance-analytics.ts`). | `wave4b-remediation` test `1e` |

### B. Delivery & Pickup Stop Lifecycle

| # | Severity | Finding | Root Cause & Fix | Regression Evidence |
| --- | --- | --- | --- | --- |
| 8 | P0 | Partial delivery recovery never completed order | `recordDeliveryAttempt` (`src/services/delivery.ts`) checked `uniqueDelivered.size === allGarments.length` instead of `outstandingDelivered.length === pendingGarments.length`, stranding recovered orders in `out_for_delivery`. Fixed set comparison. | `wave4b-remediation` test `2a` |
| 9 | P1 | Missing stop CAS & stale version on reassignment | Added `inArray(routeStops.state, ["pending", "en_route", "arrived"])` + `.returning()` CAS on `recordDeliveryAttempt` stop transitions, and bumped `routeStops.version` when `assignPickup`/`assignDelivery` supersedes stops to `rescheduled` (`src/services/delivery.ts`). | `wave4b-remediation` test `2b` |
| 10 | P0 | Pickup courier kept ABAC access after partner handoff | `receiveHandoff` (`src/services/partner.ts`) left pickup `route_stops` active, allowing the pickup courier to keep reading/scanning the order post-handoff. Now transitions active pickup stops to `completed` with bumped `version`. | `wave4b-remediation` test `2b` |

### C. Evidence Security, Legal Holds & Populated-DB Backfill

| # | Severity | Finding | Root Cause & Fix | Regression Evidence |
| --- | --- | --- | --- | --- |
| 11 | P0 | Foreign-order evidence attachment in `recordIntake` | `recordIntake` (`src/services/intake.ts`) checked org and `verified` status only, allowing evidence from another order in the same tenant to be linked. Added order/garment/custody_event/claim ownership check + `isNull(evidenceAssets.deletedAt)`. | `wave4b-remediation` test `3a` |
| 12 | P1 | Tombstoned evidence leaked in `loadOrderView` | `loadOrderView` (`src/services/orders.ts`) checked `ne(evidenceAssets.status, "expired")` without `isNull(evidenceAssets.deletedAt)`. Added `isNull(evidenceAssets.deletedAt)` filter. | `wave4b-remediation` test `3a` |
| 13 | P0 | Customer deletion of staff evidence & delete-vs-hold race | `deleteEvidence` (`src/services/workspace.ts`) did not restrict non-support callers to `asset.createdBy === principal.userId`, and lacked an atomic conditional `UPDATE` checking `legalHoldCount = 0`, `deletedAt IS NULL`, and `NOT EXISTS (active evidence_legal_holds)`. Fixed both. | `wave4b-remediation` test `3a` |
| 14 | P0 | `reopenClaim` lacked version CAS & lost legal-hold protection | Added `.returning()` version check and re-placed active `evidence_legal_holds` rows on prior held (or order claim-purpose) evidence when reopening a decided claim (`src/services/claims.ts`). | `wave4b-remediation` test `3a` |
| 15 | P1 | Pre-upgrade drifted holds & open paid invoices | Added idempotent migration `drizzle/0024_backfill_legal_holds_and_paid_invoices.sql` to reconcile `evidence_assets.legal_hold_count` / `status` against active holds and mark pre-upgrade `open` `customer_invoices` as `paid` when captured `payment_intents` cover cumulative totals. | `wave4b-remediation` test `3b` |

### D. Payment Inbox, Outbox Lease Reclaim & API Ordering

| # | Severity | Finding | Root Cause & Fix | Regression Evidence |
| --- | --- | --- | --- | --- |
| 16 | P0/P1 | Payment inbox intent lock, chargeback overwrite & stuck processing | Added `SELECT ... FOR UPDATE` on `payment_intents`, guarded against `refunded` overwriting `disputed`/`chargeback_lost`, and added 5-minute (`PAYMENT_INBOX_LEASE_MS`) stale `processing` lease reclaim (`src/services/payment-inbox.ts`). | `wave4b-remediation` test `4a` |
| 17 | P1 | Outbox worker stuck rows on crash | Added 5-minute (`OUTBOX_LEASE_MS`) stale `processing` lease reclaim in `processOutbox` (`src/services/outbox.ts`) without touching active fresh leases. | `wave4b-remediation` test `4b` |
| 18 | P1 | Non-deterministic `GET /api/v1/orders` ordering | Added `.orderBy(desc(orders.createdAt))` before `.limit(100)` (`src/api/server.ts`) so newest orders are never truncated behind older heap rows. | `wave4b-remediation` test `4c` |

### E. Web UI & Browser Smoke E2E

| # | Severity | Finding | Root Cause & Fix | Regression Evidence |
| --- | --- | --- | --- | --- |
| 19 | P1 | `Router` `demo === null` blank screen & supplemental invoice unpayable | `Router.tsx` returned `null` for `customer` when `demo === null`; `CustomerWorkspace.tsx` disabled payment when any prior payment was `captured` instead of checking `hasPayableInvoice` (`invoice.state === "open" && invoice.totalKopeks > 0`) and required non-null `demo`. Fixed both. | `npm run typecheck`, `npm run web:build`, `smoke-e2e.mjs` |
| 20 | P1 | Broken toast selector & Windows cleanup in `smoke-e2e.mjs` / `smoke-local.mjs` | Updated toast locator from `.notice.ok` to `[role="status"] .toast.toast--ok`, added `.data-row` / `ждёт` to fiscal state check, parameterized `SMOKE_API_PORT`, and added `rmSync` retry tolerance on Windows. | `npm run smoke` (`11/11` `SMOKE_OK`) |

---

## Remaining Open Owner Gates (`bd list --status=open`)

1. **`lnd-9l7` (P0 — Owner decision):** Public `.pgdata-drill` exposure & GitHub history retention, local `%LOCALAPPDATA%/Temp/pgdrill` manual deletion, and SMS provider provisioning authorization.
2. **`lnd-5me` (P2 — Owner decision):** Lifecycle of the public preview demo instance (`https://laundry.filippmiller.com`) and owner sign-off on real pilot prerequisites (real auth/SMS, acquiring, 54-FZ KKT/OFD, real routing, off-host backups).
3. **`lnd-8ev` (P2 — Owner/Legal decision):** Russian legal/compliance gates register (consumer law, principal vs. agent role, 54-FZ/OFD, 152-FZ & video retention, partner terms, refund policy, unit economics).

---

## Return Verification Closure Wave (post-4dd3e988)

Following the independent return verification of commit `4dd3e988e973e9a41b7e6b8e34b9ffa9de105218` (which closed 6/7 CLS items, left `CLS-006` partial, and opened two P2 findings `R2-001` and `R2-002` plus evidence/documentation gaps):

### 1. Code Fixes Closed

| ID | Severity | Fix Summary | Verification Evidence |
| --- | --- | --- | --- |
| **R2-002** | P2 | Extracted shared `queryPartnerAccrualTotals` (`src/services/partner-payable.ts`) used by both `computePartnerBalanceTx` (`src/services/finance.ts`) and `financeAnalytics` (`src/services/finance-analytics.ts`). Each disputed accrual holds only `GREATEST(0, amount_kopeks - non_rejected_credit_notes)`, preventing double-deduction of prior partial credits while preserving real advances/overpayments, canonical `partners FOR UPDATE` locks, and approved ledger immutability. | `EXECUTED_LOCAL`: `test/api/wave5-finance-workers.test.ts` (`R2-002` test — verifies net hold = remainder, `advanceKopeks = 0`, independent `1000` accrual fully payable, release on rejection, `createPartnerPayout` bounds, and real advance preservation). |
| **R2-001** | P2 | Extracted `createChargebacksController` (`apps/web/src/workspaces/chargebacks-controller.ts`) with a single `loadingMode` (`"idle" \| "initial" \| "more"`) owned by request generation + `AbortController`, atomic `committedFilter` + `bucket`/`nextCursor` transitions, inline error/retry banner (`failedFilter`), and React `<StrictMode>`-safe lifecycle wiring in `apps/web/src/workspaces/FinanceWorkspace.tsx`. | `EXECUTED_LOCAL`: `test/web/chargebacks-controller.test.ts` (`3/3` controlled deferred-promise tests) + `scripts/verify-closure-browser.mjs` (`Scenario B`, `8/8` headless Chromium checks). |

### 2. Verifiable Specialized Proofs & Local Gates (`EXECUTED_LOCAL`)

- **Full Local Test Suite & Hygiene:** `EXECUTED_LOCAL` (`66 test files / 441 tests`), with `npm run guard:hygiene` executed after staging all tracked files.
- **Logout 503 (`LND-PRO-010`):** `node scripts/verify-closure-browser.mjs` (`Scenario A`, `9/9` PASS in headless Chromium) — verifies session cookie present, `[data-testid="pending-logout-banner"]` and `localStorage` marker on HTTP 503, cookie retained on 503, page reload retries `POST /api/v1/auth/logout` before `GET /api/v1/me`, successful retry clears banner/marker and revokes session (`GET /api/v1/me -> 401`), 0 `pageerror`.
- **Chargebacks UI + R2-001 (`CLS-006` / `R2-001`):** `node scripts/verify-closure-browser.mjs` (`Scenario B`, `8/8` PASS in headless Chromium) — verifies 50/52 initial page, pending load-more (`Загрузка…`) preempted by status filter change without sticking, subsequent pagination loads 52/52, simulated HTTP 500 replacement shows `[data-testid="chargebacks-error-banner"]` while preserving committed rows, retry recovers cleanly, 0 `pageerror`.
- **Populated `0025 -> 0026 -> 0027` Migration Upgrade (`OBS-003`):** `npx tsx scripts/verify-populated-upgrade.ts` (`POPULATED_UPGRADE_0025_TO_0027_PASS`) — boots disposable embedded PostgreSQL (`laundry_upgrade_0025_0027`), applies ONLY `0000..0025`, seeds a pre-0026 active claim direct `verified` evidence asset (0 holds) and a pre-0027 invoice line with 2 duplicate active disputes (`open` + `investigating`), applies `0026..0027`, and verifies:
  - BEFORE: `asset={status:"verified", legal_hold_count:0}`, `activeHolds=0`, `disputes=[open, investigating]`
  - AFTER: `asset={status:"legal_hold", legal_hold_count:1}`, `holds=[{reason:"backfill_active_claim_direct_attachment", released_at:null}]`, `disputes=[resolved, investigating]`, `partner_disputes_one_open_per_line_unique` (`23505`) enforced, re-migration strict no-op.
- **Legacy-Data Decision & Historical Outbox Requeue:**
  - `LEGACY_DIAGNOSTICS` applies strictly to the disposable upgraded test DB (`laundry_upgrade_0025_0027`), recording `duplicateActiveDisputesRemaining = 0`, `disputedFlagDriftRows = 0`, `overCreditedLines = 0`, and `before/after` stuck outbox counts (`0 -> 0`, `historicalOutboxRequeueStatus: NOT_APPLICABLE_0_AFFECTED`). If upgrading a pre-existing external DB, run the same diagnostic queries before applying `0027` to log any duplicate-dispute survivor mappings or historical over-credits.
- **Internal Cold Goldfish Review (`STATIC_REVIEWED`):** Internal agent pre-implementation spec review and post-implementation diff review completed (caught and fixed a React `<StrictMode>` ref-disposal blocker in `FinanceWorkspace.tsx` and an undrained child-process pipe nit in `scripts/verify-closure-browser.mjs`). External independent review of the newly published commit remains `PENDING` until re-verified on the published SHA.
- **Hosted CI Status:** `PENDING` at commit time (final CI run link and checkout SHA recorded in PR #3 body after push; baseline CI run #62 on `4dd3e988` was `CI_VERIFIED` green with 65 files / 437 tests / 11 smoke checks).
