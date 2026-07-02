#!/usr/bin/env bash

ENDPOINT="http://localhost:3000/api/logs"

echo "Generating 500 requests with python..."
cat << 'EOF' > generate_logs.py
import urllib.request
import json
import uuid
import datetime
import random
import concurrent.futures

APPS = ["payment", "auth", "load-test-app", "inventory", "billing"]
LEVELS = ["INFO", "DEBUG", "WARN", "ERROR"]

def send_log(i):
    app = random.choice(APPS)
    level = random.choice(LEVELS)
    msg = f"Message {i}"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    trace_id = str(uuid.uuid4())
    
    payload = {
        "Application_Name": app,
        "Log_Level": level,
        "Message": msg,
        "Timestamp": now,
        "Trace_ID": trace_id
    }
    
    req = urllib.request.Request("http://localhost:3000/api/logs", data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req)
    except Exception as e:
        pass

with concurrent.futures.ThreadPoolExecutor(max_workers=50) as executor:
    executor.map(send_log, range(1, 501))

EOF

python3 generate_logs.py
rm generate_logs.py

echo "500 requests sent."
echo "Waiting 3 seconds for pipeline flush..."
sleep 3

echo "Verifying ClickHouse entries..."
COUNT=$(curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "SELECT count() FROM logrider.logs FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
