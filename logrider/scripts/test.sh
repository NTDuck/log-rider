#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

# "$SCRIPT_DIR/cleanup.sh"

echo "Running standard load test (500 diverse logs)..."

payload=$(python3 - <<'PY'
import json, uuid, datetime, random

apps = ["sshd(pam_unix)", "ftpd", "syslogd 1.4.1", "logrotate"]
levels = ["INFO", "WARN", "ERROR", "CRITICAL"]
messages = [
    "authentication failure",
    "check pass; user unknown",
    "connection from remote host",
    "service restarted",
]

now = datetime.datetime.utcnow().isoformat(timespec="milliseconds") + "Z"

records = []
for _ in range(500):
    records.append({
        "value": {
            "Application_Name": random.choice(apps),
            "Log_Level": random.choice(levels),
            "Message": random.choice(messages),
            "Timestamp": now,
            "Trace_ID": str(uuid.uuid4()),
        }
    })

print(json.dumps({"records": records}))
PY
)

RESP=$(docker compose -f "$COMPOSE_FILE" exec -e PAYLOAD="$payload" -T redpanda bash -lc '
  curl -fsS \
    -X POST \
    -H "Content-Type: application/vnd.kafka.json.v2+json" \
    --data-binary "$PAYLOAD" \
    http://localhost:8082/topics/logs-ingested
')

echo "$RESP"

echo "Waiting for pipeline flush..."
MAX_WAIT=60
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -q "SELECT count() FROM logrider.logs_enriched" | tr -d '[:space:]')
    if [ "$COUNT" -ge 500 ]; then
        break
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

echo "Verifying ClickHouse entries..."
COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -q "SELECT count() FROM logrider.logs_enriched" | tr -d '[:space:]')
echo "Total logs in ClickHouse: $COUNT"

if [ "$COUNT" -ne 500 ]; then
    echo "Expected exactly 500 logs after cleanup + test run, got $COUNT"

    echo "DLQ sample:"
    docker compose -f "$COMPOSE_FILE" exec -T redpanda rpk topic consume dlq-clickhouse --num 5 || true

    echo "Persist worker logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=100 benthos-persist

    echo "ClickHouse logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=100 clickhouse

    exit 1
fi
