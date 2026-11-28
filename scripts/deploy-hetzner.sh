#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/laundry}"
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: $APP_DIR/.env is missing. Copy .env.example and set strong secrets first." >&2
  exit 1
fi

COMPOSE=(docker compose -f infra/docker-compose.yml)

# How long the worker may take to report a healthy heartbeat. The worker's healthcheck only
# passes once it has completed a cycle, so this must comfortably cover one cycle plus the
# healthcheck's own start period.
WORKER_HEALTH_TIMEOUT_SECS="${WORKER_HEALTH_TIMEOUT_SECS:-240}"

echo "==> Running database migrations and starting containers..."
"${COMPOSE[@]}" up -d --build

echo "==> Waiting for /api/v1/health/ready..."
api_ready=0
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T api \
    node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    api_ready=1
    break
  fi
  sleep 2
done

if [[ "$api_ready" -ne 1 ]]; then
  echo "ERROR: API failed readiness check" >&2
  "${COMPOSE[@]}" logs --tail=60 api >&2 || true
  exit 1
fi
echo "API is ready."

# The worker serves no HTTP endpoint, so its health is its own work: the heartbeat file it
# writes after every successful cycle. A deploy that leaves a worker which never cycles is a
# deploy that silently stops expiring slot holds and delivering the outbox, so the worker is
# a gate here and not an afterthought.
worker_health_status() {
  local container_id status
  container_id=$("${COMPOSE[@]}" ps -q worker 2>/dev/null | head -n 1 || true)
  if [[ -z "$container_id" ]]; then
    echo "missing"
    return 0
  fi
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)
  echo "${status:-unknown}"
}

echo "==> Waiting for the worker to complete a cycle..."
worker_healthy=0
deadline=$((SECONDS + WORKER_HEALTH_TIMEOUT_SECS))
while ((SECONDS < deadline)); do
  status=$(worker_health_status)
  if [[ "$status" == "healthy" ]]; then
    worker_healthy=1
    break
  fi
  sleep 5
done

if [[ "$worker_healthy" -ne 1 ]]; then
  echo "ERROR: the worker did not report a healthy heartbeat within ${WORKER_HEALTH_TIMEOUT_SECS}s." >&2
  echo "       The worker is not completing cycles, so slot holds are never released and the" >&2
  echo "       outbox is never delivered. Inspect it with:" >&2
  echo "         docker compose -f infra/docker-compose.yml logs --tail=60 worker" >&2
  "${COMPOSE[@]}" logs --tail=60 worker >&2 || true
  exit 1
fi
echo "Worker is healthy."

"${COMPOSE[@]}" ps
exit 0
