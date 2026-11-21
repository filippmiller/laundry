# PR #3 — Adversarial audit gap report (working tree, 2026-11-18)

> **Updated after the 2026-11-18 remediation wave.** Findings 001, 002, 003, 004, 006 and 009 are
> now closed — see `docs/audits/PR3_REMEDIATION_EVIDENCE_2026-11-18.md` for the gate results and the
> per-finding evidence. The table below is the *state before* that wave and is kept as the baseline
> the wave was planned from. Finding 007 (auth), 008 (routing geography), 010 (outbox delivery),
> 011 (payment-inbox atomics), 012 (evidence upload/retention), 013 (scenario execution),
> 015 (backup ≠ DR) and 016 (doc drift) are **still open**.

Machine-generated status of audit findings **LAU-R2-001..016** against the current working tree
(`0d04914` + uncommitted remediation work), NOT against the audit's original snapshot `b4e240f`.

Source audit bundle: `docs/audits/PR3_audit/laundry_PR3_audit_2026-11-17/`
Scenario catalog: 217 unique scenarios / 36 cross-role journeys — **a test plan, not 217 passing tests.**

**Verdict at this HEAD: NO-GO.** Gate status per the master plan:
G0 FAIL (ignore rule inert) · G1 FAIL (lint + typecheck red → CI red → smoke SKIPPED) ·
G2 FAIL (evidence object scope) · G3 PARTIAL · G4 PARTIAL · G5 FAIL · G6 FAIL · G7 BLOCKED (legal — cannot be signed by a coding agent).

## Finding status

| Finding | Sev | Status | Evidence | Remaining work |
|---|---|---|---|---|
| 001 CI red / smoke skipped | P0 | PARTIAL | `apps/web/src/App.tsx:2`, `components/Router.tsx:28`, `App.tsx:61`; `.github/workflows/ci.yml:23-26,68-69` | 20 lint errors → 1 lint + 2 typecheck errors. Fix 3 errors, re-run gates. |
| 002 Raw PG files tracked | P0 | PARTIAL | `git ls-files .pgdata-drill` = 0; `git log --all -- .pgdata-drill` = empty; `.gitignore` last rule is UTF-16LE → `git check-ignore` exit 1 | Ignore rule inert → 2 400+ PG files still re-addable by `git add -A`. History/public exposure needs owner decision. |
| 003 Role UI not mounted / fake customer portal | P0 | PARTIAL | Mounted now (`App.tsx:61` → `Router.tsx:23-29`); still fake: `CustomerWorkspace.tsx:52` (fake toast), `:57` (`0 ₽`), `:58-60` (dead buttons), `:65-74` (empty tabs); `AuthLanding.tsx` never imported | Real customer journey; mount decision for AuthLanding. |
| 004 Frontend calls 404 endpoints | P0 | PARTIAL | Present: `server.ts:902,907,924,880,966`. Missing: `/finance/overview` (`FinanceWorkspace.tsx:156`), `/documents/:kind/:id` (`DocumentPrintModal.tsx:37`), `/auth/otp/*` (`AuthLanding.tsx:231`), `returnUnprocessedOrder` (`src/services/partner.ts:400`) | Register the 7 missing endpoints with auth + DTO + tests; add OpenAPI↔frontend contract gate. |
| 005 Compose cannot become healthy | P0 | REMEDIATED | `server.ts:256-266` `/health/ready` with `SELECT 1`; `infra/docker-compose.yml:55` | No disposable Compose boot proof (API + worker + Caddy healthy). |
| 006 Evidence authorization incomplete | P0 | PARTIAL | `workspace.ts:95-115` helper exists, order-only at `:106`; `registerEvidence` `:137-144`; `listEvidence` `:161-170` returns `objectKey` at `:173`; served raw `server.ts:770-773` | Extend to claim + custody_event; strip objectKey; A/B negative tests. |
| 007 Production auth not integrated | P0 | NOT_FIXED | `src/services/auth.ts:99-133`; OTP code only `console.info`d `:118-127`; no `/auth/otp/*` route; `AuthLanding` unmounted; `App.tsx:17,30` uses `/dev/seed` + `/auth/demo-login` | Provider adapter, routes, mounted UI, no demo role self-selection in prod. |
| 008 Fabricated geography | P1 | NOT_FIXED | `src/services/routing.ts:59-69` SHA-256→Moscow coords, used `:119,206,271,294`; `SIMULATION_ONLY` appears nowhere in `src/`; `optimizeShiftRoutes` `:358` unreachable | Gate as simulation; real geocoding/matrix; drop `savedMeters` claims; benchmarks. |
| 009 CSRF/Origin only on POST | P1 | NOT_FIXED | `server.ts:124-125` `if (request.method !== "POST") return;`; cookie-authenticated DELETEs at `:362`, `:548`, `:728`; `RouteDef.method` union GET/POST/DELETE `:86` | Protect DELETE; add PATCH/PUT support; extend origin tests. |
| 010 Notification "delivery" | P1 | NOT_FIXED | `src/services/outbox.ts:75-83` inserts DB rows `channel:"push"`; selection ignores `available_at <= now` `:47`; immediate requeue `:101-113`; no backoff/DLQ/provider receipt | Separate enqueue from delivery; retry/backoff/DLQ; fault-injection tests. |
| 011 Payment inbox atomics | P1 | NOT_FIXED | `src/services/payment-inbox.ts:27` one transaction for all events; per-row catch `:44-62`; `applyEvent` mutates intent then posts journal `:74-80` | Per-event transaction/savepoint; idempotent postings; partial-failure fixture. |
| 012 Evidence upload pipeline & retention | P1 | NOT_FIXED | `workspace.ts:117-157` accepts caller-supplied `objectKey`/`sha256`, status `pending_upload`; `retentionUntil` (`src/db/schema/07-evidence.ts:63`) never read; `deleteEvidence` deletes access events + holds `:227-231` | Upload verification, MIME/size checks, audit-preserving tombstones, retention job. |
| 013 Role scenarios untested | P1 | NOT_FIXED | `docs/coverage/PR3_SCENARIO_EXECUTION.csv:2-6` still PARTIAL/NOT_RUN, `browser_evidence=None`; `test/scenarios/p0.integration.test.ts:78-94` asserts on local literals; `test/generated-scenarios.test.ts:6-10` only parses catalog JSON | Adopt graded statuses; real multi-role/browser journeys. |
| 014 Commercial/legal flows incomplete | P1 | PARTIAL | Fiscal route `server.ts:966`; renderer `src/services/finance.ts:700`; compensation approval explicitly non-money `workspace.ts:248-251`. Missing: `partnerPayouts` (`src/db/schema/11-partner-finance.ts:48`) has no writer; no KKT/OFD adapter; `/documents/*` not exposed | Payout service, fiscalization adapter, customer-accessible document route, legal decision register. |
| 015 Backup ≠ DR | P1 | NOT_FIXED | `scripts/upgrade-restore-drill.ts:106` `CREATE DATABASE ... TEMPLATE` on the same cluster; no `pg_dump`/`pg_restore`; CI never runs `db:drill` | Isolated backup→delete→restore on clean PG16; checksums; add to CI. |
| 016 Documentation / handoff drift | P2 | NOT_FIXED | `README.md:19` claims 92 tests (actual 239); `docs/coverage/PR3_SCENARIO_EXECUTION.csv:2` cites `0b7b4e8`; no `SESSION_HANDOFF.md`; `REMEDIATION_PROGRESS.md` claims a `listEvidence` refactor that is not in the code | Machine-generated status dashboard, AS-OF labels, honest handoff, remove false checkmarks. |

**Counts: REMEDIATED 1 · PARTIAL 6 · NOT_FIXED 9 · UNVERIFIABLE 0**

## Blocking gaps at this HEAD

1. Evidence IDOR — `workspace.ts:137-144`, `:161-173` + `server.ts:770-773`
2. Fake customer portal mounted — `CustomerWorkspace.tsx:52,57-60`
3. Origin check POST-only — `server.ts:124-125` vs DELETE at `:362,548,728`
4. CI red → smoke skipped — `App.tsx:2`, `Router.tsx:28`, `App.tsx:61`
5. `.pgdata-drill` ignore rule written as UTF-16 → `git check-ignore` exit 1
6. Mounted workspaces call unregistered endpoints — `FinanceWorkspace.tsx:156`, `DocumentPrintModal.tsx:37`, `AuthLanding.tsx:231`
7. No real auth path — `auth.ts:118-127`, no OTP routes, `AuthLanding` unmounted
8. Payment inbox not per-event isolated — `payment-inbox.ts:27,44-62`
9. Audit-row destruction on evidence delete — `workspace.ts:227-231`
10. "push" notifications are DB rows, not delivery — `outbox.ts:75-83`

## Leftover scaffolding

- `apps/web/src/App.tsx.bak` — legacy App backup, unimported → remove
- Untracked but load-bearing: `components/Router.tsx`, `components/Shell.tsx`, `types.ts`
- Untracked tests with tautological assertions: `test/generated-scenarios.test.ts`, `test/scenarios/p0.integration.test.ts`, `test/scenarios/critical.integration.test.ts`
- Untracked: `REMEDIATION_PROGRESS.md` (contains a false checkmark), `scripts/browser-role-smoke.cjs`
- **Four duplicate copies of the audit bundle**, all untracked → keep exactly one
- `.pgdata-drill/` untracked but unignored
- Untracked agent config: `.agents/hooks.json`, `.agents/laundry-idle-continuation.cjs`, `.agents/rules/laundry-verdict.md`
- `AuthLanding.tsx` defined but never imported
- Lint weakened globally: `eslint.config.mjs:12` `varsIgnorePattern: "^_"` — this is what enabled the underscore-rename suppression
- Two competing `DemoConfig` types: `apps/web/src/types.ts:3-12` vs `CustomerWorkspace.tsx:8-21`
- `SupportClaimsWorkspace` missing the `demo` prop — `Router.tsx:28`

## Existing test files covering each finding

- 006: `test/use-cases.integration.test.ts:142-166` (order-scoped only), `test/security-regressions.integration.test.ts:391-420`, `test/finance-reads.integration.test.ts:89-106`
- 009: `test/security-regressions.integration.test.ts:591-655` (POST only)
- 011: `test/payment-inbox.integration.test.ts` (duplicate webhook, drift — no atomicity case)
- 010: `test/outbox.integration.test.ts`
- 007: `test/scenarios/p0.integration.test.ts:55-94` (asserts literals, not the service)
- 013: `test/scenarios/p0.integration.test.ts`, `test/scenarios/critical.integration.test.ts`, `test/generated-scenarios.test.ts`
- 002, 005, 015, 016: no test coverage
