#!/usr/bin/env bash
ENDPOINT="http://localhost:8082/topics/logs-raw"

echo "Sending 500 CRITICAL error logs for banana-service app..."
export ENDPOINT
seq 1 500 | xargs -P 50 -I {} bash -c 'curl -s -X POST -H "Content-Type: application/vnd.kafka.json.v2+json" -d "{\"records\": [{\"value\": {\"Application_Name\":\"banana-service\",\"Log_Level\":\"CRITICAL\",\"Message\":\"Payment crashed!\",\"Timestamp\":\"2026-07-02T10:00:00Z\",\"Trace_ID\":\"$(uuidgen)\"}}]}" $ENDPOINT >/dev/null'

echo "Test complete."
