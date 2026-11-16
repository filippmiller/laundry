# PR #3 — test evidence, 2026-11-16

**Commit:** `0b7b4e81b4a49c0c12ea460538bd2d5e010d9579`
**Environment:** Windows 11, Node v24.19.0, npm 11.17.0, embedded PostgreSQL 18 (`test/global-setup.ts`), disposable database `laundry_test` on `127.0.0.1:55433`.

## Commands and exact results

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run lint` | PASS (eslint, 0 errors) |
| 2 | `npm run typecheck` | PASS (`tsc --noEmit` for API + web) |
| 3 | `npm test` | PASS — **8 files, 62 tests** |
| 4 | `npm run web:build` | PASS — 30 modules, 208.24 kB JS (65.32 kB gzip) |
| 5 | `npm run db:generate` then `git diff --exit-code -- drizzle` | PASS — "No schema changes, nothing to migrate" |
| 6 | `npx vitest run test/security-regressions.integration.test.ts` | PASS — 23 tests |
| 7 | `npm run smoke` | NOT_RUN (needs a separately started API; previously hosted run 43911616273 had 5 assertions) |
| 8 | `npm audit --omit=dev` | NOT_RUN this wave (no dependency changes; previous hosted run passed) |

## New regression file

`test/security-regressions.integration.test.ts` — 23 tests:

| Group | Tests | What must hold |
| --- | --- | --- |
| P0-01 | 3 | Same-tenant customer cannot read/list a foreign order; customer cannot call dispatch/finance reads (403); partner detail projection has no quote/address/terms hash |
| P0-02 | 3 | Unassigned partner cannot take custody; foreign partner cannot inspect/process; foreign partner finance cannot dispute |
| P0-03 | 3 | Cross-principal key replay rejected; schedule replay re-authorizes after reassignment; cross-customer claim replay rejected |
| P0-04 | 3 | Second capture rejected; concurrent captures yield one; concurrent full refunds yield one |
| P0-05 | 4 | Zero reservations rejected; foreign hold rejected; swapped kind rejected; expired hold rejected |
| P0-06 | 2 | Foreign garment rejected; foreign evidence rejected + own evidence accepted |
| P0-07 | 2 | Unsigned/forged webhook 401; signed event recorded once, duplicate detected, tenant mismatch 400, unsupported provider 503 |
| P1-01 | 3 | Duplicate ids rejected; incomplete set rejected and full set accepted; bag partial creates a recovery stop and the recovery stop completes |

## Mutation checks (non-vacuity)

The fixes were disabled one at a time and the relevant subset was re-run; each mutation produced a failing test, then the fix was restored.

| Mutation | Reverted guard | Observed |
| --- | --- | --- |
| M1 | `existing.actorId !== input.actorId` in `withIdempotency` | "rejects a key replayed by a different principal" FAILS (1 failed) |
| M2 | duplicate-id guard and exact-set guard in `recordDeliveryAttempt` | "duplicate garment ids" and "incomplete set" FAIL (2 failed) |
| M3 | `assertAssignedPartner` body in `src/services/partner.ts` | "unassigned partner cannot claim custody" FAILS (1 failed) |

After restoration: 23/23 green.

## Known test-harness limits

* Concurrency tests use two pool connections of one Node process with a barrier at the lock, not two machines. They exercise real PostgreSQL row locks, which is the property under test.
* The webhook secret is a test value injected via `process.env.PAYMENT_WEBHOOK_SECRET`; production configuration is not exercised.
* `npm run smoke` and hosted CI were not run against this commit in this session; the hosted job must be re-run at the final SHA before any status claim.
