#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source scripts/lib/env.sh
source scripts/lib/compose.sh

load_env ".env"

if [ "${LOGRIDER_ENABLE_DEMO:-false}" != "true" ]; then
  echo "Error: LOGRIDER_ENABLE_DEMO must be true in .env" >&2
  exit 1
fi

echo "Cleaning up demo environment..."

# Delete demo users
compose exec -T postgres psql -U "${POSTGRES_USER}" -d logrider -c "DELETE FROM users WHERE role IN ('admin', 'engineer');"

# Clear Redis state
compose exec -T redis redis-cli flushall

# Truncate ClickHouse tables
compose exec -T clickhouse clickhouse-client -u "${CLICKHOUSE_USER}" --password "${CLICKHOUSE_PASSWORD}" -q "TRUNCATE TABLE logrider_analytics.log_events"
compose exec -T clickhouse clickhouse-client -u "${CLICKHOUSE_USER}" --password "${CLICKHOUSE_PASSWORD}" -q "TRUNCATE TABLE logrider_analytics.app_health_hourly"

echo "Demo cleanup complete."
