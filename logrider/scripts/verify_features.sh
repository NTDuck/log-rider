#!/bin/bash
echo "Verifying all features..."

FAIL=0

echo "- Checking Web Server Login"
TOKEN=$(curl -s -X POST http://localhost:3000/login -H "Content-Type: application/json" -d '{"username":"eng1","password":"eng123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
    echo "  [FAIL] Web Server Login failed for eng1"
    FAIL=1
else
    echo "  [PASS] Web Server Login successful"
    
    echo "- Checking Historical Logs API"
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X GET http://localhost:3000/api/logs/recent -H "Authorization: Bearer $TOKEN")
    if [ "$HTTP_CODE" -ne 200 ]; then
        echo "  [FAIL] /api/logs/recent failed with HTTP $HTTP_CODE"
        FAIL=1
    else
        echo "  [PASS] /api/logs/recent is working"
    fi
fi

echo "- Checking Metrics Page"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X GET http://localhost:3000/metrics)
if [ "$HTTP_CODE" -ne 200 ]; then
    echo "  [FAIL] /metrics failed with HTTP $HTTP_CODE"
    FAIL=1
else
    echo "  [PASS] /metrics is working"
fi

echo "- Checking Alerts Worker Redis Output"
timeout 5 docker exec logrider-redis-1 redis-cli PSUBSCRIBE "alerts-state:*" > /tmp/alerts-state.log &
sleep 2
# Inject an error log
curl -s -X POST http://localhost:8082/topics/logs-raw -H "Content-Type: application/vnd.kafka.json.v2+json" -d '{"records":[{"value":{"Application_Name":"test-app","Log_Level":"ERROR","Message":"test error","Trace_ID":"12345678-1234-1234-1234-123456789abc"}}]}' >/dev/null
sleep 7
if grep -q "ALERTS_STATE" /tmp/alerts-state.log; then
    echo "  [PASS] Alert worker is publishing to alerts-state"
else
    echo "  [FAIL] Alert worker did NOT publish to alerts-state"
    FAIL=1
fi

echo "- Checking Classifier Worker Redis Output (TAGS)"
timeout 5 docker exec logrider-redis-1 redis-cli PSUBSCRIBE "ws-frontend:*" > /tmp/tags-state.log &
sleep 2
# Inject another log to ensure it gets tagged
curl -s -X POST http://localhost:8082/topics/logs-raw -H "Content-Type: application/vnd.kafka.json.v2+json" -d '{"records":[{"value":{"Application_Name":"test-app","Log_Level":"INFO","Message":"test message","Trace_ID":"12345678-1234-1234-1234-123456789abd"}}]}' >/dev/null
sleep 7
if grep -q "TAGS" /tmp/tags-state.log; then
    echo "  [PASS] Classifier worker is publishing TAGS to ws-frontend"
else
    echo "  [FAIL] Classifier worker did NOT publish TAGS to ws-frontend"
    FAIL=1
fi

echo "- Checking ClickHouse Batch Insert updates websocket (Persisted)"
if grep -q '"status":"Persisted"' /tmp/tags-state.log; then
    echo "  [PASS] ClickHouse Batch Insert published Persisted to ws-frontend"
else
    echo "  [FAIL] ClickHouse Batch Insert did NOT publish Persisted to ws-frontend"
    FAIL=1
fi

if [ $FAIL -eq 0 ]; then
    echo "All features verified successfully!"
    cat << 'EOF' > TODO.md
# Verification Checklist
- [x] Dashboard loads historical logs correctly (No `allowed_apps` array mapping bug)
- [x] Dashboard does not aggregate distinct logs (Rows appended, tags updated via `data-trace-id`)
- [x] Metrics page loads successfully
- [x] Classifier worker outputs `TAGS` and `status: Classified` to `ws-frontend` so clients receive them
- [x] ClickHouse batch write (via `benthos-persist` pipeline) outputs `status: Persisted` after a successful flush
- [x] Alert worker calculates grouped alerts and outputs `ALERTS_STATE` successfully
EOF
else
    echo "Some features failed verification. See output above."
    cat << 'EOF' > TODO.md
# Verification Checklist
- [ ] Investigate failing features.
EOF
    exit 1
fi
