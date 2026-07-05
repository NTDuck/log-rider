#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

RUN_ID="test-alert-$(date +%s)-$RANDOM"
APP_NAME="logrider-alert-$RUN_ID"
EXPECTED=500

echo "Running alert test: $EXPECTED CRITICAL logs for $APP_NAME"

PAYLOAD=$(APP_NAME="$APP_NAME" EXPECTED="$EXPECTED" python3 - <<'PY'
import json, os, uuid, datetime

app = os.environ["APP_NAME"]
n = int(os.environ["EXPECTED"])

records = []
for _ in range(n):
    records.append({
        "Application_Name": app,
        "Log_Level": "CRITICAL",
        "Message": "critical daemon failure for alert test",
        "Timestamp": datetime.datetime.utcnow().isoformat(timespec="milliseconds") + "Z",
        "Trace_ID": str(uuid.uuid4()),
    })

print(json.dumps({"records": records}))
PY
)

curl -fsS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-LogRider-Ingest-Key: logrider-ingest-key" \
  --data-binary "$PAYLOAD" \
  http://localhost:8085/v1/logs >/tmp/logrider-ingest-response.json

echo "Payload sent to ingest. Waiting for alerts to persist..."

for i in $(seq 1 90); do
  COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
    -u "${CLICKHOUSE_USER:-default}" \
    --password "${CLICKHOUSE_PASSWORD:-password}" \
    -q "SELECT count() FROM logrider.logs_enriched WHERE Application_Name = '$APP_NAME' FORMAT TSV" | tr -d '[:space:]')

  echo "  persisted=$COUNT/$EXPECTED"

  if [ "$COUNT" -eq "$EXPECTED" ]; then
    echo "PASS: $EXPECTED logs persisted for $APP_NAME"
    exit 0
  fi

  if [ "$i" -eq 90 ]; then
    echo "FAIL: expected $EXPECTED persisted logs for $APP_NAME"
    exit 1
  fi
  sleep 1
done
