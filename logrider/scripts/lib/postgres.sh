postgres_migrate() {
  local migrations_dir="$1"
  echo "Running Postgres migrations from $migrations_dir..."
  for sql_file in "$migrations_dir"/*.sql; do
    if [ -f "$sql_file" ]; then
      echo "Applying $sql_file..."
      compose exec -T postgres psql -U "${POSTGRES_USER}" -d logrider -f - < "$sql_file"
    fi
  done
}
