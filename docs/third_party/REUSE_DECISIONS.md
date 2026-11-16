# Third-party reuse decisions — PR #3, 2026-11-16

**Scope of this document:** what is actually reused today, what was considered and rejected, and what may not be copied.

## 1. Current state: no third-party product code is integrated

PR #3 contains **no ported source files** from Refine, Ownfleet, VROOM, Chatwoot or any other product. All application code under `src/`, `apps/` and `test/` is original to this repository. The only third-party material is **unmodified npm packages** declared in `package.json` and locked in `package-lock.json`.

This is a deliberate position, not an omission: the audit found no provenance/licence evidence for any ported module, and copying a product UI or AGPL/ELv2 code without review is prohibited.

## 2. Dependency reuse (npm, unmodified)

All direct dependencies are permissive (MIT / Apache-2.0 / BSD-2-Clause) and are used as libraries, not vendored. See `THIRD_PARTY_PROVENANCE.csv` for versions and licences, and `LICENSE_NOTICES.md` for the notice text obligations.

Runtime:
* `fastify` + `@fastify/cookie` / `@fastify/cors` / `@fastify/static` — HTTP server, sessions, CORS, SPA serving.
* `drizzle-orm` + `pg` — typed SQL and PostgreSQL driver.
* `zod` — request validation and OpenAPI generation.
* `react` + `react-dom` — customer/courier/ops SPA.
* `dotenv` — local configuration.

Development/test only:
* `vitest`, `embedded-postgres`, `playwright` (smoke), `tsx`, `drizzle-kit`, `typescript`, `eslint`, `typescript-eslint`, `@eslint/js`, `vite`, `@vitejs/plugin-react`, `@types/*`.

## 3. Considered and explicitly deferred

| Candidate | Why it was considered | Decision now | Condition to revisit |
| --- | --- | --- | --- |
| Refine | Internal admin/partner portals | **DEFERRED** | Only after a licence/security review and a measured prototype; not before W4 |
| Ownfleet (dispatch) | Route optimisation and dispatch UI | **DEFERRED** | Check licence, maintenance, data model and benchmark against the manual fallback |
| VROOM | Vehicle routing | **DEFERRED** | Must pass licence check + benchmark on real building clusters; manual sequencing stays the fallback |
| Chatwoot | Support inbox | **DEFERRED** | Evaluate as a service integration, never as copied source; 152-FZ/localisation review required |
| QR/barcode scanner (e.g. zxing) | Courier scanning | **DEFERRED** | Choose a maintained permissive library in W5; manual entry remains mandatory |

No candidate is "integrated" until there is a provenance row with repository, commit, subpackage, licence, local path, modifications, SBOM/security result and a test.

## 4. Prohibited without explicit owner approval

* AGPL-3.0, SSPL, Elastic License, Commons Clause or any "source-available" code copied into this repository.
* Any code whose licence is unknown or whose provenance cannot be pinned to a commit.
* Copying UI markup from a competitor product.

Approval must be recorded here and in the PR body before the copy lands.
