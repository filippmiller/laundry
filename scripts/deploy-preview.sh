#!/usr/bin/env bash
# Redeploy the isolated laundry preview instance.
#
# Run as root on the host that fronts laundry.filippmiller.com. It reuses the existing .env and the
# existing database volume, so a re-run is a redeploy rather than a reset.
set -euo pipefail

APP_DIR=/opt/laundry/src
COMMIT="${COMMIT:?set COMMIT to the deployed commit}"
BRANCH="${BRANCH:-docs/pr2-independent-audit-autonomous-wave}"

cd "$APP_DIR"

echo "== checkout =="
git fetch --quiet origin "$BRANCH"
git checkout --quiet --force "$COMMIT"
echo "commit: $(git rev-parse HEAD)"

ENV_FILE="$APP_DIR/.env"
chmod 600 "$ENV_FILE"
echo "env keys: $(cut -d= -f1 "$ENV_FILE" | tr '\n' ' ')"

COMPOSE=(docker compose --env-file "$ENV_FILE" -f infra/docker-compose.preview.yml)

echo "== validate =="
"${COMPOSE[@]}" config > /dev/null
echo "compose config OK"

echo "== build =="
"${COMPOSE[@]}" build 2>&1 | tail -25

echo "== up =="
"${COMPOSE[@]}" up -d 2>&1 | tail -25

echo "== ps =="
"${COMPOSE[@]}" ps

echo "== wait for the api =="
api_ready=0
for attempt in $(seq 1 40); do
  if docker compose --env-file "$ENV_FILE" -f infra/docker-compose.preview.yml \
      exec -T api node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "api is ready after ${attempt} attempt(s)"
    api_ready=1
    break
  fi
  sleep 5
done
if [[ "$api_ready" -ne 1 ]]; then
  echo "api did not become ready in time" >&2
  "${COMPOSE[@]}" logs --tail 40 api >&2 || true
  exit 1
fi

# The worker serves no HTTP endpoint, so "the container is up" says nothing about it. The deploy
# waits for the worker's own probe to report a recent successful cycle: a worker that is running
# but stuck no longer passes, and a preview without a working worker silently loses the outbox
# delivery and the TTL release of slot holds.
echo "== wait for the worker =="
WORKER_HEALTH_TIMEOUT_SECS="${WORKER_HEALTH_TIMEOUT_SECS:-240}"
worker_attempts=$(( WORKER_HEALTH_TIMEOUT_SECS / 5 + 1 ))
for attempt in $(seq 1 "$worker_attempts"); do
  if "${COMPOSE[@]}" exec -T worker node scripts/worker-health.mjs 2>/dev/null; then
    echo "worker is healthy after ${attempt} attempt(s)"
    exit 0
  fi
  sleep 5
done
echo "worker did not complete a cycle in time" >&2
"${COMPOSE[@]}" logs --tail 40 worker >&2 || true
exit 1
