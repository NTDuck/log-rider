#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

RPK=(docker compose -f "$COMPOSE_FILE" exec -T redpanda rpk topic)

ensure_topic() {
  local topic=$1
  local partitions=$2

  "${RPK[@]}" create "$topic" -p "$partitions" 2>/dev/null || true
  "${RPK[@]}" add-partitions "$topic" -n "$partitions" 2>/dev/null || true
}

echo "Creating and configuring Redpanda topics..."
ensure_topic logs-ingested 64
ensure_topic logs-normalized 4
ensure_topic logs-persist 4
ensure_topic logs-classified 4
ensure_topic alerts-ingested 10
ensure_topic dlq-logs 1
ensure_topic dlq-clickhouse 1
echo "Done."
