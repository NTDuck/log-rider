#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

EXPECTED=5
echo "Running simple test: $EXPECTED logs using realistic data..."

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

curl -sS -X POST http://localhost:8085/v1/logs -H 'Content-Type: application/json' -H 'X-LogRider-Ingest-Key: logrider-ingest-key' -d "$PAYLOAD"
echo "Test complete."
