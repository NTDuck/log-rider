#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
records=()
records+=("{\"value\":{\"Application_Name\":\"sshd(pam_unix)\",\"Log_Level\":\"INFO\",\"Message\":\"authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=218.188.2.4\",\"Timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")\",\"Trace_ID\":\"19939\"}}")
records+=("{\"value\":{\"Application_Name\":\"sshd(pam_unix)\",\"Log_Level\":\"INFO\",\"Message\":\"check pass; user unknown\",\"Timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")\",\"Trace_ID\":\"19937\"}}")
records+=("{\"value\":{\"Application_Name\":\"sshd(pam_unix)\",\"Log_Level\":\"INFO\",\"Message\":\"authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=218.188.2.4\",\"Timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")\",\"Trace_ID\":\"19937\"}}")
records+=("{\"value\":{\"Application_Name\":\"sshd(pam_unix)\",\"Log_Level\":\"INFO\",\"Message\":\"authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=220-135-151-1.hinet-ip.hinet.net  user=root\",\"Timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")\",\"Trace_ID\":\"20882\"}}")
records+=("{\"value\":{\"Application_Name\":\"sshd(pam_unix)\",\"Log_Level\":\"INFO\",\"Message\":\"authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=220-135-151-1.hinet-ip.hinet.net  user=root\",\"Timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")\",\"Trace_ID\":\"20884\"}}")

payload=$(printf '{"records":[%s]}' "$(IFS=,; echo "${records[*]}")")
docker compose -f "$COMPOSE_FILE" exec -e PAYLOAD="$payload" -T redpanda bash -lc "
  curl -sS -X POST http://localhost:8082/topics/logs-ingested -H 'Content-Type: application/vnd.kafka.json.v2+json' -d \"\$PAYLOAD\"
"
echo "Test complete."
