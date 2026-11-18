# The isolated preview instance at laundry.filippmiller.com

**Date:** 2026-11-18
**Deployed commit:** `52ad21db181e305b9f3a8327a922bb7b6c62971c` (branch `docs/pr2-independent-audit-autonomous-wave`, PR #3, still Draft)
**Host:** `hetzner-prod` (`vps-main`, `89.167.42.128`) — a shared production VPS that fronts ~20 other services
**Status:** live and verified end to end from outside the host

---

## What this is, and what it is not

This is a **public demo instance**. It exists so that a visitor can walk the product without an account.

It is **not** a production pilot, and the difference is not cosmetic — it is enforced by the configuration and by the code:

| | This instance | A production pilot would need |
|---|---|---|
| Authentication | `PREVIEW_MODE=enabled` — sign-in only as a seeded demo persona | A real SMS/auth provider, 152-FZ handling of the data |
| Payments | `PAYMENT_PROVIDER=fake` — nothing is charged | A real acquiring bank, receipts, reconciliation |
| Fiscalisation | `FISCAL_PROVIDER=stub` — no fiscal receipt is issued | A real fiscal provider (KKT/ФН) integration |
| Data | Synthetic rows in one seeded demo tenant | Real customers, their garments, their addresses |
| Legal | Consumer contract, 54-FZ, offer, partner obligations — **all unpassed** | Signed off by a lawyer, not by an agent |

The G7 legal gate from the master plan remains open. No part of this deployment closes it, and nothing here should be read as evidence that it could be closed by an agent.

## Why the deployment needed a preview profile at all

The production build of this codebase has **no working sign-in**. With `NODE_ENV=production` and the preview profile off:

- `POST /auth/demo-login` → **401** (`DEMO_AUTH_DISABLED`)
- `POST /auth/otp/request` → **404** (the phone OTP provider is absent in production)
- `POST /auth/preview-unlock` → **404**
- `POST /dev/seed` → **404**

That was verified empirically with `scripts/probe-production-auth.mjs` before anything was deployed. A straight production deploy would therefore have produced a healthy-looking container serving a login form that could never succeed, over an empty database.

The preview profile (`src/core/preview.ts`) is the fenced way out. It is only active when `PREVIEW_MODE=enabled`, and it holds these rules:

- it only ever touches the seeded demo tenant (`Демо-прачечная`);
- a visitor may only sign in as an identity the demo seed created;
- a visitor may only hold a role that identity actually holds;
- the client may **narrow** the roles it asks for, never widen them.

The rules live in one module so the sign-in service and the unlock service cannot drift apart. `isPreviewProfileEnabled()` is deliberately named apart from the pre-existing, looser `isPreviewEnabled()` in `services/auth.ts`, which answers a different question — mixing the two up would have silently widened a production surface.

## How it is wired on the host

The host's ports 80 and 443 are already owned by `coolify-proxy` (Traefik), which fronts ~20 other services. The repository's `infra/docker-compose.yml` publishes 80/443 from a caddy service and therefore **cannot** be used there as is. `infra/docker-compose.preview.yml` is a standalone stack that adapts to the host:

- **No caddy.** TLS is terminated by the existing Traefik, which was never restarted.
- **One image** (`laundry:preview`) shared by the `migrate`, `api` and `worker` services.
- **The database never publishes a port.** It is reachable only from the stack's own network.
- **The api joins the shared `coolify` network** under the alias `laundry-api`, which is how Traefik reaches it.
- **Bounded resources.** Every service has a memory ceiling (768 MiB api/db, 512 MiB migrate/worker), a CPU ceiling, and a capped log (10 MiB × 3).

The route is a file in Traefik's watched dynamic directory, `/data/coolify/proxy/dynamic/laundry.yaml` (copy of `infra/traefik/laundry.yaml`). The proxy runs with `--providers.file.watch=true`, so the route went live without touching the proxy. The host's catch-all router has priority `-1000`; a `Host` rule outranks it, so only this domain was affected.

Secrets were generated on the host into `/opt/laundry/src/.env` (mode `600`) — a random database password, a random session secret and a random payment webhook secret. No secret is recorded in this repository, in this document, in a commit, or in an issue.

### Layout on the host

```
/opt/laundry/src                    the checkout, at the deployed commit
/opt/laundry/src/.env               generated secrets, mode 600, never committed
/opt/laundry/deploy-preview.sh      build + up + health wait (idempotent)
/opt/laundry/activate-route.sh      installs the Traefik route file
/opt/laundry/verify-preview.sh      the checks below, run over HTTPS
```

### Redeploying

```bash
cd /opt/laundry/src
git fetch origin && git checkout --force <commit>
docker compose --env-file .env -f infra/docker-compose.preview.yml build
docker compose --env-file .env -f infra/docker-compose.preview.yml up -d
```

The database volume and the `.env` are reused, so a redeploy does not wipe the demo data or rotate the secrets.

### Rolling back

```bash
cd /opt/laundry/src
docker compose --env-file .env -f infra/docker-compose.preview.yml down
rm -- /data/coolify/proxy/dynamic/laundry.yaml
```

The proxy picks the removal up within a second, and the domain returns to the host's catch-all response. `down` leaves the database volume in place; add `-v` to remove the data as well.

## What was verified, and how

From a workstation outside the host, against the public URL over HTTPS:

```
GET  /                          -> 200   (the web app is served)
GET  /api/v1/health/ready       -> 200
GET  /api/v1/me                 -> 401   (no session: correctly refused)
GET  /api/v1/orders             -> 401   (no session: correctly refused)
POST /api/v1/auth/demo-login    -> 200   roles: ["customer"]
GET  /api/v1/me                 -> 200   roles: ["customer"]
```

`scripts/verify-preview-live.mjs` walks the whole customer journey against the live URL and then confirms that the fences still hold — **18 checks, all passing, `LIVE_PREVIEW_OK`**:

```
PASS health/ready answers 200          PASS a quote is priced
PASS the web app is served             PASS the order is placed
PASS the demo tenant seeds             PASS both legs are held
PASS the demo persona signs in         PASS the order is scheduled
PASS only the roles the identity holds are granted
PASS the session is accepted           PASS the order reads back
PASS the customer has an address       PASS a role the identity does not hold is refused
PASS the catalog is published          PASS an identity the seed never created is refused
PASS the catalog has a priceable service
PASS pickup windows are offered
PASS delivery windows are offered
```

TLS is a valid Let's Encrypt certificate for `laundry.filippmiller.com` (issued 2026-11-18, valid to 2027-02-16), served through the host's existing `letsencrypt` resolver.

## Repository gates on the deployed commit

| Gate | Result |
|---|---|
| `npm run lint` | clean, 0 errors |
| `npm run typecheck` | clean, 0 errors |
| `npm test` | **203 passed / 30 files, 0 skipped** (189 before the preview work, +14 new) |
| `npm run web:build` | pass |
| `npm run guard:hygiene` | OK, 250 tracked files, no violations |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm run db:generate` + drift check | no drift |
| browser smoke (`scripts/smoke-local.mjs`) | 11/11 |
| CI on the deployed head | **success** (run `44353926341`) |

The CI failure that predates this work (`44349238184`, `ECONNREFUSED 127.0.0.1:55433`) is fixed: `vitest.config.ts` hardcoded the test database URL and `test.env` injected it into every worker, overriding the CI environment. The suite now takes the URL from `TEST_DATABASE_URL` when the environment provides it. It was proven against an external PostgreSQL on a different port (`scripts/verify-external-test-db.mjs` → `EXTERNAL_DATABASE_SUITE_OK`).

## Impact on the shared host

The stack is small and bounded:

```
laundry-preview-api-1     107 MiB / 768 MiB   0.31% CPU
laundry-preview-worker-1   70 MiB / 512 MiB   0.13% CPU
laundry-preview-db-1       24 MiB / 768 MiB   0.01% CPU
```

Host load average moved from **6.57 to 4.35** across the deployment window, available memory from **4.7 GiB to 5.5 GiB**, and free disk from 74 GiB to 71 GiB. The other 166 containers were not restarted, and `coolify-proxy` was never restarted.

## What is still not true

- No real payment, no real fiscalisation, no real SMS provider, no real routing provider.
- No legal sign-off: consumer contract, 54-FZ, offer, partner obligations, 152-FZ for video.
- The preview profile is a **demo profile**, and the demo database contains synthetic rows only. It is not a pilot.
- `/dev/seed` is reachable publicly while the preview profile is on. It is idempotent — the second call is a no-op — and it writes only to the seeded demo tenant, but it is a public write endpoint by design and should be disabled when the instance is retired.
- The residual 170 MB copy of the previously exposed cluster at `%LOCALAPPDATA%\Temp\pgdrill` still needs manual removal. It contains synthetic data only, classified `TEST_ONLY` in bead `lnd-9l7`.
