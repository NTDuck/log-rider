#!/usr/bin/env bash
ch_query() {
  docker compose exec -T clickhouse clickhouse-client -u "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-password}" -q "$1"
}
ch_count_table() {
  ch_query "SELECT count() FROM $1"
}
ch_truncate_table() {
  ch_query "TRUNCATE TABLE IF EXISTS $1"
}
ch_wait_for_count() {
  local table=$1
  local expected=$2
  local timeout=$3
  local elapsed=0
  local current=0
  
  echo "timestamp,elapsed_ms,logs_enriched_count"
  
  while [ $elapsed -lt $timeout ]; do
    current=$(ch_count_table "$table" | tr -d '[:space:]')
    echo "$(date +%s%3N),$((elapsed*1000)),$current"
    if [ "$current" -ge "$expected" ]; then
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}
