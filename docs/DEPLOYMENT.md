# Laundry — deployment on Hetzner (laundry.filippmiller.com)

Status: **prepared, not deployed**. Deployment requires an explicit owner instruction.

## Topology
- Hetzner VPS with Docker + Compose plugin.
- Caddy terminates TLS and serves `laundry.filippmiller.com` (DNS A record points at the host).
- One PostgreSQL 16 container, one API container (also serves the built React SPA), one worker container.
- Billing/fiscal/payment adapters are stubs until Russian providers and the legal model are approved.

## Steps (owner-approved runbook)
1. DNS: A `laundry.filippmiller.com` → Hetzner host IP.
2. On host: create `/srv/laundry`, copy `infra/docker-compose.yml`, `infra/Caddyfile`, `infra/Dockerfile`, and the repository.
3. Create `.env` from the template with strong `POSTGRES_PASSWORD` and `SESSION_SECRET` (never commit).
4. `docker compose -f infra/docker-compose.yml up -d --build`.
5. `docker compose -f infra/docker-compose.yml logs -f api` — migrations must report success.
6. Verify `https://laundry.filippmiller.com/api/v1/health` and the SPA. Demo login and `/dev/seed` are disabled when `NODE_ENV=production`; a real auth adapter and seed process are required.
7. Backups: `pg_dump` from the db container on a schedule; rehearse restore before public launch.

## Production gates (must all be true)
- Legal sign-off: consumer terms, principal/agent role, 54-FZ KKT/OFD, 152-FZ and video retention, partner acts/UPD, refund policy.
- Real auth provider (phone OTP) and RBAC provisioning; no demo endpoints.
- Payment/fiscal providers selected, pinned and reviewed; no claim of compliance before that.
- Real tariff economics and pilot density for 3–5 buildings.
- Backup/restore drill, migration dry-run on anonymised copy, monitoring and alerting.
