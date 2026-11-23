# Remediation progress — PR #3 audit & remediation (2026-11-19)

**AS-OF 2026-11-19, commit `b6ae600` on branch `docs/pr2-independent-audit-autonomous-wave`.**  
Canonical task tracker: Beads (`bd list --status=open`, `bd show <id>`).  
Independent dual audit record: [`docs/reports/PR3_INDEPENDENT_REVIEW.md`](docs/reports/PR3_INDEPENDENT_REVIEW.md).  
Scenario status register: [`docs/coverage/PR3_SCENARIO_STATUS.json`](docs/coverage/PR3_SCENARIO_STATUS.json) and [`docs/coverage/PR3_SCENARIO_EXECUTION.csv`](docs/coverage/PR3_SCENARIO_EXECUTION.csv).

## Current verified baseline

| Dimension | Verified State | Evidence |
| --- | --- | --- |
| Schema & migrations | **83 tables**, **25 migrations (`0000`–`0024`)**, **zero schema drift** | `drizzle/meta/0024_snapshot.json`, `drizzle/0024_backfill_legal_holds_and_paid_invoices.sql` |
| Remediation Beads | **25 / 25 code-closable Beads closed** (`88` closed total; `bd list --status=open` shows **3** owner-only decisions) | `.beads/issues.jsonl` (`lnd-9l7`, `lnd-5me`, `lnd-8ev` open) |
| Dual independent red-team audit | **20 / 20 P0/P1 findings closed** (Cold Red-Team Reviewer `pro` + OpenAI Codex `gpt-6.2-sol` over `bd48e57..388ddee`, fixed in `b6ae600`) | [`docs/reports/PR3_INDEPENDENT_REVIEW.md`](docs/reports/PR3_INDEPENDENT_REVIEW.md), `test/wave4b-remediation.integration.test.ts` |
| Cross-role flows (`F01..F36`) | **30 / 36 `CROSS_ROLE_PASS`** (`2 BLOCKED` external routing/DR, `4 SPEC`) | `test/scenarios/cross-role-flows.integration.test.ts`, `test/scenarios/adversarial-business-edge-cases.integration.test.ts` |
| Catalog scenarios (217 total) | **137 / 217 verified** (`82 CROSS_ROLE_PASS`, `50 API_PASS`, `4 BROWSER_PASS`, `1 UNIT_PASS`); `10 BLOCKED` on external hardware/providers; `70 SPEC` | `docs/coverage/PR3_SCENARIO_STATUS.json` |
| Web UI & accessibility | UI primitive system (`apps/web/src/components/ui/`), WCAG 2.2 AA, lazy workspace code-splitting (`index.js` **385 kB**) | `docs/UI_SYSTEM.md`, `apps/web/src/workspaces/registry.ts`, `dist/web/assets/` |
| Browser & viewport gates | **25 / 25 mobile/tablet/print views** verified; **11 / 11 browser smoke checks (`SMOKE_OK`)** | `scripts/verify-mobile-ui.mjs`, `scripts/smoke-e2e.mjs` |

## Remediation waves completed

1. **Initial Wave (2026-11-18):** `.gitignore` UTF-16 repair + `scripts/guard-repo-hygiene.mjs`, evidence ABAC (`order`/`claim`/`custody_event`) & `objectKey` removal, 7 missing HTTP contracts, real `CustomerWorkspace`, route rate limits in `app.after`, CSRF on `POST/PUT/PATCH/DELETE`, voided-invoice capture block, `eslint` loophole closure, per-run DB reset, CI PostgreSQL 16 job.
2. **UI System & Dispatcher Wave (`bd48e57`, `5319e78`):** Complete `apps/web/src/components/ui/` primitive system, `apps/web/src/labels.ts` Russian state/event mapping, WCAG 2.2 AA focus/keyboard/motion hardening, lazy workspace code-splitting, wired `DispatcherWorkspace` (`lnd-50x`), and 25/25 mobile/tablet/print verification (`scripts/verify-mobile-ui.mjs`).
3. **Group A — Finance & Partner (`3d8353b`):** Exact gram-per-kg rounding, partner wholesale contract selection, receipt actual-vs-expected weight variance, broken-seal discrepancy opening, accrual correction & unprocessed-return voiding, supplemental invoice on paid orders (`lnd-irv`, `lnd-5or`, `lnd-nuq`, `lnd-5zs`, `lnd-epd`, `lnd-apw`, `lnd-pny`).
4. **Group B — Orders, Capacity & Security (`e5488f8`):** Tenant-scoped container uniqueness, intake mode bound to tariff tier, optimistic lock checks on schedule/cancel/reschedule, versioned terms acceptance, role-projected order view, garment evidence linkage, `releaseSlot` reuse, mandatory principal in `nextState`, `safety_buffer_orders` arithmetic (`lnd-8vs`, `lnd-6tf`, `lnd-mw8`, `lnd-7c3`, `lnd-7l3`, `lnd-kdc`, `lnd-kje`, `lnd-5nx`, `lnd-qfy`, `lnd-7vq`).
5. **Group C — Reliability & Infra (`8ceb503`):** Legal hold release trigger repair (`0023`), evidence upload/tombstone/retention pipeline, per-event transactional payment inbox, outbox backoff/DLQ, `SIMULATION_ONLY` routing gate, PG16 restore drill in CI (`lnd-ek8`, `lnd-ikt`, `lnd-pfj`, `lnd-0g5`, `lnd-wzt`, `lnd-23v`).
6. **Scenario Execution Wave (`388ddee`):** Executed 30/36 cross-role journeys + adversarial business edge cases + API/OpenAPI contract sync, updating `PR3_SCENARIO_STATUS.json` (`lnd-2c0`).
7. **Wave 4B Dual Red-Team Remediation (`b6ae600`):** Closed all 20 P0/P1 findings from independent `pro` + OpenAI Codex `gpt-6.2-sol` review (concurrency locks, partial delivery recovery, pickup stop completion on handoff, evidence ownership/order-scope/tombstones, backfill `0024`, inbox/outbox stale-processing lease reclaim, `GET /orders` ordering, `Router` `demo === null`, supplemental invoice payment, `smoke-e2e.mjs` toast selectors).

## Remaining open gates (external / owner-only)

- **`lnd-9l7` (Owner decision):** GitHub unreachable-object purge / credential rotation decision for prior `.pgdata-drill` exposure (classified `TEST_ONLY`, branch history already clean), manual deletion of local `%LOCALAPPDATA%/Temp/pgdrill`, and real SMS provider authorization.
- **`lnd-5me` (Owner decision):** Lifecycle of the public preview instance (`https://laundry.filippmiller.com`) and sign-off on real pilot prerequisites (real auth/SMS, live acquiring, 54-FZ KKT/OFD, real geocoding/routing, off-host PITR/DR).
- **`lnd-8ev` (Owner/Legal decision):** Russian legal/compliance gates (consumer law, principal/agent role, 54-FZ/OFD, 152-FZ & video retention, partner terms, refund policy, unit economics).
- **10 `BLOCKED` external-dependency scenarios:** Real SMS carrier (`AU-014`), road-network routing/geocoding (`F31`, `CO-004`, `DI-008`, `DI-010`), camera hardware (`CO-015`), live 54-FZ KKT/OFD (`FI-016`, `FI-017`, `AD-015`), and off-host PG16 PITR/DR (`F33`, `AD-019`, `OP-004`).
