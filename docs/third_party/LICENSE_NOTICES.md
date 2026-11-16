# Third-party licence notices — PR #3, 2026-11-16

This repository distributes **no vendored third-party source**. The packages below are installed from the npm registry under their own licences; this file records the obligations that apply when the application is distributed.

## MIT (notice + permission text required in distributions)

`@fastify/cookie`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/static`, `@eslint/js`, `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `drizzle-kit`, `embedded-postgres`, `eslint`, `fastify`, `pg`, `react`, `react-dom`, `tsx`, `typescript-eslint`, `vite`, `vitest`, `zod`.

Obligation: retain the copyright notice and permission notice. When a production bundle or container image is built, ship `node_modules` licence files or a generated notice bundle (`license-checker`-style) alongside it. That notice bundle is **not yet generated** and is part of the W6 packaging work.

## Apache-2.0 (notice, licence copy, patent grant, change disclosure)

`drizzle-orm`, `playwright`, `typescript`.

Obligation: include the Apache-2.0 licence text and a NOTICE file if the upstream package provides one; state any modifications (none: these are unmodified npm packages).

## BSD-2-Clause

`dotenv`. Obligation: retain the copyright and licence text.

## Not present

No AGPL, SSPL, Elastic License, Commons Clause or unknown-licence code is included. No third-party product source (Refine, Ownfleet, VROOM, Chatwoot, …) has been copied into this repository.

## Action before distribution

1. Generate a licence bundle for the runtime dependency tree and attach it to the image.
2. Re-run the licence audit after any dependency change.
3. Record any future ported source in `THIRD_PARTY_PROVENANCE.csv` **before** committing it.
