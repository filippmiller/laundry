# Laundry — implemented architecture (living document)

## Shape
Modular monolith in TypeScript. PostgreSQL 16+ is the only transactional source of truth. External systems are adapters and never mutate custody or finance tables directly.

- `src/db/schema/*` — Drizzle tables in migration-group order; `drizzle/0000…0012` checked-in SQL, including database-level append-only and balance guards.
- `src/core` — context/RBAC, errors, idempotency spine, event/audit emission.
- `src/domain` — pure rules: kopeks, pricing, order transitions, slot capacity saga.
- `src/services` — transactional use cases for catalog, quotes, orders, intake, partner processing, delivery, claims, finance, auth, seed.
- `src/api` — Fastify HTTP surface with Zod-validated DTOs and a generated OpenAPI 3.1 document.
- `src/workers` — expiry sweep and capacity reconciliation; outbox remains pending until real adapters are approved.
- `apps/web` — React SPA: customer order flow, courier PWA-style intake, ops/finance summary.

## Non-negotiable invariants enforced in code or SQL
1. Tenant and partner scope comes from the server session; request JSON is never trusted for organization identity.
2. Every financial/custody mutation uses one idempotency spine; same key with a different body returns 409; in-flight keys are not re-executed.
3. Capacity holds are conditional SQL updates inside a transaction; two clients cannot take the last slot.
4. TTL expiry never touches a confirmed reservation; reconciliation reports drift and repair requires an admin reason + audit event.
5. Custody events, ledger entries and audit events are append-only at the database trigger level.
6. Ledger journals must balance at commit; refunds cannot exceed captured balance; webhook events are deduplicated by provider event id.
7. Partial delivery does not close an order; claims stay independent of lifecycle; legal holds block evidence expiry.
8. A seal mismatch blocks partner receipt and opens an incident instead of silently transferring custody.
9. A price change requires explicit customer approval bound to the original quote hash; decline never auto-charges.
10. Fiscal receipts start as `pending_registration` with a stub adapter — no claim of a registered 54-FZ receipt.

## Russian-market adaptation
- ru-RU UI, RUB integer kopeks, Europe/Moscow default timezone, Russian service names and procedures.
- Two tariffs with different evidence procedures and transparent disclosure; Economy never waives statutory rights.
- Shared building windows free; off-schedule +500 ₽ per action is a versioned tariff parameter, not a hardcoded promise.
- Adapter interfaces exist for payments, fiscal receipts, media storage and SMS; implementations are stubs pending review.

## Verification loop
For each scenario in `SCENARIO_MATRIX_800` / `ACCEPTANCE_E2E_V2`: trace the scenario to a service and SQL constraint, add or extend an executable test, run lint + typecheck + tests + build, record gaps as beads issues, then remediate. Do not report a feature as done without a passing test and an observable command output.
