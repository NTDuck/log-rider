#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

SCENARIO="${1:-}"
if [ -z "$SCENARIO" ]; then
  echo "Usage: ./benchmarks/run.sh <scenario>"
  exit 1
fi

if [ "$SCENARIO" = "all" ]; then
  for s in benchmarks/scenarios/*.env; do
    name=$(basename "$s" .env)
    ./benchmarks/run.sh "$name"
  done
  exit 0
fi

if [ ! -f "benchmarks/scenarios/$SCENARIO.env" ]; then
  echo "Scenario $SCENARIO not found."
  exit 1
fi

source benchmarks/lib/common.sh
source benchmarks/lib/clickhouse.sh
source benchmarks/lib/redpanda.sh
source benchmarks/lib/redis.sh
source benchmarks/lib/report.sh

if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

source "benchmarks/scenarios/$SCENARIO.env"

TS=$(date +%Y%m%d%H%M%S)
RES_DIR="benchmarks/results/${TS}-${SCENARIO}"
mkdir -p "$RES_DIR"

echo "Running scenario: $SCENARIO"
echo "Results will be saved to $RES_DIR"

# Cleanup
echo "Cleaning up..."
./scripts/cleanup.sh > /dev/null || true
ch_truncate_table "logrider.logs_enriched" || true
ch_truncate_table "logrider.logs" || true
ch_truncate_table "logrider.log_tags" || true

# Wait for healthy
echo "Waiting for services..."
sleep 5

# Start collectors
bash benchmarks/lib/collect-metrics.sh "$RES_DIR" &
COLLECTOR_PID=$!

echo "Starting k6..."
if [ "$SCENARIO" = "api-query" ]; then
  BENCH_TOKEN=$(curl -fsS -X POST "${TARGET_URL:-http://localhost:${SERVER_PORT:-3000}}/login" -H "Content-Type: application/json" -d "{\"username\":\"${LOGIN_USER:-Ayin}\",\"password\":\"${LOGIN_PASSWORD:-admin123}\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  k6 run -e SCENARIO_NAME="$SCENARIO" -e RATE="${RATE:-10}" -e DURATION="${DURATION:-10s}" -e TARGET_URL="${TARGET_URL:-http://localhost:${SERVER_PORT:-3000}}" -e SESSION_TOKEN="$BENCH_TOKEN" --summary-export "$RES_DIR/k6-summary.json" benchmarks/k6/api-query.js > "$RES_DIR/raw.log"
elif [ "$SCENARIO" = "websocket" ]; then
  BENCH_TOKEN=$(curl -fsS -X POST "${TARGET_URL:-http://localhost:${SERVER_PORT:-3000}}/login" -H "Content-Type: application/json" -d "{\"username\":\"${LOGIN_USER:-Ayin}\",\"password\":\"${LOGIN_PASSWORD:-admin123}\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  k6 run -e SCENARIO_NAME="$SCENARIO" -e RATE="${RATE:-10}" -e DURATION="${DURATION:-10s}" -e TARGET_URL="${TARGET_URL:-http://localhost:${SERVER_PORT:-3000}}" -e SESSION_TOKEN="$BENCH_TOKEN" --summary-export "$RES_DIR/k6-summary.json" benchmarks/k6/websocket.js > "$RES_DIR/raw.log"
else
  k6 run -e PROTOCOL="${PROTOCOL:-http}" -e SCENARIO_NAME="$SCENARIO" -e RATE="${RATE:-10}" -e DURATION="${DURATION:-10s}" -e BATCH_SIZE="${BATCH_SIZE:-10}" -e TARGET_URL="${TARGET_URL:-http://localhost:8085/v1/logs}" -e INGEST_API_KEY="${INGEST_API_KEY:-logrider-ingest-key}" --summary-export "$RES_DIR/k6-summary.json" benchmarks/k6/ingest.js > "$RES_DIR/raw.log"
  
  echo "Polling ClickHouse for expected rows: ${EXPECTED_LOGS:-100}"
  ch_wait_for_count "logrider.logs_enriched" "${EXPECTED_LOGS:-100}" "${MAX_DRAIN_SECONDS:-120}" > "$RES_DIR/clickhouse-counts.txt"
fi

kill "$COLLECTOR_PID" || true

# Collect stats
echo "Collecting final stats..."
env > "$RES_DIR/environment.txt"
rp_topics > "$RES_DIR/redpanda-topics.txt" || true
redis_info > "$RES_DIR/redis-info.txt" || true

generate_report "$SCENARIO" "$RES_DIR"

echo "Done. Report saved at $RES_DIR/summary.md"
