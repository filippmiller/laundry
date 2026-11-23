# PR #3 — Remediation wave evidence (2026-11-18)

Working tree of branch `docs/pr2-independent-audit-autonomous-wave`, HEAD `0d04914` + uncommitted work.
Audit under remediation: `docs/audits/PR3_audit/laundry_PR3_audit_2026-11-17/` (findings LAU-R2-001..016).
Gap analysis: `docs/audits/PR3_GAP_REPORT_2026-11-18.md`. Honest scenario register: `docs/coverage/PR3_SCENARIO_STATUS.json`.

**Verdict for this wave: the CI gate is now genuinely green and the four P0 product/security
defects the audit found are closed. The release verdict stays NO-GO** — G3 (money), G5 (217-scenario
coverage) and G6 (resilience/DR) are partial, and G7 (legal, 54-FZ/KKT/OFD, 152-FZ) cannot be
signed by a coding agent.

---

## 1. Gate results on this exact working tree

| Gate | Command | Result |
|---|---|---|
| G1 lint | `npm run lint` | **PASS** — 0 errors, 1 pre-existing warning (`test/scenarios/p0.integration.test.ts` — since deleted) |
| G1 typecheck | `npm run typecheck` | **PASS** — 0 errors (root + `apps/web`) |
| G1 tests | `npm test` | **PASS** — 188 tests / 29 files, 0 skipped, **run twice consecutively with identical results** |
| G1 build | `npm run web:build` | **PASS** — 2436 modules, `dist/web` emitted |
| G0 hygiene | `npm run guard:hygiene` | **PASS** — 205 tracked files, 0 violations |
| G1 supply chain | `npm audit --omit=dev` | **PASS** — 0 vulnerabilities |
| G1 migrations | `npm run db:generate` + `git diff --exit-code -- drizzle` | **PASS** — "No schema changes, nothing to migrate" |
| G1 smoke | `npm run smoke` (fresh disposable PostgreSQL 16) | **PASS** — 11/11 browser checks |

The test count fell from 314 to 188 **because 131 fake tests were deleted**, not because coverage
was lost — see §3.

## 2. What was actually fixed

### G0 — repository data exposure (finding LAU-R2-002)

**The exposure is real and still live.** The remote head of PR #3
(`b4e240f08f214ef5967f9c3c35514636e932430c`) contains **2 409 files / 84 171 191 bytes** under
`.pgdata-drill/` — a complete PostgreSQL data directory — and the branch is **open and public**
(https://github.com/filippmiller/laundry/pull/3). The local branch no longer contains them; the two
histories have diverged, so removing them from the remote requires a **force-push**, which the
master plan explicitly forbids without owner authorisation.

**Safe inventory of the exposed cluster** (`scripts/inventory-pg-cluster.mjs`, counts only — no row
contents were ever printed):

| Item | Finding |
|---|---|
| Databases | `laundry_drill` and `laundry_drill_restored` — exactly the two the drill script creates |
| Organisations | 2 per database: `Демо-прачечная` (the demo tenant) and `Org lh90w1boctm` (a randomly named fixture tenant) |
| Users | 11 — 6 demo personas (`+7999000000X`) + 5 created by `test/fixtures.ts` with `Math.random()` phones |
| Rows | 1 order, 1 quote, 1 order line, 20 seals, 2 customer addresses, 7 outbox events, 7 audit events, 2 notifications |
| **Personal-content rows** | **0** garments, **0** evidence assets (no photos/media), **0** payment intents, **0** ledger entries, **0** support threads |
| Credentials | the superuser password is the drill's hard-coded `postgres_drill_only` |
| **Classification** | **TEST_ONLY** — synthetic demo and test-fixture data only; no real personal data, no payment data, no media |

Two further facts worth the owner's attention:
- the committed cluster **cannot even start** — git does not track empty directories, so the
  published copy is missing `pg_notify`, `pg_logical/snapshots`, `pg_stat` and nine other
  PostgreSQL directories;
- its `PG_VERSION` is **18**, while the plan and CI target PostgreSQL **16**.

**Consequence:** no data-breach notification is required on the evidence available, but the
publication of a raw database directory is a hygiene and precedent problem, and it must be
histories-rewritten to disappear. That is an owner decision — see §5.

Fixes landed in the tree:
- `.gitignore` rule for `.pgdata-drill/` had been written as **UTF-16LE** and was therefore inert:
  `git check-ignore -v ".pgdata-drill"` exited 1 and `git status` still listed the directory as
  untracked, so a `git add -A` would have re-committed ~2 400 PostgreSQL files (~84 MB).
  The rule is now clean UTF-8 and `git check-ignore -v .pgdata-drill` exits 0.
- `scripts/guard-repo-hygiene.mjs` (new) fails the build when the repository **tracks** a
  PostgreSQL cluster, a secret, a media/archive file or a blob over 2 MiB. It reads only tracked
  entries via git plumbing and prints **paths and reasons, never contents**.
- Wired into CI before lint (`.github/workflows/ci.yml`).
- `test/ops/guard-repo-hygiene.test.ts` — 7 tests; the negative half is proven by planting
  violations in a throwaway repository and asserting the real non-zero exit code.
- **Not resolved (owner decision):** the public branch still carries the cluster, and this clone
  has **no git remote**. Nothing was pushed, force-pushed or rewritten.

### G1 — CI was green for the wrong reason (finding LAU-R2-001)
- The `quality` job had **no database**, so `TEST_DATABASE_URL` was unset and every
  `describe.skipIf(!process.env.TEST_DATABASE_URL)` integration block was silently **skipped**.
  CI was green while proving nothing. The job now provisions PostgreSQL 16 and runs the real
  integration suite.
- `scripts/smoke-e2e.mjs` was written against the **old** UI (`Калькуляция`, `Забронировать слот`,
  `.line.total strong`) and would have failed against the refactored customer workspace. It now
  drives the real journey and additionally asserts that **no `0 ₽` placeholder is ever rendered**
  and that the quote price is non-zero and came from the server.
- `test/global-setup.ts` now truncates the `public` schema before every run. The persistent
  cluster used to make the suite depend on how many times it had been run: the `outbox_events`
  backlog grew until `processOutbox` (bounded at 500 claims) never reached the newest events,
  which made `npm test` fail on a repository that had simply been tested a few times.

### G2 — evidence object scope (finding LAU-R2-006)
`src/services/workspace.ts` previously authorised evidence **only** for `ownerType === "order"`, and
`listEvidence` returned the object storage key to the API. Now:
- ownership is resolved per owner type (`order`, `claim`, `custody_event`) and **denied by default**;
- `laundry_operator` is scoped to the orders assigned to that partner instead of every order in the tenant;
- the uploader no longer gets an implicit right to read the evidence back;
- `objectKey` is no longer selected at all, so no route can leak it;
- deleting evidence **tombstones** it instead of deleting the access-event and legal-hold rows —
  the audit trail survives.
- `test/security/evidence-abac.integration.test.ts` — 13 tests, including cross-customer, cross-tenant,
  wrong-partner, unknown-owner-type and unauthenticated cases.

### G2 — CSRF on every unsafe method (finding LAU-R2-009)
`assertTrustedOrigin` returned early for anything that was not a POST, leaving the cookie-authenticated
DELETE routes (`/addresses/:id`, `/reviews/:id/like`, `/admin/members/:id/roles/:role`) open to a
cross-site request. The check now covers POST, PUT, PATCH and DELETE.
`test/security/csrf-unsafe-methods.integration.test.ts` — 6 tests.

### G3 — money: a voided invoice could still be captured
`capturePayment` selected the invoice of an order **without filtering on its state**, so a capture
against the invoice cancelled by "partner returns the order unprocessed" was accepted and the
customer became payable for an order that was never processed. Now a non-`open` invoice is refused
with `FINANCIAL_HOLD / INVOICE_NOT_PAYABLE` and no payment intent is created.
`test/api/finance-capture-invoice-state.test.ts` — 4 tests.

### G3/G4 — seven missing HTTP contracts (finding LAU-R2-004)
The web client called seven endpoints that did not exist. All are now registered through the same
`add({...})` helper (so they inherit session auth, Zod validation, role checks and OpenAPI parity),
each with positive and negative tests:

| Endpoint | Authorisation | Tests |
|---|---|---|
| `GET /finance/overview` | finance roles; tenant scoped | `test/api/finance-overview.test.ts` (5) |
| `GET /documents/:kind/:id` | object scoped per role; carries a non-fiscal disclaimer | `test/api/documents.test.ts` (8) |
| `POST /partner/orders/:id/return-unprocessed` | assigned partner only | `test/api/partner-return-unprocessed.test.ts` (8) |
| `POST /admin/members/:id/state` | admin; last-active-admin guard; revokes sessions | `test/api/admin-member-state.test.ts` (7) |
| `POST /auth/otp/request` | fake provider only; 404 in production; hash-only storage | `test/api/otp.test.ts` (7) + `otp-rate-limit.test.ts` (1) |
| `POST /auth/otp/verify` | constant-time compare, TTL, attempt cap | `test/api/otp.test.ts` |
| `POST /auth/preview-unlock` | server-side role allowlist, seeded identities only, audited | `test/api/preview-unlock.test.ts` (9) |

Two further defects were found while doing this and fixed:
- **route rate limits were never enforced** — routes were registered before `@fastify/rate-limit`
  decorated the instance, so no `x-ratelimit-*` header was ever produced. Registration now happens
  in `app.after`, and the declared budgets are live for the first time.
- **a malformed body answered 500 instead of 400** — the error handler had no 400 branch.

### G5 — the customer portal was a lie (finding LAU-R2-003)
`apps/web/src/workspaces/CustomerWorkspace.tsx` was 76 lines: a hardcoded `0 ₽` total, a success
toast fired by a button that called no API, three empty tabs, and every unused import hidden behind
an underscore rename (`api as _api`). It is now a real journey — quote → hold both windows → book →
invoice → fake-provider payment → history → claims → cancel → reschedule → address book →
support threads — with **every number coming from a server response**, honest empty states, real
error codes, and Russian labels. Lane-level verification: 27/27 API checks and 11/11 Playwright
browser checks; the CI smoke job now repeats the browser journey on every push.

`AuthLanding` is deliberately **not** mounted: the OTP provider is a labelled `fake` that answers
`404` in production, so exposing it would be dishonest.

### G0/G1 — the lint loophole that hid the stub
`eslint.config.mjs` set `varsIgnorePattern: "^_"`, which is what allowed the stub to keep every dead
import. That escape hatch is removed (unused *arguments* may still be marked `_`); `npm run lint`
stays at 0 errors.

---

## 3. Fake coverage removed

`test/scenarios/p0.integration.test.ts` contained **130 `it()` blocks of which 113 asserted nothing
about the system** (`expect(true).toBe(true)`, `expect("org1").not.toEqual("org2")`), and
`test/generated-scenarios.test.ts` only parsed the catalog JSON. Both inflated the suite while
proving nothing — exactly the "never fake 217/217" failure the master plan forbids. They were
replaced by:

- `scripts/generate-scenario-status.mjs` → `docs/coverage/PR3_SCENARIO_STATUS.json`: one entry per
  catalog scenario with a truthful status (**all 217 currently `SPEC`** — no scenario is executed
  *by its id*), plus an `executed_proofs` section naming the ten areas that do have real, executed
  coverage.
- The same script regenerates `docs/coverage/PR3_SCENARIO_EXECUTION.csv` — **265 rows** covering the
  12 original E2E journeys, the 36 cross-role flows and the 217 catalogue scenarios. The previous
  wave's verdicts and its stale commit SHA are preserved in `previous_wave_status` /
  `previous_wave_commit`; the current `status` column never presents them as current.
- `test/scenarios/scenario-status.test.ts` (6 tests): the register must cover the catalog exactly
  once, an executed status is impossible without an evidence pointer that exists on disk, the
  vocabulary is closed, the execution CSV must account for every item, and the register must stay in
  sync with the catalog.
- `test/scenarios/critical.integration.test.ts` was rewritten: it previously claimed to verify
  "AU-001: Verified landing" while only asserting that an array is an array; it now proves that a
  customer never sees another customer's address inside the same tenant.

## 4. Still open (not fixed in this wave)

| Finding | State |
|---|---|
| 007 auth | OTP is a labelled fake provider, absent in production. A real SMS provider and legal sign-off are required. |
| 008 routing | `src/services/routing.ts` still hashes building ids into fictitious Moscow coordinates and is **not** gated `SIMULATION_ONLY`. |
| 009 (rest) | Origin check is now on all unsafe methods, but there is still no dedicated CSRF token — only Origin/Referer. |
| 010 outbox | A DB row with `channel:"push"` is still not a delivered notification; no backoff, dead-letter or provider receipt. |
| 011 payment inbox | Events are still applied in one transaction, so an inner caught exception can still commit partial state. |
| 012 evidence | No upload pipeline, no MIME/size verification, `retention_until` is written but never read, and there is no `deleted_at` column (the tombstone overloads `expired`). |
| 013 scenarios | 217 scenarios remain `SPEC`; 36 cross-role journeys are still not executed. |
| 015 backup | `npm run db:drill` still clones a template on the same cluster and is not run by CI. |
| 016 docs | **Fixed for the README** — it now states 188 tests / 29 files as of 2026-11-18 instead of 92. `docs/coverage/PR3_SCENARIO_EXECUTION.csv` is regenerated from the catalogue; `docs/coverage/PR3_REQUIREMENT_TRACEABILITY.csv` was not re-verified. |

## 5. Repository state

- **No git remote is configured in this clone.** Nothing was committed, staged, pushed, force-pushed
  or merged; PR #3 remains untouched and open. Committing and pushing require the owner's go-ahead
  and a configured remote.
- The audit bundle now exists in exactly **one** place (`docs/audits/PR3_audit/`); three duplicate
  copies were removed.
- `apps/web/src/App.tsx.bak` (the legacy 44 KB backup) was removed.
- The working tree still contains untracked files from earlier sessions that were not authored here
  (`.agents/**`, `scripts/browser-role-smoke.cjs`); they were left untouched.
