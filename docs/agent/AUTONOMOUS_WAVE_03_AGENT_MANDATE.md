# AUTONOMOUS_WAVE_03_AGENT_MANDATE.md
**Mandatory work order for the local coding agent.** This branch is stacked on PR #2; PR #2 itself remains unchanged. Read `PR2_INDEPENDENT_REUSE_AND_GAP_AUDIT.md` first, then `FOUNDATION.md`, `SCENARIO_MATRIX_800.md`, `ACCEPTANCE_E2E_V2.md`, `LOCAL_BUILD_AGENT_SPEC.md`, `AGENTS.md` and current source. Use Beads (`bd prime`, `bd ready`) for durable task tracking. Owner has authorized a large autonomous implementation wave and requires a **Draft PR containing code, tests, screenshots, provenance and a completed report**.

## Mission
Deliver a substantially more usable Russian Laundry MVP, with real multi-role browser journeys, open-source reuse where it saves effort, route optimization, scanner/offline intake, and financial/claims/partner workflows. Work autonomously to the best verifiable state; do not invent integration successes. No production deployment or live money movement without separate explicit approval. Preserve PR #2 architecture and data, avoid speculative rewrites.

## Required execution order — ten work packages

### W0 Baseline, triage, task ledger
Clone, checkout PR #2 head, run npm ci, lint, typecheck, tests, web build, smoke, migration drift, npm audit; save exact logs and commit SHA. Inspect API routes, schema, UI, test suites, Beads. Generate `docs/coverage/FEATURE_API_UI_TEST_MATRIX.csv` with every 16 slice and major role mapped to service, endpoint, UI, test, status and gap. Create Beads tasks for every uncovered critical journey. Distinguish existing passing tests from newly written tests.

### W1 Reuse-first engineering inventory
For each candidate (Refine, Ownfleet, VROOM, OSRM, zxing-js/browser or html5-qrcode, shadcn/ui, Chatwoot, Novu, ERPNext), inspect upstream LICENSE, latest release, commits in last 90 days, open issue trends, advisory data, runtime footprint, packages and API. Score saved engineering time, maintenance, license, TS fit, Russian-market fit and operational risk. Save `docs/third_party/REUSE_DECISIONS.md`, `THIRD_PARTY_PROVENANCE.csv` and `LICENSE_NOTICES.md`. Every imported/copied file must include upstream URL, pinned commit, original path, license, changes and tests. Mark **dependency reuse**, **source port**, **separate service integration**, or **reference only**. No claiming code ported without proof. If project is unsuitable, choose another OSS alternative and explain why. Do not copy AGPL/ELv2/copyleft code into proprietary core without approval.

### W2 Production-shaped authentication and authorization
Replace unsafe demo assumptions in real flows; choose mature permissive OSS auth library/provider only after review. Demo routes unavailable in production and protected from external exposure. Session security, CSRF, secure cookies, OTP adapter with fake local provider, invite/role provisioning, partner scoping, customer ownership. Tests for every endpoint: unauthenticated, wrong tenant, wrong partner, wrong role, wrong customer, expired session, CSRF. Include malicious actor attempting partner first-receipt of an unassigned order; require explicit assignment or documented dispatch policy.

### W3 Customer application
Refactor 418-line App.tsx into maintainable route/pages/components; reuse audited OSS UI components. Customer: address and building discovery, service catalog, economy/protected/mixed orders, item declarations, quote breakdown, shared vs paid windows, change/cancel/reschedule, payments simulated but clearly labeled, order history/timeline, notifications, claims, repeat order. Responsive mobile/desktop. Russian copy, RUB, timezone, keyboard accessibility, loading/empty/error states.

### W4 Courier/driver PWA and real intake
Evaluate Ownfleet and scanner libs, reuse audited parts if appropriate. Implement camera QR/barcode scanning with manual fallback; durable IndexedDB queue with per-device IDs, retry/backoff, conflict reconciliation and visible 'not synced' state. Stops grouped by building, arrival, bag/seal/weight, protected per-item manifest and condition photo/video metadata, handoff dual confirmation, failed pickup, recipient delivery proof, failed delivery/reschedule. No sensitive data encoded in QR. Browser offline tests and reconnect replay tests required.

### W5 Dispatcher and optimized routes
Deploy VROOM in isolated Docker Compose service (or document failed feasibility and select best maintained alternative). Use OSRM/legally sourced travel-time matrix where feasible; deterministic fixture matrix for CI. Route groups by building, windows, courier capacity, pickup and delivery, paid off-schedule tasks, vehicle constraints, manual overrides, exception/reassignment and route audit. Compare optimized vs naive routes on at least 3 deterministic datasets; report distance/time/stop count without fabricated real-world metrics. Dashboard map optional only with lawful tile source.

### W6 Partner laundry portal
Real partner-specific portal (prefer audited Refine package), receiving/scan and seal/weight discrepancies, garment inspection, price adjustment consent, processing batches, QC, rewash, rejection, ready-for-return, transfer evidence, SLA, invoice line reconciliation. Test wrong partner, broken seal, missing item, partial batch, price decline, QC failure, duplicate receipt. No automatic custody transfer without authorized handoff.

### W7 Finance, support and Russian documents
Real role-specific finance dashboard: payment states, receivables, captured/refunded, ledger balances, partner accruals, reconciliation, margin by building/route/order, claims reserves and exports. Customer invoice/partner act/UPD template adapters in Russian, clearly non-fiscal until KKT provider integrated. Define payment/KKT/OFD adapter contract and local fake provider; no real charge or claim of 54-FZ compliance. Support/claims case dashboard with timeline, evidence access reason, escalation, decision and appeal; evaluate Chatwoot API adapter rather than clone its Rails app. Do not import AGPL/ELv2 code. Test duplicate webhook, partial refund, chargeback race, fiscal pending and partner disputes.

### W8 Notifications, media, ops
Transactional outbox + retry/dedup, notification templates and preferences, local fake SMS/email, private media upload with hash, access audit, legal hold, configurable retention, security review. Health/metrics/logs, DB backups and tested restore in disposable environment, migrations from PR #1 populated DB. No production secrets in repo.

### W9 Scenario execution, independent audit and delivery
Turn highest-risk matrix cases into fixture-driven executable tests across all 16 slices; prioritize 12 E2E seed journeys and 30 cross-slice journeys, then at least **5 concrete new assertions per slice** (80+) without meaningless generated clones. Cover failure/timeout/race/authorization and cross-role transitions. Browser tests must include actual courier, partner, finance and claims workflows, not merely customer happy path. Run complete CI locally and hosted; independent reviewer pass with severity-ranked findings and remediation. If a check fails, document it honestly and keep PR Draft.

## Required outputs in SAME Draft PR
1. Code, migrations, dependency lockfile, Docker dev profile, screenshots (or Playwright trace links), API schema, fixtures and reproducible commands.
2. `docs/reports/WAVE_03_EXECUTION_REPORT.md` with per-package: DONE/PARTIAL/BLOCKED, files, functionality, source-port provenance, test names, exact command result, limitations.
3. `docs/coverage/FEATURE_API_UI_TEST_MATRIX.csv` and `docs/coverage/SCENARIO_EXECUTION_MATRIX.csv` (scenario ID, role, API, UI, test path, pass/fail/not-run, evidence link).
4. `docs/third_party/THIRD_PARTY_PROVENANCE.csv` (upstream repo, SHA/tag, license, imported file/package, local destination, modification, test, rationale); separate dependency installs from actual code ports.
5. `docs/reports/INDEPENDENT_REVIEW.md` including security, multi-tenant, finance, custody, legal, licenses, performance and UX; issue references and fixed/unfixed status.
6. Updated README and PR description: summary, screenshots, new integrations, tests, CI URLs, all remaining blockers, exact steps to run demo, and links to report documents.
7. Agent **must respond to every requirement W0-W9 explicitly** in the PR description and report; do not silently skip any. Include a `Requirement → implementation → test → evidence → remaining gap` table. Agent posts a final PR comment containing concise handoff and links to evidence.
8. Beads issues must reflect remaining work; no blanket closure of broad epics for backend-only implementations.

## Acceptance gates and autonomy
- All previously passing tests continue passing; migration and data compatibility checked.
- No exposed demo role escalation or tenant leakage; no custody transfer to wrong partner; no double charging.
- Working browser flows for customer, courier, laundry partner, dispatcher, support, finance; honest unavailable states for unimplemented integrations.
- At least one **genuine** permissively licensed OSS component or separately deployed engine integrated and demonstrated end-to-end, with provenance; aim for several high-value reuses (Refine + scanner + VROOM) if practical. Never optimize for raw lines copied.
- Russian legal model, consumer rights, 54-FZ, 152-FZ, data localization, video consent and partner contract require sign-off before public production. No deployment, payment capture or external customer data without permission.
- Keep a Draft PR even if incomplete; do not merge. User will inspect summary and request another audit.

## PR workflow
Use branch from PR #2 head, base PR #2's actual head branch (discover branch name via git/GitHub; do not assume). Create a **new Draft implementation PR** stacked on PR #2. Keep this audit PR separate; reference both. For cross-machine Beads use established Dolt workflow and avoid destructive sync. You have explicit authorization to commit/push code and open Draft PR for this wave, but not merge or deploy. Stop only for real external credentials, legal decisions, or destructive actions; continue other work in parallel.

## Required final handoff format (fill with actual evidence)
- Baseline SHA / final SHA / PR URL / CI run URLs
- W0..W9 status and linked commits
- Exact OSS code ports vs dependencies vs services, with pinned upstream SHAs
- Implemented role journeys and test IDs
- SQL migration status and rollback/upgrade validation
- Test count, pass/fail/skipped, browser screenshots/traces, security findings
- Remaining P0/P1/P2 blockers and Beads IDs
- Local demo run instructions and what is mocked
- Independent reviewer verdict and next wave recommendation

**Do not call this wave complete if tests are unrun or if only documentation was added.**
