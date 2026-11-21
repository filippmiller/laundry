# PR #2 independent implementation and reuse audit
Date: 2026-11-16. Source: GitHub PR #2 branch contents and compare against `docs/foundation-v1`. This is a **source inspection**, not an independently executed local test or full security review.

## Executive finding
PR #2 is a substantial, mostly **custom-written** TypeScript demonstration, **not** the agreed reuse-first assembly of permissively licensed open-source modules. There is **no evidence of source porting** from Refine, Ownfleet, VROOM, Chatwoot, Medusa, ERPNext, or other shortlisted products in the changed-file list, root package.json, app imports or architecture description. Standard OSS dependencies **are** used (Fastify, React, Drizzle, Zod, Vite, Playwright etc.); this is dependency reuse, not module porting. Do not imply the agent imported code merely because those packages are open source. Agent must produce a provenance inventory to verify every copied/adapted source file, including possible code not recognizable from names.

## Evidence inspected
- PR #2: https://github.com/filippmiller/laundry/pull/2 (stacked on PR #1; PR #2 changes 118 files, 10 commits in compare at inspection).
- `package.json`: Fastify, React, Drizzle, Zod, PostgreSQL, Vite, Playwright; no Refine, Ownfleet, VROOM client, scanner, map, chart, notification or ERP SDK dependencies.
- `apps/web/src/App.tsx`: one ~418-line custom SPA, CustomerView, CourierView and OpsView; manually written forms and controls; no external dashboard framework imports.
- `src/services/delivery.ts`: custom pickup/delivery assignment, routes/stops; no optimizer adapter or travel-time matrix integration.
- `src/services/intake.ts`: server-side scan-event dedupe, but no demonstrated camera/QR scanner or durable offline device queue in browser.
- `src/services/finance.ts`: custom journal, invoice and fake capture; fiscal receipt state `pending_registration`, provider `stub`.
- `scripts/smoke-e2e.mjs`: **five assertions for one customer happy-path through fake payment**; not end-to-end courier, partner, claims, settlement, or real browser offline tests.
- `docs/SCENARIO_MATRIX_800.md`: 16 slices x 10 actions x 5 modes; largely repeated generic expectations, a coverage inventory rather than 800 runnable unique tests.
- `test/gaps.integration.test.ts` and `test/operations.integration.test.ts`: real scenario-specific PostgreSQL tests for selected invariants; useful foundation.
- `AGENTS.md` and `.beads/issues.jsonl`: Beads task tracking; several broad slice tasks closed despite remaining UI/provider/operational gaps.
- `README.md` says 31 tests, PR body says 39; reconcile documentation to exact current test output. PR description claims CI quality job success; this inspection did not independently run it.

## Capability truth table
| Slice / role | PR #2 observed | Gap / next proof |
|---|---|---|
| Customer discovery | seeded building and service, quote/order | real multi-address onboarding, availability, mobile UX, customer history |
| Customer pricing | economy/protected, shared and +500 RUB lines | post-inspection changes, mixed tier items, cancellations and all fee permutations UI |
| Slots | transactional holds, expiry, reconciliation | slot change/reschedule UI, exception capacity, route-time coupling |
| Courier | stops, manual intake, scan event API | camera QR/barcode, actual offline IndexedDB queue, device state, route navigation, signature/proof |
| Dispatcher | simple assignment | grouped multi-building routes, VROOM optimization, dispatch map, reassignment and exception handling |
| Partner | receipt, seal mismatch, processing/QC backend | complete role-specific partner UI, batches, rejection/rewash, multi-partner assignment and settlement |
| Delivery | attempts and partial delivery backend | customer confirmation, failed attempt/reschedule, address change, complete driver UI |
| Claims | claim/legal-hold backend | customer self-service, triage/investigation UI, evidence review and appeal workflow |
| Finance | journal, invoices, fake payment/refund | real dashboards, reconciliation exports, provider integration, KKT/OFD and Russian fiscal receipts |
| Notifications | schema/service placeholders | real templates, outbox/worker, retry, preferences, opt-outs, SMS/push/email |
| Security | server sessions/RBAC; demo login disabled by NODE_ENV | production auth, CSRF/session/cookie audit, partner and object-level isolation adversarial tests |
| Evidence | tables/legal-hold logic | actual private upload, retention jobs, content hashes, signed access, video capture/consent |
| Platform | migrations/CI/Compose/Caddy | disaster recovery, backup restore drill, observability, migration upgrade path, secrets review |

## Specific risks to test (hypotheses, not confirmed exploits)
1. `apps/web/src/App.tsx` calls `/dev/seed` on mount; ensure dev routes are entirely unavailable in production, not just demo-login. Test production build/runtime.
2. `demoLogin` accepts arbitrary roles in non-production; never expose staging or internet-facing demo deployment with production-like data.
3. `receiveHandoff` in partner.ts appears to allow an unassigned order to acquire the acting partner on first receipt. Verify partner contract/dispatch assignment must exist before custody transfer; block opportunistic claiming.
4. `currentCourierStops` filters assigned courier; inspect dispatcher behavior, partner ID scoping and all list endpoints for object-level authorization.
5. `recordDeliveryAttempt` proof and `recordIntake` evidence: verify proof is authentic/linked to device/recipient, not merely arbitrary submitted text.
6. Idempotency on retries after network failure: test payment webhook and worker outbox, not only database mutations.
7. Financial postings: verify reversals, balance, duplicate source uniqueness, partial refunds and 54-FZ fiscal events under failure/race.
8. SQL migrations: fresh DB tested, but test upgrade from PR #1 populated DB; check schema drift and guard triggers.
9. One-page UI mixes roles and `OpsView` may not expose many backend functions. Create UI/API capability coverage map rather than assuming endpoints imply usable product.
10. The 800 matrix uses generic variants: assign concrete preconditions, actor, input, expected DB/UI/event/financial results, and automated test path.

## Reuse-first shortlist: evidence and license gates
Candidates below are **evaluation targets**, not code already imported. Pin exact upstream commit, root + package licenses, NOTICE, vulnerability/SBOM and compatibility before reuse.
| Need | Primary candidate | Mode | Gate |
|---|---|---|---|
| Admin/partner/finance portals | https://github.com/refinedev/refine | React/TS package, MIT root checked earlier | replace custom OpsView with data-provider/resource RBAC, prove 3 real role pages |
| Courier/dispatch workflow | https://github.com/Volodymyr4K/ownfleet | TS/React, MIT root checked earlier | verify actual features and maintenance; selective adapter/UI reuse only |
| Vehicle route optimization | https://github.com/VROOM-Project/vroom | C++ separate container, BSD-style license checked earlier | route matrix and grouped-building benchmark, reproducible docker test |
| Routing matrix | https://github.com/Project-OSRM/osrm-backend | isolated service | verify license, region OSM data terms and resource costs |
| QR scan | https://github.com/zxing-js/browser | React browser library candidate | verify current repo/package/license, camera permissions, offline fallback |
| QR alternative | https://github.com/scanapp-org/html5-qrcode | JS browser package candidate | verify current maintenance/license; compare scanner accuracy |
| Internal tools | https://github.com/appsmithorg/appsmith | standalone API integration | optional only if faster than Refine |
| Customer support | https://github.com/chatwoot/chatwoot | API/webhooks, separate Rails service | mixed license, PII scope and deployment costs |
| Notifications | https://github.com/novuhq/novu | separate service/SDK candidate | verify licensing and provider support in Russia |
| Invoicing/accounting | https://github.com/frappe/erpnext | optional external adapter, Python/Frappe | Russian documents and tax suitability must be verified; do not port ERP core |
| Accounting references | https://github.com/bigcapitalhq/bigcapital | AGPL reference only | do not copy proprietary-incompatible source |
| Invoice reference | https://github.com/invoiceninja/invoiceninja | ELv2 reference only | do not copy without legal approval |
| UI components | https://github.com/shadcn-ui/ui | TS/React components | inspect exact license/dependencies and attribution |
| Maps | MapLibre GL JS (verify upstream/license) | frontend map library | use legal tile source; not a routing engine |
| Media | S3-compatible object storage e.g. MinIO (verify license) | private service | evidence legal hold, encrypted retention, backups |
| Workflow / jobs | BullMQ (verify license) | npm adapter | durable retries/outbox, no source copy required |

Avoid needless service sprawl. Score candidates by saved engineering hours, maintenance (recent releases, commits, unresolved security issues), deploy footprint, license compatibility, TypeScript fit, Russian localization, tests and quality. Record reasons for rejecting candidates. Prefer adapting permissive source to inventing a new framework, but **do not copy code merely to maximize copied lines**; optimize working reusable capability and maintainability.

## Independent review verdict
**PR #2 is a functional backend demo with a thin custom UI; not yet the desired deeply branched, reusable, multi-role product.** Existing backend and SQL constraints are valuable and should be preserved. Next wave should prioritize visible, testable multi-role journeys and genuine external code reuse with documented provenance, not a rewrite or additional generic docs.
