#!/usr/bin/env bash

ENDPOINT="http://localhost:3000/api/logs"

# Use ab if available, otherwise fallback to curl loop with xargs
if command -v ab >/dev/null 2>&1; then
    echo "Using Apache Bench (ab) for testing..."
    cat << 'EOF' > payload.json
{
  "Application_Name": "load-test-app",
  "Log_Level": "INFO",
  "Message": "This is a load test message",
  "Timestamp": "2026-07-02T10:00:00Z",
  "Trace_ID": "12345678-1234-1234-1234-123456789012"
}
EOF
    ab -n 500 -c 250 -p payload.json -T application/json $ENDPOINT
    rm payload.json
else
    echo "Apache Bench (ab) not found. Using curl with xargs for concurrent requests..."
    export ENDPOINT
    seq 1 500 | xargs -P 250 -I {} bash -c 'curl -s -X POST -H "Content-Type: application/json" -d "{\"Application_Name\":\"load-test-app\",\"Log_Level\":\"INFO\",\"Message\":\"Message {}\",\"Timestamp\":\"2026-07-02T10:00:00Z\",\"Trace_ID\":\"12345678-1234-1234-1234-123456789012\"}" $ENDPOINT >/dev/null'
    echo "500 requests sent."
fi
