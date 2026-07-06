wait_for_redpanda() {
  echo "Waiting for Redpanda..."
  until compose exec -T redpanda rpk cluster health --exit-when-healthy &>/dev/null; do
    sleep 2
  done
  echo "Redpanda ready."
}

wait_for_redis() {
  echo "Waiting for Redis..."
  until compose exec -T redis redis-cli ping &>/dev/null; do
    sleep 2
  done
  echo "Redis ready."
}

wait_for_clickhouse() {
  echo "Waiting for ClickHouse..."
  until compose exec -T clickhouse wget --spider -q http://localhost:8123/ping &>/dev/null; do
    sleep 2
  done
  echo "ClickHouse ready."
}

wait_for_postgres() {
  echo "Waiting for Postgres..."
  until compose exec -T postgres pg_isready -U "${POSTGRES_USER}" -d logrider &>/dev/null; do
    sleep 2
  done
  echo "Postgres ready."
}
