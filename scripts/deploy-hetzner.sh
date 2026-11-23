#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/laundry}"
cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: $APP_DIR/.env is missing. Copy .env.example and set strong secrets first." >&2
  exit 1
fi

echo "==> Running database migrations and starting containers..."
docker compose -f infra/docker-compose.yml up -d --build

echo "==> Waiting for /api/v1/health/ready..."
for i in $(seq 1 30); do
  if docker compose -f infra/docker-compose.yml exec -T api \
    node -e "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "API is ready."
    docker compose -f infra/docker-compose.yml ps
    exit 0
  fi
  sleep 2
done

echo "API failed readiness check" >&2
docker compose -f infra/docker-compose.yml logs --tail=60 api
exit 1
