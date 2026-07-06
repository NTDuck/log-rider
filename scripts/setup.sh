#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source scripts/lib/env.sh
source scripts/lib/compose.sh
source scripts/lib/wait.sh
source scripts/lib/redpanda.sh
source scripts/lib/clickhouse.sh
source scripts/lib/postgres.sh

load_env ".env"
validate_env_contract "contracts/env.schema"
assert_no_default_secrets

require_cmd docker
require_cmd curl
require_cmd jq

compose pull
compose build

compose up -d redpanda redis clickhouse postgres
wait_for_redpanda
wait_for_redis
wait_for_clickhouse
wait_for_postgres

postgres_migrate infra/postgres/migrations
clickhouse_migrate infra/clickhouse/migrations
redpanda_create_topics_from_env

compose up -d

./scripts/doctor.sh

cat <<'MSG'
Setup complete.

Next:
  ./example/setup.sh
  ./example/run-standard.sh
  open http://localhost:${WEB_PORT}/dashboard
MSG
