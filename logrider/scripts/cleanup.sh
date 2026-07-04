#!/usr/bin/env bash
cd "$(dirname "$0")"

# Helper to print row count and sample rows before truncating a table
print_and_truncate() {
  local table=$1
  echo "Table: $table"

  # Extract database and table name
  local db=${table%%.*}
  local tbl=${table##*.}

  # Check if the table exists in ClickHouse
  local exists=$(curl -s "http://localhost:8123/?user=default&password=password" \
    -d "SELECT count() FROM system.tables WHERE database='$db' AND name='$tbl'")
  if [[ "$exists" != "1" ]]; then
    return
  fi

  # Show current row count
  local count=$(curl -s "http://localhost:8123/?user=default&password=password" \
    -d "SELECT count() FROM $table")
  echo "  Rows before truncate: $count"

  # Show up to 5 sample rows if any
  if [[ "$count" -gt 0 ]]; then
    echo "  Sample rows (up to 5):"
    curl -s "http://localhost:8123/?user=default&password=password" \
      -d "SELECT * FROM $table LIMIT 5" | sed 's/^/    /'
  fi

  # Truncate the table (if it exists)
  curl -s -X POST "http://localhost:8123/?user=default&password=password" \
    -d "TRUNCATE TABLE IF EXISTS $table;"
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

# Flush Redis data (clear all keys)
echo "Flushing Redis..."
# Use localhost by default; allow override via REDIS_HOST env var
REDIS_HOST=${REDIS_HOST:-localhost}
if ! command -v redis-cli >/dev/null 2>&1; then
  echo "redis-cli not found; cannot flush Redis. Install redis-tools or set REDIS_HOST appropriately."
else
  if redis-cli -h "$REDIS_HOST" -p 6379 PING >/dev/null 2>&1; then
    redis-cli -h "$REDIS_HOST" -p 6379 FLUSHALL && echo "Redis flushed."
  else
    echo "Redis host $REDIS_HOST not reachable; skipping Redis flush."
  fi
fi
