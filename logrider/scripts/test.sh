#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

RUN_ID="test-$(date +%s)-$RANDOM"
APP_NAME="logrider-test-$RUN_ID"
EXPECTED=500

echo "Running standard load test: $EXPECTED logs for $APP_NAME"

PAYLOAD=$(APP_NAME="$APP_NAME" EXPECTED="$EXPECTED" python3 - <<'PY'
import json, os, uuid, random, datetime

app = os.environ["APP_NAME"]
n = int(os.environ["EXPECTED"])
levels = ["INFO", "WARN", "ERROR", "CRITICAL"]
messages = [
    "authentication failure",
    "connection accepted",
    "service restarted",
    "disk threshold warning",
    "critical daemon failure",
]

records = []
for _ in range(n):
    records.append({
        "value": {
            "Application_Name": app,
            "Log_Level": random.choice(levels),
            "Message": random.choice(messages),
            "Timestamp": datetime.datetime.utcnow().isoformat(timespec="milliseconds") + "Z",
            "Trace_ID": str(uuid.uuid4()),
        }
    })

print(json.dumps({"records": records}))
PY
)

docker compose -f "$COMPOSE_FILE" exec -e PAYLOAD="$PAYLOAD" -T redpanda bash -lc '
  curl -fsS \
    -X POST \
    -H "Content-Type: application/vnd.kafka.json.v2+json" \
    --data-binary "$PAYLOAD" \
    http://localhost:8082/topics/logs-ingested
' >/tmp/logrider-pandaproxy-response.json

echo "Waiting for persistence..."
for i in $(seq 1 90); do
  COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
    -u "${CLICKHOUSE_USER:-default}" \
    --password "${CLICKHOUSE_PASSWORD:-password}" \
    -q "SELECT count() FROM logrider.logs_enriched WHERE Application_Name = '$APP_NAME' FORMAT TSV" | tr -d '[:space:]')

  echo "  persisted=$COUNT/$EXPECTED"

  if [ "$COUNT" -eq "$EXPECTED" ]; then
    echo "PASS: $EXPECTED logs persisted for $APP_NAME"
    break
  fi

  if [ "$i" -eq 90 ]; then
    echo "FAIL: expected $EXPECTED persisted logs for $APP_NAME"
    echo "Pandaproxy response:"
    cat /tmp/logrider-pandaproxy-response.json || true
    echo "DLQ sample:"
    docker compose -f "$COMPOSE_FILE" exec -T redpanda rpk topic consume dlq-clickhouse --num 5 || true
    echo "Benthos persist logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=100 benthos-persist || true
    exit 1
  fi
  sleep 1
done

echo "Waiting for classification tags..."
for i in $(seq 1 120); do
  TAG_COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
    -u "${CLICKHOUSE_USER:-default}" \
    --password "${CLICKHOUSE_PASSWORD:-password}" \
    -q "SELECT count() FROM logrider.log_tags WHERE Application_Name = '$APP_NAME' FORMAT TSV" | tr -d '[:space:]')

  echo "  classified=$TAG_COUNT/$EXPECTED"

  if [ "$TAG_COUNT" -eq "$EXPECTED" ]; then
    echo "PASS: $EXPECTED logs classified for $APP_NAME"
    exit 0
  fi
  
  if [ "$i" -eq 120 ]; then
    echo "FAIL: logs persisted but classification did not complete"
    docker compose -f "$COMPOSE_FILE" logs --tail=150 classifier-worker benthos-tags || true
    exit 1
  fi
  sleep 1
done
