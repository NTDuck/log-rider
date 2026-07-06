#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

X_COUNT=100
Y_COUNT=150
Z_COUNT=250
EXPECTED=$((X_COUNT + Y_COUNT + Z_COUNT))

echo "Running alert test: $X_COUNT X logs, $Y_COUNT Y logs, $Z_COUNT Z logs; all ERROR/CRITICAL..."
echo "Each app will reuse exactly one message so alert dedup groups by app + message."

BEFORE_COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
  -u "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-password}" \
  -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV" | tr -d '[:space:]')
EXPECTED_TOTAL=$((BEFORE_COUNT + EXPECTED))

PAYLOAD=$(PROJECT_DIR="$PROJECT_DIR" X_COUNT="$X_COUNT" Y_COUNT="$Y_COUNT" Z_COUNT="$Z_COUNT" python3 - <<'PY'
import json, os, uuid, random, datetime, csv

csv_path = os.path.join(os.environ["PROJECT_DIR"], "data", "Linux_2k.log_structured.csv")
with open(csv_path, "r") as f:
    rows = list(csv.DictReader(f))

counts = {
    "X": int(os.environ["X_COUNT"]),
    "Y": int(os.environ["Y_COUNT"]),
    "Z": int(os.environ["Z_COUNT"]),
}

levels = ["CRITICAL"]
# levels = ["ERROR", "CRITICAL"]

# Pick one stable message per app.
# This makes all X logs dedup together, all Y logs dedup together,
# and all Z logs dedup together, because dedup key is app name + message hash.
unique_messages = list(dict.fromkeys(row["Content"] for row in rows if row.get("Content")))

if len(unique_messages) < 3:
    raise RuntimeError("Need at least 3 unique messages in Linux_2k.log_structured.csv")

messages = {
    "X": unique_messages[0],
    "Y": unique_messages[1],
    "Z": unique_messages[2],
}

records = []

for app_name, count in counts.items():
    fixed_message = messages[app_name]

    for _ in range(count):
        records.append({
            "Application_Name": app_name,
            "Log_Level": random.choice(levels),
            "Message": fixed_message,
            "Timestamp": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "Trace_ID": str(uuid.uuid4()),
        })

random.shuffle(records)

print(json.dumps({"records": records}))
PY
)

curl -fsS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-LogRider-Ingest-Key: logrider-ingest-key" \
  --data-binary "$PAYLOAD" \
  http://localhost:8085/v1/logs >/tmp/logrider-ingest-response.json

echo "Payload sent to ingest. Waiting for alerts to persist (expected total: $EXPECTED_TOTAL)..."

for i in $(seq 1 90); do
  COUNT=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client \
    -u "${CLICKHOUSE_USER:-default}" \
    --password "${CLICKHOUSE_PASSWORD:-password}" \
    -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV" | tr -d '[:space:]')

  echo "  persisted=$COUNT/$EXPECTED_TOTAL"

  if [ "$COUNT" -ge "$EXPECTED_TOTAL" ]; then
    echo "PASS: $EXPECTED logs persisted"
    echo "      X=$X_COUNT, Y=$Y_COUNT, Z=$Z_COUNT"
    echo "      Expected dedup groups: 3 incidents, one per app/message pair"
    exit 0
  fi

  if [ "$i" -eq 90 ]; then
    echo "FAIL: expected $EXPECTED_TOTAL persisted logs"
    exit 1
  fi

  sleep 1
done
