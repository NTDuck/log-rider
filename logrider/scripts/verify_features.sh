#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
SCRIPT_DIR=$(pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

echo "Verifying core LogRider features..."

FAIL=0
TMP_DIR=$(mktemp -d)
EVENT_LOG="$TMP_DIR/redis-events.log"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "- Checking Web Server Login"
TOKEN=$(docker compose -f "$COMPOSE_FILE" exec -T web-server sh -lc "wget -qO- --header='Content-Type: application/json' --post-data='{\"username\":\"eng1\",\"password\":\"eng123\"}' http://127.0.0.1:\${SERVER_PORT:-3000}/login" | sed -n 's/.*\"token\":\"\\([^\"]*\\)\".*/\\1/p')
if [ -z "$TOKEN" ]; then
    echo "  [FAIL] Web Server login failed for eng1"
    FAIL=1
else
    echo "  [PASS] Web Server login successful"

    echo "- Checking Historical Logs API"
    HTTP_CODE=$(docker compose -f "$COMPOSE_FILE" exec -T web-server sh -lc "wget -S -O /dev/null --header='Authorization: Bearer $TOKEN' http://127.0.0.1:\${SERVER_PORT:-3000}/api/logs/recent 2>&1 | sed -n 's/  HTTP\\/1.1 \\([0-9][0-9][0-9]\\).*/\\1/p' | tail -n 1")
    if [ "$HTTP_CODE" != "200" ]; then
        echo "  [FAIL] /api/logs/recent failed with HTTP ${HTTP_CODE:-unknown}"
        FAIL=1
    else
        echo "  [PASS] /api/logs/recent is working"
    fi
fi

echo "- Checking Metrics Page"
HTTP_CODE=$(docker compose -f "$COMPOSE_FILE" exec -T web-server sh -lc "wget -S -O /dev/null http://127.0.0.1:\${SERVER_PORT:-3000}/metrics 2>&1 | sed -n 's/  HTTP\\/1.1 \\([0-9][0-9][0-9]\\).*/\\1/p' | tail -n 1")
if [ "$HTTP_CODE" != "200" ]; then
    echo "  [FAIL] /metrics failed with HTTP ${HTTP_CODE:-unknown}"
    FAIL=1
else
    echo "  [PASS] /metrics is working"
fi

echo "- Checking Redis pub/sub alert and classification events"
timeout 12 docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli SUBSCRIBE alerts-stream ws-events > "$EVENT_LOG" &
SUB_PID=$!
sleep 2

docker compose -f "$COMPOSE_FILE" exec -T redpanda bash -lc '
  alert_trace=$(cat /proc/sys/kernel/random/uuid)
  info_trace=$(cat /proc/sys/kernel/random/uuid)
  curl -sS -X POST http://localhost:8082/topics/logs-ingested \
    -H "Content-Type: application/vnd.kafka.json.v2+json" \
    -d "{\"records\":[
      {\"value\":{\"Application_Name\":\"test-app\",\"Log_Level\":\"ERROR\",\"Message\":\"test error\",\"Timestamp\":\"2026-07-05T00:00:00Z\",\"Trace_ID\":\"${alert_trace}\"}},
      {\"value\":{\"Application_Name\":\"test-app\",\"Log_Level\":\"INFO\",\"Message\":\"test message\",\"Timestamp\":\"2026-07-05T00:00:01Z\",\"Trace_ID\":\"${info_trace}\"}}
    ]}"
' >/dev/null

wait "$SUB_PID" || true

if grep -q '"type":"ALERT"' "$EVENT_LOG"; then
    echo "  [PASS] Alert path published to alerts-stream"
else
    echo "  [FAIL] Alert path did not publish to alerts-stream"
    FAIL=1
fi

if grep -q '"type":"TAGS"' "$EVENT_LOG"; then
    echo "  [PASS] Classifier published TAGS to ws-events"
else
    echo "  [FAIL] Classifier did not publish TAGS to ws-events"
    FAIL=1
fi

if grep -q '"status":"Persisted"' "$EVENT_LOG"; then
    echo "  [PASS] Persist pipeline published Persisted status"
else
    echo "  [FAIL] Persist pipeline did not publish Persisted status"
    FAIL=1
fi

if [ $FAIL -eq 0 ]; then
    echo "All features verified successfully."
else
    echo "Some features failed verification. See output above."
    exit 1
fi
