# Third-party reuse decisions — PR #3, 2026-11-16

**Scope of this document:** what is actually reused today, what was considered and rejected, and what may not be copied.

## 1. Current state: no third-party product code is integrated
PR #3 contains **no ported source files** from Refine, Ownfleet, VROOM, Chatwoot or any other product. All application code under `src/`, `apps/` and `test/` is original to this repository. The only third-party material is **unmodified npm packages** declared in `package.json` and locked in `package-lock.json`.

This is a deliberate position, not an omission: the audit found no provenance/licence evidence for any ported module, and copying a product UI or AGPL/ELv2 code without review is prohibited.

## 2. Dependency reuse (npm, unmodified)

All direct dependencies are permissive (MIT / Apache-2.0 / BSD-2-Clause) and are used as libraries, not vendored. See `THIRD_PARTY_PROVENANCE.csv` for versions and licences, and `LICENSE_NOTICES.md` for the notice text obligations.

Runtime:
* `fastify` + `@fastify/cookie` / `@fastify/cors` / `@fastify/static` / `@fastify/rate-limit` — HTTP server, sessions, CORS, SPA serving, abuse limits.
* `drizzle-orm` + `pg` — typed SQL and PostgreSQL driver.
* `zod` — request validation and OpenAPI generation.
* `react` + `react-dom` — customer/courier/ops SPA.
* `@zxing/browser` + `@zxing/library` — courier camera QR/barcode scanning with manual fallback (MIT / Apache-2.0).
* `qrcode` — customer/order handoff QR generation (MIT).
* `lucide-react` — crisp icon system across all 8 workspaces (ISC).
* `dotenv` — local configuration.

Development/test only:
* `vitest`, `embedded-postgres`, `playwright` (smoke & multi-role E2E), `tsx`, `drizzle-kit`, `typescript`, `eslint`, `typescript-eslint`, `@eslint/js`, `vite`, `@vitejs/plugin-react`, `@types/*`.

## 3. Considered, integrated via adapter, and deferred

| Candidate | Why it was considered | Decision now | Condition to revisit |
| --- | --- | --- | --- |
| `@zxing/browser` + `@zxing/library` | Courier camera QR/barcode scanning | **INTEGRATED (Wave 7)** | MIT + Apache-2.0, npm-installed, wrapped with native `BarcodeDetector` & manual fallback |
| `qrcode` + `lucide-react` | Order handoff QR badges & accessible UI icons | **INTEGRATED (Wave 7)** | MIT / ISC permissive npm packages |
| VROOM | Vehicle routing optimization | **ADAPTER + BUILTIN VRPTW SOLVER** | VROOM HTTP adapter (`VROOM_URL`) + deterministic building-cluster 2-Opt VRPTW fallback (`src/services/routing.ts`); optional Docker service |
| Refine | Internal admin/partner portals | **DEFERRED** | Replaced by modular 8-workspace React 19 architecture using shared data/RBAC patterns; avoids antd/MUI bloat |
| Ownfleet (dispatch) | Route optimisation and dispatch UI | **REFERENCE ONLY** | Dispatch & courier stop model adapted cleanly to Laundry's dual-leg & seal/custody schema |
| Chatwoot | Support inbox | **DEFERRED** | Support threads/omnibus lookup kept in-core for strict tenant/order/152-FZ scoping; external webhook bridge only if approved |
| `GoogleChrome/modern-web-guidance` | Modern web standards & DOM/CSS audit | **TOOLCHAIN INTEGRATED** | Ran `legacy-scan apps/web` (0 legacy findings) and applied `<dialog>`, `[popover]`, `@container`, `:has()`, `100dvh`, View Transitions |

No candidate is "integrated" until there is a provenance row with repository, commit, subpackage, licence, local path, modifications, SBOM/security result and a test.

## 4. Prohibited without explicit owner approval

* AGPL-3.0, SSPL, Elastic License, Commons Clause or any "source-available" code copied into this repository.
* Any code whose licence is unknown or whose provenance cannot be pinned to a commit.
* Copying UI markup from a competitor product.

Approval must be recorded here and in the PR body before the copy lands.
