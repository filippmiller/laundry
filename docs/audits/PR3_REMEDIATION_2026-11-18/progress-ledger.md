# SDD ledger — plan: docs/audits/PR3_audit/laundry_PR3_audit_2026-11-17/03_IMPLEMENTATION_MASTER_PLAN.md

Session: 2026-11-18, controller = mavis root session.
Repo has NO git remote configured (push to PR #3 not possible locally — flagged to owner).
Nothing was committed, staged, pushed, force-pushed or merged.

## Baseline measured at session start (working tree, not the audit's stale SHA)
- npm test: 239 tests / 19 files PASS (but with no database, so the integration suites were SKIPPED)
- npm run web:build: PASS
- npm run lint: FAIL (1 error — unused `newKey` import in apps/web/src/App.tsx)
- npm run typecheck: FAIL (2 errors — App.tsx:61 DemoConfig mismatch, Router.tsx:28 SupportClaimsWorkspace missing `demo`)
- .pgdata-drill/ NOT tracked, NOT in git history — BUT .gitignore rule for it is UTF-16 corrupted and therefore inert

## Verified findings (controller-verified, with file:line)
- apps/web/src/main.tsx mounts ./App -> ./components/Shell + ./components/Router. 7 of 8 workspaces are real
  (Admin 782, AuthLanding 705, Courier 1725, Finance 803, Partner 1552, SupportClaims 1404 lines).
- apps/web/src/workspaces/CustomerWorkspace.tsx was a 76-line STUB: hardcoded "0 ₽", fake success toast,
  empty MyOrders/Addresses/Support tabs, lint suppressed via underscore-renamed imports. THE product lie.
- src/api/server.ts uses a declarative `add({method, path, ...})` registry (NOT app.get()).
- Backend MISSING routes the frontend calls: GET /finance/overview, GET /documents/:kind/:id,
  POST /partner/orders/:id/return-unprocessed, POST /admin/members/:id/state,
  POST /auth/otp/request, POST /auth/otp/verify, POST /auth/preview-unlock.
- GET /health/ready, GET /dispatch/overview, GET /partner/workspace DO exist (audit stale on these).
- Router.tsx does NOT mount AuthLanding (consistent with plan: keep unmounted until OTP provider approved).

## Lanes (all four delivered; lane reports in this directory)
- Lane A (backend API completeness) — src/api/**, src/services/{api-overview,documents,otp}.ts, test/api/**
  -> 7 endpoints, 49 tests. Also fixed: route rate limits were never enforced; malformed body gave 500.
- Lane B (frontend customer flow + build green) — apps/web/**
  -> CustomerWorkspace 76 -> ~2000 lines, real journey, 27/27 API + 11/11 Playwright checks.
- Lane C (ops G0 + CI hygiene guard) — .gitignore, .github/**, scripts/guard-repo-hygiene.mjs, test/ops/**
  -> UTF-16 ignore rule repaired, guard script + 7 tests, wired into CI.
- Lane D (security evidence ABAC) — src/services/workspace.ts, test/security/**
  -> deny-by-default ownership for order/claim/custody_event, objectKey removed, tombstone instead of
     destructive delete, 13 tests.

## Controller-owned integration work (done here, not delegated)
1. CSRF/Origin on every unsafe method — src/api/server.ts:127-134 (was POST-only) +
   test/security/csrf-unsafe-methods.integration.test.ts (6 tests).
2. Money: a voided invoice could still be captured — src/services/finance.ts:257-262 +
   test/api/finance-capture-invoice-state.test.ts (4 tests). Reported by Lane A, fixed here.
3. eslint.config.mjs — removed `varsIgnorePattern: "^_"` (the loophole that hid the stub).
4. test/global-setup.ts — truncate the public schema per run; the suite used to depend on how many
   times it had been run (outbox backlog starved the newest events).
5. test/use-cases.integration.test.ts — drain the outbox until this order's events land.
6. .github/workflows/ci.yml — the quality job had NO database, so every integration test was silently
   SKIPPED and CI was green while proving nothing. It now provisions PostgreSQL 16.
7. scripts/smoke-e2e.mjs — rewritten for the new UI; asserts no "0 ₽" placeholder and a non-zero
   server price.
8. Removed the fake coverage: test/scenarios/p0.integration.test.ts (130 it(), 113 tautologies) and
   test/generated-scenarios.test.ts (parsed a JSON file). Replaced by
   scripts/generate-scenario-status.mjs -> docs/coverage/PR3_SCENARIO_STATUS.json (217 scenarios, all
   honestly SPEC) + test/scenarios/scenario-status.test.ts (5 tests).
9. test/scenarios/critical.integration.test.ts — rewritten; it claimed to verify AU-001 while only
   asserting that an array is an array.
10. REMEDIATION_PROGRESS.md — rewritten; it contained a false checkmark for LAU-R2-006.
11. Deduped the audit bundle (4 copies -> 1) and removed apps/web/src/App.tsx.bak.

## Final gate results (this exact working tree)
lint PASS (0 errors) | typecheck PASS | test PASS 188/188 in 29 files, 0 skipped, twice in a row |
web:build PASS | guard:hygiene PASS (205 tracked files, 0 violations) | npm audit --omit=dev PASS
(0 vulnerabilities) | migration drift PASS | smoke PASS 11/11 against a fresh disposable PostgreSQL 16.

Test count fell 314 -> 188 because 131 fake tests were deleted and 6 real ones added.

## Post-review fixes (after the first review pass)
- `eslint.config.mjs` — added `setTimeout`/`clearTimeout`/`fetch` to the allowed globals; the
  repository's own `.mjs` scripts (which ESLint checks with `no-undef`, unlike the TypeScript
  files) could not use them.
- `scripts/smoke-local.mjs` — the local replica of the CI smoke job was promoted out of the scratch
  workspace into `scripts/` so it is a permanent, runnable tool
  (`node scripts/smoke-local.mjs`: fresh PostgreSQL -> migrate -> build -> API -> `npm run smoke`).
- `test/scenarios/scenario-status.test.ts` — typed the parsed catalog/register explicitly; TypeScript
  could not resolve the `.mjs` generator module, so the agreed status vocabulary is now declared on
  both sides and the generator's `--check` enforces the same rules.
- The scratch workspace `.superpowers/` was removed; the lane reports and this ledger were preserved
  under `docs/audits/PR3_REMEDIATION_2026-11-18/`.

## Still open (see docs/audits/PR3_REMEDIATION_EVIDENCE_2026-11-18.md §4)
007 auth (fake OTP provider) | 008 fabricated routing geography | 009 no CSRF token (Origin only) |
010 outbox delivery is a fiction | 011 payment inbox not per-event atomic | 012 evidence upload/retention |
013 217 scenarios still SPEC | 015 backup != DR, db:drill not in CI | 016 README still claims 92 tests |
G7 legal sign-off (cannot be signed by a coding agent).
