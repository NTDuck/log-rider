#!/usr/bin/env bash

# Sends 5 logs, one for each level via Redpanda REST Proxy
LEVELS=("DEBUG" "INFO" "WARN" "ERROR" "CRITICAL")
APPS=("auth-service" "billing-app" "payment-gateway" "user-profile" "inventory-sys")
MESSAGES=("connection timeout" "successful login" "high latency detected" "database query failed" "system crashed")

RECORDS=""
for i in {0..4}; do
    LEVEL=${LEVELS[$i]}
    APP=${APPS[$i]}
    MSG=${MESSAGES[$i]}
    TRACE=$(cat /proc/sys/kernel/random/uuid)
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    
    RECORD=$(cat <<JSON
{
  "value": {
    "Application_Name": "$APP",
    "Log_Level": "$LEVEL",
    "Message": "$MSG",
    "Timestamp": "$TIMESTAMP",
    "Trace_ID": "$TRACE"
  }
}
JSON
)
    if [ $i -lt 4 ]; then
        RECORDS="$RECORDS $RECORD,"
    else
        RECORDS="$RECORDS $RECORD"
    fi
    echo "Prepared $LEVEL log for $APP"
done

PAYLOAD="{\"records\": [$RECORDS]}"

curl -s -X POST http://localhost:8082/topics/logs-ingested \
    -H "Content-Type: application/vnd.kafka.json.v2+json" \
    -d "$PAYLOAD"

echo ""
echo "Test complete."
