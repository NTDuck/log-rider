#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source scripts/lib/env.sh
source scripts/lib/compose.sh

load_env ".env"

echo "Cleaning generated non-user example data..."

echo "Cleaning ClickHouse analytics data..."
compose exec -T clickhouse clickhouse-client \
  -u "${CLICKHOUSE_USER}" \
  --password "${CLICKHOUSE_PASSWORD}" \
  -q "TRUNCATE TABLE IF EXISTS ${CLICKHOUSE_DATABASE}.${CLICKHOUSE_TABLE_LOG_EVENTS}"

compose exec -T clickhouse clickhouse-client \
  -u "${CLICKHOUSE_USER}" \
  --password "${CLICKHOUSE_PASSWORD}" \
  -q "TRUNCATE TABLE IF EXISTS ${CLICKHOUSE_DATABASE}.${CLICKHOUSE_TABLE_LOG_EVENT_TAGS}"

compose exec -T clickhouse clickhouse-client \
  -u "${CLICKHOUSE_USER}" \
  --password "${CLICKHOUSE_PASSWORD}" \
  -q "TRUNCATE TABLE IF EXISTS ${CLICKHOUSE_DATABASE}.${CLICKHOUSE_TABLE_APP_HEALTH_HOURLY}"

echo "Cleaning Redis generated runtime data only..."

delete_redis_pattern() {
  local pattern="$1"
  compose exec -T redis sh -lc '
    pattern="$1"
    cursor=0
    while :; do
      out=$(redis-cli SCAN "$cursor" MATCH "$pattern" COUNT 500)
      cursor=$(printf "%s\n" "$out" | head -n1)
      keys=$(printf "%s\n" "$out" | tail -n +2)
      if [ -n "$keys" ]; then
        printf "%s\n" "$keys" | xargs -r redis-cli DEL >/dev/null
      fi
      [ "$cursor" = "0" ] && break
    done
  ' sh "$pattern"
}

delete_redis_pattern "${REDIS_KEY_PREFIX_INCIDENT}:*"
delete_redis_pattern "${REDIS_HASH_NOTIFICATION_DATA}"
delete_redis_pattern "${REDIS_ZSET_NOTIFICATION_INDEX}"
delete_redis_pattern "${REDIS_KEY_PREFIX_TAG_CACHE}:*"

rm -rf example/results

echo "Example generated data cleaned."
