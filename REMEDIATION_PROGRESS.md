# Remediation progress — PR #3 remediation wave (2026-11-18)

**AS-OF 2026-11-18, working tree of branch `docs/pr2-independent-audit-autonomous-wave`.**
Canonical task tracker: Beads (`bd ready`, `bd show <id>`). Status dashboard: `docs/audits/PR3_GAP_REPORT_2026-11-18.md`.
Audit source: `docs/audits/PR3_audit/laundry_PR3_audit_2026-11-17/` (findings LAU-R2-001..016).

> This file previously carried `[x]` checkmarks that the code did not support — most notably a
> claim that `listEvidence` had been refactored to use `authorizeEvidenceOwner` when it had not
> (it re-implemented an order-only check inline and returned `objectKey` to the API). Every entry
> below is now backed by a file:line or a test that actually runs.

## Verified fixed in this wave

| Item | Evidence | Verified by |
|---|---|---|
| `.pgdata-drill/` ignore rule repaired (the old rule was UTF-16 and inert) | `.gitignore:17`; `git check-ignore -v .pgdata-drill` → exit 0 | controller, directly |
| Repo hygiene guard added to CI | `scripts/guard-repo-hygiene.mjs`, `.github/workflows/ci.yml` | `test/ops/guard-repo-hygiene.test.ts` (7 tests, both pass and fail cases) |
| Evidence object scope for `claim` / `custody_event` (was order-only) | `src/services/workspace.ts:135-189` | `test/security/evidence-abac.integration.test.ts` (13 tests) |
| `objectKey` no longer returned by evidence listing / reading | `src/services/workspace.ts:230-258` | same, asserted on the serialised response body |
| Evidence delete no longer destroys audit history (tombstone instead) | `src/services/workspace.ts:299-351` | same, test 12 |
| Missing HTTP contracts implemented (7) | `src/api/server.ts` | `test/api/**` (49 tests) |
| Fake customer portal replaced by a real journey | `apps/web/src/workspaces/CustomerWorkspace.tsx` (~2000 lines) | Playwright 11/11 + API 27/27 (Lane B report) |
| `DemoConfig` consolidated into one definition | `apps/web/src/types.ts` | `npm run typecheck` |
| Route limits now actually enforced (they never were) | `src/api/server.ts` | `test/api/otp-rate-limit.test.ts` |
| Malformed body now answers 400 instead of 500 | `src/api/server.ts` error handler | `test/api/**` |
| Voided invoice can no longer be captured | `src/services/finance.ts` | `test/api/finance-capture-invoice-state.test.ts` |
| Lint loophole closed (`varsIgnorePattern: "^_"`) | `eslint.config.mjs:12` | `npm run lint` → 0 errors |
| Test database reset per run (removed run-count dependence) | `test/global-setup.ts` | `npm test` |
| CI runs the integration suite against a real PostgreSQL | `.github/workflows/ci.yml` | — |

## Open / not done

- **Auth is not production-ready.** The OTP surface is a `fake` provider that returns `404` in
  production; `AuthLanding` stays unmounted on purpose. A real SMS provider is required.
- **Routing still fabricates geography** (`src/services/routing.ts:59-69` hashes a building id into
  fictitious Moscow coordinates and is not gated as `SIMULATION_ONLY`).
- **The outbox is a delivery fiction** (`src/services/outbox.ts`): a DB row marked `push` is not a
  delivered notification; there is no backoff, dead-letter or provider receipt.
- **The payment inbox is not per-event atomic** (`src/services/payment-inbox.ts:27`).
- **Backup is not disaster recovery** (`scripts/upgrade-restore-drill.ts` clones a template on the
  same cluster; CI never runs `npm run db:drill`).
- **Evidence has no upload pipeline and no retention job**; `retention_until` is written but never
  read. There is no tombstone column, so `expired` is overloaded as the tombstone marker.
- **217 scenarios / 36 cross-role journeys are still a test plan, not executed coverage.**
- **No git remote is configured in this working tree**, so nothing could be pushed to PR #3.
- **G7 (legal/54-FZ/KKT/OFD/152-FZ) cannot be signed by a coding agent.**
