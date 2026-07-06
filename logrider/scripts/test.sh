#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

EXPECTED=500

echo "Running standard load test: $EXPECTED logs using realistic data..."

BEFORE_COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
  -u "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-password}" \
  -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV" | tr -d '[:space:]')
EXPECTED_TOTAL=$((BEFORE_COUNT + EXPECTED))

PAYLOAD=$(PROJECT_DIR="$PROJECT_DIR" EXPECTED="$EXPECTED" python3 - <<'PY'
import json, os, uuid, random, datetime, csv

csv_path = os.path.join(os.environ["PROJECT_DIR"], "data", "Linux_2k.log_structured.csv")
with open(csv_path, "r") as f:
    rows = list(csv.DictReader(f))

n = int(os.environ["EXPECTED"])
levels = ["INFO", "WARN", "ERROR", "CRITICAL"]

records = []
for _ in range(n):
    row = random.choice(rows)
    records.append({
        "Application_Name": row["Component"],
        "Log_Level": random.choice(levels),
        "Message": row["Content"],
        "Timestamp": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
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

echo "Waiting for persistence (expected total: $EXPECTED_TOTAL)..."
for i in $(seq 1 90); do
  COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
    -u "${CLICKHOUSE_USER:-default}" \
    --password "${CLICKHOUSE_PASSWORD:-password}" \
    -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV" | tr -d '[:space:]')

  echo "  persisted=$COUNT/$EXPECTED_TOTAL"

  if [ "$COUNT" -ge "$EXPECTED_TOTAL" ]; then
    echo "PASS: $EXPECTED logs persisted"
    break
  fi

  if [ "$i" -eq 90 ]; then
    echo "FAIL: expected $EXPECTED_TOTAL persisted logs"
    exit 1
  fi
  sleep 1
done

echo "Waiting for classification tags..."
BEFORE_TAG_COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
  -u "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-password}" \
  -q "SELECT count() FROM logrider.log_tags FORMAT TSV" | tr -d '[:space:]')
EXPECTED_TAG_TOTAL=$((BEFORE_TAG_COUNT + EXPECTED))

for i in $(seq 1 120); do
  TAG_COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
    -u "${CLICKHOUSE_USER:-default}" \
    --password "${CLICKHOUSE_PASSWORD:-password}" \
    -q "SELECT count() FROM logrider.log_tags FORMAT TSV" | tr -d '[:space:]')

  echo "  classified=$TAG_COUNT/$EXPECTED_TAG_TOTAL"

  if [ "$TAG_COUNT" -ge "$EXPECTED_TAG_TOTAL" ]; then
    echo "PASS: $EXPECTED logs classified"
    exit 0
  fi
  
  if [ "$i" -eq 120 ]; then
    echo "FAIL: logs persisted but classification did not complete"
    exit 1
  fi
  sleep 1
done
