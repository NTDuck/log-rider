#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

echo "Running alert persist test..."

# Ensure we're clean
"$SCRIPT_DIR/cleanup.sh"

echo "Ingesting 5000 logs..."

PAYLOAD_FILE="/tmp/logrider_persist_payload.json"
PROJECT_DIR="$PROJECT_DIR" EXPECTED="5000" python3 - > "$PAYLOAD_FILE" <<'PY'
import json, os, uuid, random, datetime, csv
import urllib.request

csv_path = os.path.join(os.environ["PROJECT_DIR"], "data", "Linux_2k.log_structured.csv")
with open(csv_path, "r") as f:
    rows = list(csv.DictReader(f))

def map_level(content):
    content_lower = content.lower()
    if "critical" in content_lower or "fatal" in content_lower:
        return "CRITICAL"
    if "error" in content_lower or "fail" in content_lower or "denied" in content_lower:
        return "ERROR"
    if "warn" in content_lower:
        return "WARN"
    return "INFO"

n = int(os.environ["EXPECTED"])
records = []
for i in range(n):
    row = rows[i % len(rows)]
    records.append({
        "Application_Name": row["Component"],
        "Log_Level": map_level(row["Content"]),
        "Message": row["Content"],
        "Timestamp": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "Trace_ID": f"trace-persist-{i}",
    })

for i in range(0, n, 2000):
    batch = records[i:i+2000]
    payload = json.dumps({"records": batch}).encode("utf-8")
    req = urllib.request.Request("http://localhost:8085/v1/logs", data=payload, headers={
        "Content-Type": "application/json",
        "X-LogRider-Ingest-Key": "logrider-ingest-key"
    }, method="POST")
    with urllib.request.urlopen(req) as response:
        response.read()
PY

echo "Waiting for pipeline to persist..."
EXPECTED_TOTAL=5000

for i in $(seq 1 90); do
  COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
    -u "${CLICKHOUSE_USER:-default}" \
    --password "${CLICKHOUSE_PASSWORD:-password}" \
    -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV" | tr -d '[:space:]')

  echo "  persisted=$COUNT/$EXPECTED_TOTAL"

  if [ "$COUNT" -ge "$EXPECTED_TOTAL" ]; then
    echo "PASS: $EXPECTED_TOTAL logs persisted"
    exit 0
  fi

  sleep 1
done

echo "FAIL: expected $EXPECTED_TOTAL persisted logs, got $COUNT"
exit 1
