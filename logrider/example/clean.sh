#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source scripts/lib/env.sh
source scripts/lib/compose.sh

load_env ".env"

echo "Cleaning up example data..."

# Delete demo users
if [ -f example/.state/demo_users.sql ]; then
  compose exec -T postgres psql -U "${POSTGRES_USER}" -d logrider -c "DELETE FROM users WHERE username IN ('${DEMO_ADMIN_USERNAME}', '${DEMO_ENGINEER_1_USERNAME}', '${DEMO_ENGINEER_2_USERNAME}');"
  rm example/.state/demo_users.sql
fi

# Clean redis incidents/sessions
compose exec -T redis redis-cli keys "${REDIS_KEY_PREFIX_SESSION}:*" | xargs -r compose exec -T redis redis-cli del
compose exec -T redis redis-cli keys "${REDIS_KEY_PREFIX_INCIDENT}:*" | xargs -r compose exec -T redis redis-cli del

# Delete results
rm -rf example/.generated/*
rm -rf benchmarks/results/*

echo "Example cleanup complete."
