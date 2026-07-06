#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "Missing .env file"
  exit 1
fi
source .env

PROTOCOL=${1:-http}
LOGS_PER_SECOND=${2:-250}
DURATION=${3:-2s}
SCENARIO=${4:-manual}

EXPECTED_COUNT=$(( LOGS_PER_SECOND * ${DURATION%s} ))

echo "Starting benchmark: $PROTOCOL, $LOGS_PER_SECOND logs/s, $DURATION, scenario=$SCENARIO"

# Ensure k6 data exists
if [ ! -f "example/data/k6_logs.json" ]; then
    echo "Creating dummy data for k6..."
    mkdir -p example/data
    cat <<EOF > example/data/k6_logs.json
[
  {"application_name": "checkout-service", "severity": "INFO", "message": "Payment processed successfully"},
  {"application_name": "auth-service", "severity": "ERROR", "message": "Failed to validate token"},
  {"application_name": "inventory-api", "severity": "WARN", "message": "Low stock for item X"}
]
EOF
fi

if [ ! -f "example/package.json" ]; then
  cat <<EOF > example/package.json
{
  "name": "example-analytics",
  "dependencies": {
    "redis": "^4.6.13",
    "dotenv": "^16.4.5"
  }
}
EOF
fi

if [ ! -d "example/node_modules" ]; then
  cd example && npm install && cd ..
fi

echo "Starting analytics collector in background..."
EXPECTED_COUNT=$EXPECTED_COUNT REDIS_URL=redis://localhost:6379 node example/analytics.js &
ANALYTICS_PID=$!

echo "Running k6..."
docker run --rm -i \
  -v "$PWD/benchmarks:/app/benchmarks" \
  -v "$PWD/example/data:/app/example/data" \
  -v "$PWD/apps:/app/apps" \
  -e TARGET_URL="http://host.docker.internal:${INGEST_HTTP_PORT}/v1/logs" \
  -e GRPC_URL="host.docker.internal:${INGEST_GRPC_PORT}" \
  -e PROTOCOL="$PROTOCOL" \
  -e RATE="$LOGS_PER_SECOND" \
  -e DURATION="$DURATION" \
  -e BATCH_SIZE="1" \
  -e SCENARIO_NAME="$SCENARIO" \
  -e INGEST_API_KEY="${INGEST_API_KEY}" \
  --add-host host.docker.internal:host-gateway \
  grafana/k6 run /app/benchmarks/k6/ingest.js

echo "Waiting a few seconds for pipelines to drain..."
sleep 5

echo "Stopping analytics..."
kill -SIGINT $ANALYTICS_PID || true
wait $ANALYTICS_PID || true

echo "Debug counts:"
echo "- ingest HTTP accepted: ${ACCEPTED_COUNT:-unknown}"

echo "- Kafka topics:"
docker compose exec -T redpanda rpk topic list | grep -E 'logs-ingested|logrider.logs.received|logrider.logs.normalized|logrider.logs.persistence' || true

echo "- Router logs:"
docker compose logs --tail=50 stream-router || true

echo "- Ingest logs:"
docker compose logs --tail=50 ingest-api || true

docker compose exec -T redpanda rpk group describe logrider.router.unified.v1 || true

echo "Done."
