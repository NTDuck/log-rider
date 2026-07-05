#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

# Sends 5 logs, one for each level via Redpanda Pandaproxy from inside the compose network.
LEVELS=("DEBUG" "INFO" "WARN" "ERROR" "CRITICAL")
APPS=("auth-service" "billing-app" "payment-gateway" "user-profile" "inventory-sys")
MESSAGES=("connection timeout" "successful login" "high latency detected" "database query failed" "system crashed")

records=()
for i in {0..4}; do
    level=${LEVELS[$i]}
    app=${APPS[$i]}
    msg=${MESSAGES[$i]}
    trace=$(cat /proc/sys/kernel/random/uuid)
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

    records+=("{\"value\":{\"Application_Name\":\"$app\",\"Log_Level\":\"$level\",\"Message\":\"$msg\",\"Timestamp\":\"$timestamp\",\"Trace_ID\":\"$trace\"}}")
    echo "Prepared $level log for $app"
done

payload=$(printf '{"records":[%s]}' "$(IFS=,; echo "${records[*]}")")

docker compose -f "$COMPOSE_FILE" exec -T redpanda bash -lc "
  curl -sS -X POST http://localhost:8082/topics/logs-ingested \
    -H 'Content-Type: application/vnd.kafka.json.v2+json' \
    -d '$payload'
"

echo
echo "Test complete."
