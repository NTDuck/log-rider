#!/usr/bin/env bash
ENDPOINT="http://localhost:3000/api/logs"

echo "Sending 500 CRITICAL error logs for payment app..."
export ENDPOINT
seq 1 500 | xargs -P 50 -I {} bash -c 'curl -s -X POST -H "Content-Type: application/json" -d "{\"Application_Name\":\"payment\",\"Log_Level\":\"CRITICAL\",\"Message\":\"Payment crashed!\",\"Timestamp\":\"2026-07-02T10:00:00Z\",\"Trace_ID\":\"12345678-1234-1234-1234-123456789012\"}" $ENDPOINT >/dev/null'

echo "Test complete."
