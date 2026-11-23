# PR #3 — autonomous engineering waves, ownership, acceptance gates
**Version:** 2026-11-16 | **Target:** the existing Draft PR https://github.com/filippmiller/laundry/pull/3  
**Baseline audited SHA:** `9bd9d2cd9c5f5551d87184942df790dbbbe76830` (read again at execution).  
**Primary audit:** `docs/audits/PR3_ADVERSARIAL_READINESS_AUDIT_2026-11-16.md`.

## Objective and change-control rule

Turn the working **demo backend** into a safe, operationally useful **multi-role internal pilot candidate** while respecting the original Russian laundry business model (Economy bag/weigh vs Protected itemized, mixed physical separation, shared building-window pickup/return, consented +500 RUB illustrative individual stops, laundry partner processing, verifiable custody, claims, accounting). **Do not replace the modular monolith or make an ERP the system of record.**

**The owner explicitly instructs: push all implementation, tests, audit receipts, screenshots and the final handoff to the SAME existing Draft PR #3 / branch `docs/pr2-independent-audit-autonomous-wave`. Do not create another PR.** This supersedes the older mandate's “create a new Draft PR” instruction. Keep PR #1 and PR #2 untouched, keep PR #3 Draft and retain its current target/stack until the owner approves a merge strategy. Never force-push or merge. The user explicitly authorizes a coding agent to commit/push to PR #3; Beads/conservative defaults do not override this explicit authority. Do not mutate live databases, external customers, live payments, DNS or production.

## Agent organization: orchestrator + independent subagents

Create Beads tasks/dependencies in the actual Dolt-backed `bd` store, using `bd prime`, `bd ready`, `bd show` and `bd update --claim`. Do **not** treat `.beads/issues.jsonl` as source of truth; sync via `bd dolt push/pull` only after verifying remote setup and safe lease. Do not randomly claim old broad-closed epics.

The **integrator** alone owns final PR #3 branch, schema/migrations, PR description and hosted CI. Use separate local git worktrees/branches with explicit file ownership for parallel implementers; review patches and fast-forward/cherry-pick in dependency order. Commit/push only current agreed head; fetch and lease-check before every push, no force. Do not let two agents edit a single schema/route file concurrently.

Recommended subagent cells:
- **Architecture & requirements (research):** reconcile each historical doc, route inventory, schema and Beads; maintain source-of-truth coverage/status ledger (read-only except report).
- **Security (builder + independent tester):** API RBAC/ABAC, CSRF, auth, object-level checks, idempotency replay and P0 regression tests. Give server route ownership to one agent at a time.
- **Booking & finance (builder + independent auditor):** reservation–quote–payment saga, monetary correctness, refunds/chargebacks, fiscal adapter stubs, concurrency and transactional DB gates.
- **Custody & partner (builder + independent auditor):** explicit partner assignment, scanned assets, dual confirmation, item and bag-level reconciliation, QC/rewash, failed/partial delivery, evidence/claims.
- **Product UX (builder):** reusable React architecture, customer/partner/dispatch/support/finance role views and mobile courier usability; do not grant permissions client-side.
- **Routing, offline, OSS provenance (builder/research):** scanner/manual fallback, IndexedDB replay, VROOM/OSRM feasibility, pinned licenses and deterministic datasets.
- **QA adversary (independent):** build black-box HTTP and Playwright E2E, migration/restore/performance/failure-injection evidence; may design tests in parallel but must review post-integration HEAD.
- **Cold review group (independent after implementation):** security, accounting, operations/custody, privacy/legal-boundary and product/UX lenses; one red-team synthesis. A subagent must not certify its own code.

All subagent outputs require: initial/final SHA, finding or requirement ID, changed files, tests with exact commands, limitations, owner/integrator acceptance. Cheap research agents can map/read, capable coding agents handle transactions/auth/migrations, strongest independent agent adjudicates P0/P1 and wave exit.

## Dependency-aware execution plan

### W0 — exact-head baseline, reproducibility and issue map (first)
- Fetch PR #1/#2/#3; compare and confirm PR #3 is the working branch. Run `git status`, `git fetch`, `git rev-parse HEAD`, `bd prime`, inspect all docs. Run `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run web:build`, `npm audit --omit=dev`, `npm run db:generate` with drift diff, fresh PostgreSQL migrations, and `npm run smoke` with API running; capture exact logs. Preserve original failures before fixing.
- Build `docs/coverage/PR3_REQUIREMENT_TRACEABILITY.csv`: `requirement_id,slice,role,source_doc,implementation_path,endpoint,ui_path,test_id,status,evidence_sha_or_url,remaining_gap`. Include all S01..S16, E2E-001..012 and existing 30 cross-slice journeys.
- Create focused Beads for each LND3-P0/P1, link dependencies and never blanket-close epics.
- **Exit:** baseline and hosted run receipts are identified; every P0 has a proposed failing regression test; PR branch safety confirmed.

### W1 — access-control and session hardening [BLOCKING]
Implement **LND3-P0-01,02,03,06** and auth/seed portion of P1-05. Centralize policy enforcing `organization + actor + role + partner + object ownership + field projection` at service and route layers. Make protected list/read endpoints deny by default. Prevent cross-actor idempotency replay even if actor has learned the key; verify request fingerprints and revoked sessions. Partner work requires authenticated, **preexisting dispatch assignment** and current contractual scope. Claims can reference **only items/assets belonging to the order** and authorized purpose, with auditable access. Fake/demo role assignment and seed routes must be unreachable in any internet-facing environment, with explicit production-mode denial tests. Review CSRF/cookie/origin, session rotation/rate limits and invitation/OTP provider boundary.
- **Proof:** table-driven GET and mutation tests per role, 2 tenants, 2 partners, 2 customers; deny foreign objects with safe 403/404 and no sensitive fields; no protected data on replay; verify production-mode exposed routes. Do not declare W1 complete if any P0 auth reproducer still passes unsafely.

### W2 — bookings and money as a coherent transactional saga [BLOCKING]
Implement **LND3-P0-04,05,07**. Bind pickup+delivery capacity holds to owner, address/building, window kind, accepted quote/version and order. Avoid scheduling with no valid capacity; serialize expiry/confirmation/compensation. Payment provider remains FAKE and **local only**, with customer attempts never treated as real settlement. Use DB row locks/conditional balance updates and uniqueness for one authorized capture per chargeable obligation. Refunds must withstand 2–50 concurrent different keys and overlapping chargeback/duplicate webhook. Signed webhook adapter uses a test-secret simulator, durable inbox processing and explicit retry/failed states. Preserve separate invoice/payment/fiscal/partner-ledger state machines; KKT remains stub.
- **Proof:** barrier-controlled competing DB transaction tests, no oversell or negative capacity, 100% idempotent post/void/refund, `refund_total <= settled_capture`, duplicate provider event posts once, no paid impossible slot and no fake `registered` fiscal receipt. Tests must inspect rows and outbox, not only HTTP status.

### W3 — physical custody, partner, claims and delivery invariants [BLOCKING]
Implement **LND3-P1-01,02,03** and remaining P0-02/06 tests. Explicit partner assignment/consented transfer; two independently authenticated parties (or documented exception) confirm custody. Opaque bag/seal IDs, verified scanner/device assignment and server-recomputed payload integrity; reorders/conflicts shown, not silently accepted. Economy bag may complete with bag-level proof; Protected needs item-level exact-set coverage; mixed mode keeps physically distinct manifests. QC cannot pass on a subset; failing QC leads to assigned rewash/hold; accepted adjustment creates proper versioned consent, processing/billing delta or safe cancellation/return; rejected adjustment never forces work. Partial delivery creates a next actionable stop + outstanding item state; duplicate IDs cannot close a missing item. Claims prove item and evidence ancestry.
- **Proof:** 12 seeded cross-role custody cases incl. wrong partner, wrong seal, mix-up, lost item, repeated scans, client declines new price, QC fail/rework, bag-only delivery, partial/failure then successful reattempt. Verify garment/container/stop/journal/custody/audit state snapshots before/after.

### W4 — real role-specific applications and navigation
After W1–W3 backend contracts stabilize, split `apps/web/src/App.tsx` into tested components/pages using appropriate maintained, pinned and permission-compatible OSS dependencies. Provide six **working—not empty—browser workspaces**:
1. Customer: building/address, service catalog, Economy/Protected/mixed, two window fees, quote/consent, order tracking/history, invoice, adjustment, claim.
2. Courier: shift/assigned stops, scan/manual fallback, intake/dual-confirmation, not-synced state, delivery attempts/proof/retry.
3. Partner: assigned incoming manifests, discrepancy, inspection and consent request, batching, QC/rework, ready and contract/invoice view.
4. Dispatcher: capacity/windows, grouped routes, shifts, assignments, failed/partial stops, exceptions.
5. Support/claims: scoped lookup, evidence/legal hold, review and decision timeline, reopen.
6. Finance: role-scoped captures, refunds, partner accruals/disputes, ledger and reconciliation with **clear fake-provider labeling**.
- **Proof:** Playwright **real browser** flows at narrow mobile and desktop viewport, screenshots/traces, keyboard/error/empty/loading states, forbidden-role guards tested at API; Russian language, RUB minor-unit correctness and local timezone formatting.

### W5 — scanner, offline reliability, route optimization and reuse-first engineering
- Assess Refine, scanner libraries (`@zxing/browser` or alternative), VROOM, OSRM/legally sourced matrix, Ownfleet, Chatwoot and optional notifications. Recheck exact versions, upstream commit/license, subpackages, security, maintenance, Russian fit, deployment footprint. Record `docs/third_party/REUSE_DECISIONS.md`, `THIRD_PARTY_PROVENANCE.csv`, `LICENSE_NOTICES.md` and SBOM. Distinguish **dependency used**, **source copied/adapted**, **separate service integrated**, **architecture reference**. No invented source ports or AGPL/ELv2 copying.
- Implement camera scan + accessible manual fallback, durable IndexedDB queue with device-binding, expiry, retries and visible pending/rejected/reconciled states. Offline browser reload and two-device/duplicate/reorder tests.
- Integrate a VROOM adapter behind a feature flag only if reproducible and beneficial; fallback manual grouping by building/window. Benchmark at least 3 deterministic datasets (small, mixed pick-up/drop-off, infeasible capacity) against naive plan: distance/time/late stops with provenance of matrix. Never fabricate GPS/real-world savings or send personal location data to unapproved services.
- **Proof:** genuine useful third-party reuse, licenses checked, offline capture during loss/recovery and idempotent replay; route plan reproducibly improves or safely falls back.

### W6 — outbox/media/operations, Russian legal boundaries
Implement LND3-P1-04 and P1-07. Durable outbox: lease, retry/backoff, dedupe, poison/dead-letter and metrics; local fake SMS/mail/push only. Private evidence upload with MIME/size/hash verification, order ownership, short-lived authorized access, logged views, retention and legal-hold deletion prevention. Ensure access controls, personal-data minimization, structured logs with redaction, health vs readiness, error and queue metrics, idempotent migrations, CI upgrade from PR #1 populated DB, backup/restore in disposable test environment. Container startup must not use `dev:api` or silently destructive migration; separate reviewed migration job and app runtime. Update README as truth, preserve historical notes and open professional legal decision register.
- **Proof:** worker retries under injected failures without duplicate external actions; restore consistency of orders/finance/custody; staged anonymized upgrade; no secrets leaked; prod setting denies demo; no real users, money or production deploy.

### W7 — broad scenario acceptance & reliability checks
- Execute **E2E-001..012** as independent end-to-end journeys across roles and where applicable devices; expand the **30** cross-slice journeys in `SECOND_PASS_REVIEW.md`. Each must have preconditions, actor, DB/API/browser/action/event expected outcomes, plus failure case; no generated clones accepted as unique evidence.
- Add **>=5 meaningful new executable assertions per S01..S16** (>=80 distinct assertions) focusing on authorization, idempotency, concurrency, fault injection and misuse. Map all 800 matrix IDs to `PASS/FAIL/BLOCKED/NOT_RUN/NOT_APPLICABLE`, with source test links; 800 rows ≠ 800 passes. PR #3 must include machine-readable coverage receipts and screenshots/traces. 
- Run exact-HEAD hosted CI and local quality gates; upgrade/downgrade safety plan and repeatable reset; no `SKIPPED` or `TIMEOUT` counted as `PASS`.
- **Proof:** `docs/coverage/PR3_SCENARIO_EXECUTION.csv`, `docs/reports/PR3_TEST_EVIDENCE.md` with exact SHA, command, count, outputs, CI URLs, operating system and DB version.

### W8 — independent Goldfish/Red-team review and handoff
- Separate reviewers who did not implement the relevant code re-audit: auth/IDOR & CSRF, DB concurrency and money, custody/offline and partner separation, UX/accessibility, OSS/license/privacy, migration/DR. Require explicit CLOSED / OPEN / UNVERIFIED per audit finding, linked regression tests and independent traces.
- Fix all true P0, repeat review until no P0 remains; classify P1 release-gating vs deferred with owner/risk/mitigation. Update original requirement→implementation→test→evidence crosswalk; clean Beads with real statuses, not declarations.
- Post final handoff **as a comment to the SAME PR #3**, update its description with the final HEAD and links to source/test/screenshot receipts; retain Draft. Owner decides integration/merges and deployments separately.

## Release/readiness criteria (do not collapse them)

| Gate | Minimum | What does **not** count |
| --- | --- | --- |
| G1 Engineering stable | W0 baseline repeatable, no newly failing lint/typecheck/migration, hosted exact-SHA CI quality+smoke green | Old PR #2 run or canceled/skipped jobs |
| G2 Security trustworthy | All LND3-P0 access/ownership/actor replay findings regression-tested; customer/partner/role negative matrix green | UI-hidden links, a single tenant test |
| G3 Money & booking correct | Concurrent booking/capture/refund/wallet/chargeback and webhook failure tests green, no duplicate sources, real provider disabled | Fake-paid UI banner, 1 sequential refund test |
| G4 Custody correct | Partner only assigned work; signed/confirmed chain; no item/bag false-delivered; full/partial/failure recovery and claims ancestry | Boolean 'confirmed' or duplicate-ID count match |
| G5 Operator usable | Six browser workspaces traversable, representative E2E-001..012 executed and screenshots attached; offline courier replay proven | Backend-only endpoint or component screenshot with fake data |
| G6 Operational recoverable | Worker, queues, migrations from populated DB, backup/restore, secrets, incident/runbook, per-source OSS licenses | Dockerfile/README existence alone |
| G7 External launch legal | Executed written sign-off on Russian merchant/agent roles, consumer contract/receipt, 54-FZ/KKT/OFD, 152-FZ/localization/video, partner terms, real tariffs/routes and monitored pilot operations | Agent-created documents or fake fiscal state |

**Target for this wave:** G1–G6 internal/rehearsal readiness with demo providers; **G7 remains BLOCKED** until owner/legal/business approvals. No claim of production compliance or external pilot green.

## Mandatory files, provenance and result format on PR #3

- `docs/reports/PR3_WAVE_EXECUTION_REPORT.md` with status W0..W8 (`DONE/PARTIAL/BLOCKED/NOT_RUN`) and requirement/finding-by-finding closure.
- `docs/coverage/PR3_REQUIREMENT_TRACEABILITY.csv` and `docs/coverage/PR3_SCENARIO_EXECUTION.csv`: unique IDs, actor, implementation file, tests, SHA/CI/screenshot link and actual status.
- `docs/third_party/REUSE_DECISIONS.md`, `THIRD_PARTY_PROVENANCE.csv`, `LICENSE_NOTICES.md` (including exact pinned SHA).
- `docs/reports/PR3_INDEPENDENT_REVIEW.md` with severity, evidence and disposition.
- Reproducible local dev/DB/test instructions and mock-provider banner; SQL upgrade, backup/restore and operations logs without secrets.
- Final PR comment: exact baseline/final SHA, W0..W8 table, commits/CI, all 12 E2E receipts, meaningful S01..S16 counts, screenshots/traces, remaining blockers and unequivocal internal/production verdict.

## Escalation and anti-patterns

Stop only the **blocked destructive/external action**, not unrelated safe coding, when provider credentials, legal policy, production systems, source license or irreversible migration require approval. No new PR, rewrite from scratch, mass-closing Beads, fabricated assertions, invented partner or customer confirmation, money movement, manual 'green', production deployment, force push, external PII distribution or unreviewed OSS code imports. If another agent changed PR #3 HEAD, **fetch, diff and reconcile safely before pushing**; do not overwrite their commits.
