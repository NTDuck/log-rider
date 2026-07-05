#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

RATE="${RATE:-2000}"
DURATION="${DURATION:-10s}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$PROJECT_DIR")}"
COMPOSE_NETWORK="${COMPOSE_PROJECT_NAME}_default"

echo "Running high-rate load test with k6 (RATE=$RATE req/s, DURATION=$DURATION)..."
docker run --rm --network "$COMPOSE_NETWORK" -i \
    -e RATE="$RATE" \
    -e DURATION="$DURATION" \
    -e INGEST_URL=http://ingest-worker:8085/v1/logs \
    grafana/k6 run - < k6-load.js

echo "Waiting 5 seconds for pipeline flush..."
sleep 5

echo "Verifying ClickHouse entries..."
COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -u default --password password -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
