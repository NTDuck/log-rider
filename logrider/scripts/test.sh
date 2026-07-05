#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

echo "Running standard load test (exactly 500 logs in 2 seconds)..."
docker compose -f "$COMPOSE_FILE" exec -T redpanda bash -lc '
  for i in $(seq 1 500); do
    trace_id=$(cat /proc/sys/kernel/random/uuid)
    curl -s -o /dev/null -X POST \
      -H "Content-Type: application/vnd.kafka.json.v2+json" \
      -d "{\"records\":[{\"value\":{\"Application_Name\":\"load-test-service\",\"Log_Level\":\"INFO\",\"Message\":\"load test message\",\"Timestamp\":\"2026-07-05T00:00:00Z\",\"Trace_ID\":\"${trace_id}\"}}]}" \
      http://localhost:8082/topics/logs-ingested &
  done
  wait
'

echo "Waiting for pipeline flush..."
MAX_WAIT=60
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -u default --password password -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
    if [ "$COUNT" -ge 500 ]; then
        break
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

echo "Verifying ClickHouse entries..."
COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -u default --password password -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"

if [ "$COUNT" -ne 500 ]; then
    echo "Expected exactly 500 logs after cleanup + test run, got $COUNT"
    exit 1
fi
