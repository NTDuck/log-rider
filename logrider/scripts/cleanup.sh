#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

# ClickHouse credentials — read from environment or fall back to defaults
CH_USER="${CLICKHOUSE_USER:-default}"
CH_PASS="${CLICKHOUSE_PASSWORD:-password}"

echo "Cleanup started. Redpanda topics were intentionally not deleted."

# Helper to print row count and sample rows before truncating a table
print_and_truncate() {
  local table=$1
  echo "Table: $table"

  # Extract database and table name
  local db=${table%%.*}
  local tbl=${table##*.}

  # Check if the table exists in ClickHouse
  local exists
  exists=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -u "${CH_USER}" --password "${CH_PASS}" -q "SELECT count() FROM system.tables WHERE database='$db' AND name='$tbl' FORMAT TSV")
  if [[ "$exists" != "1" ]]; then
    return
  fi

  # Show current row count
  local count
  count=$(docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -u "${CH_USER}" --password "${CH_PASS}" -q "SELECT count() FROM $table FORMAT TSV")
  echo "  Rows before truncate: $count"

  # Show up to 5 sample rows if any
  if [[ "$count" -gt 0 ]]; then
    echo "  Sample rows (up to 5):"
    docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -u "${CH_USER}" --password "${CH_PASS}" -q "SELECT * FROM $table LIMIT 5 FORMAT TSV" | sed 's/^/    /'
  fi

  # Truncate the table
  docker compose -f "$COMPOSE_FILE" exec -T clickhouse clickhouse-client -u "${CH_USER}" --password "${CH_PASS}" -q "TRUNCATE TABLE IF EXISTS $table"
  echo "  Truncate completed."
  echo
}

echo "Clearing ClickHouse tables..."

tables=(
  "logrider.logs_enriched"
  "logrider.logs"
  "logrider.log_tags"
  "logrider.hourly_health_mv"
)

for tbl in "${tables[@]}"; do
  print_and_truncate "$tbl"
done

echo "All specified tables have been cleared."

# Flush Redis via the Docker Compose redis service (works in any environment)
echo "Cleaning up Redis (test data only)..."
if docker compose -f "$COMPOSE_FILE" exec -T redis sh -c "redis-cli --scan --pattern 'incident:*' | xargs -r redis-cli DEL && redis-cli DEL notifications:data notifications:index telegram:dirty_incidents" > /dev/null 2>&1; then
  echo "Redis test data flushed (sessions preserved)."
else
  echo "Could not flush Redis via docker compose exec. Is the stack running?"
fi

echo "Restarting Benthos to drop bad buffered messages..."
docker compose -f "$COMPOSE_FILE" restart benthos-pipeline benthos-persist benthos-tags
