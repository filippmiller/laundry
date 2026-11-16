# Implementation status — starter kernel

This branch now contains a **starter TypeScript/Drizzle implementation**, not a complete service:
- package.json / tsconfig.json / drizzle.config.ts
- src/db/schema.ts: organizations, users, buildings, windows, orders, reservations, containers, custody events, idempotency records
- src/domain/order-state.ts: basic order transition guard
- src/domain/pricing.ts: integer-kopeks fee calculation
- test/domain.test.ts: basic Vitest unit tests

## Not implemented
No generated SQL migrations, database connection, transaction-safe capacity reservation service, actual API, UI, authentication, media storage, payment provider, fiscalization, partner processing or production-grade audit trails. Tests are authored but not run by this GitHub connector. No CI workflow added.

## Required next implementation
1. Generate migrations and run fresh/upgrade DB tests in CI.
2. Implement transactional capacity hold with DB locking and expiry worker.
3. Implement custody handoff with dual-party acknowledgement.
4. Add all remaining schema domains with legal/accounting approval.
5. Add auth/RBAC and tenant isolation.
6. Add E2E integration tests against disposable PostgreSQL.

## Limitations
500 RUB per off-schedule action is an illustrative configuration default, not an approved tariff. Order state machine is a starting subset, not the final comprehensive lifecycle. This code is not deployable as a working consumer service.
