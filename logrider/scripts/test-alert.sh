#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Sending 500 CRITICAL error logs for banana-service app..."
seq 1 500 | xargs -P 50 -I {} docker compose -f ../docker-compose.yml exec -T redpanda bash -lc '
  trace_id=$(cat /proc/sys/kernel/random/uuid)
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/vnd.kafka.json.v2+json" \
    -d "{\"records\":[{\"value\":{\"Application_Name\":\"banana-service\",\"Log_Level\":\"CRITICAL\",\"Message\":\"Payment crashed!\",\"Timestamp\":\"2026-07-02T10:00:00Z\",\"Trace_ID\":\"${trace_id}\"}}]}" \
    http://localhost:8082/topics/logs-ingested)
  if [ "$status" != "200" ]; then
    echo "Failed to enqueue alert log: HTTP $status" >&2
    exit 1
  fi
'

echo "Test complete."
