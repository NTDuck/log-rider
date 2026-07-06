clickhouse_migrate() {
  local migrations_dir="$1"
  echo "Running ClickHouse migrations from $migrations_dir..."
  for sql_file in "$migrations_dir"/*.sql; do
    if [ -f "$sql_file" ]; then
      echo "Applying $sql_file..."
      compose exec -T clickhouse clickhouse-client -u "${CLICKHOUSE_USER}" --password "${CLICKHOUSE_PASSWORD}" --query="$(cat "$sql_file")"
    fi
  done
}
