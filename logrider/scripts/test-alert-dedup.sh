#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

echo "Running alert dedup test..."

# Ensure we're clean
"$SCRIPT_DIR/cleanup.sh"

echo "Ingesting 10000 identical ERROR logs..."

PAYLOAD_FILE="/tmp/logrider_dedup_payload.json"
python3 - > "$PAYLOAD_FILE" <<'PY'
import json, datetime
import urllib.request
import os

records = []
for i in range(10000):
    records.append({
        "Application_Name": "benchmark-alert-app",
        "Log_Level": "ERROR",
        "Message": "repeated benchmark database timeout",
        "Timestamp": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "Trace_ID": f"trace-dedup-{i}"
    })

for i in range(0, 10000, 2000):
    batch = records[i:i+2000]
    payload = json.dumps({"records": batch}).encode("utf-8")
    req = urllib.request.Request("http://localhost:8085/v1/logs", data=payload, headers={
        "Content-Type": "application/json",
        "X-LogRider-Ingest-Key": "logrider-ingest-key"
    }, method="POST")
    with urllib.request.urlopen(req) as response:
        response.read()
PY

echo "Waiting for pipeline to process..."
sleep 15

# Assert count in Redis
INCIDENT_KEY=$(docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli --scan --pattern 'incident:benchmark-alert-app:*' | head -n 1 | tr -d '\r')

if [ -z "$INCIDENT_KEY" ]; then
  echo "FAIL: No incident found in Redis."
  exit 1
fi

COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli HGET "$INCIDENT_KEY" count | tr -d '\r')
echo "Count is $COUNT"
if [ "$COUNT" -lt 9000 ]; then
  echo "FAIL: Expected count around 10000, got $COUNT"
  exit 1
fi

echo "PASS: Dedup count is $COUNT (>= 9000)"

exit 0
