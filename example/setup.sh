#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source scripts/lib/env.sh
source scripts/lib/compose.sh

load_env ".env"

if [ "${LOGRIDER_ENABLE_DEMO:-false}" != "true" ]; then
  echo "Error: LOGRIDER_ENABLE_DEMO must be true in .env" >&2
  exit 1
fi

echo "Setting up demo environment..."

# Wait for DBs
compose exec -T postgres pg_isready -U "${POSTGRES_USER}" -d logrider &>/dev/null

# Create demo users from env (placeholder, we will use a real SQL insert script or api endpoint)
echo "Inserting demo users into Postgres..."

cat <<EOF > example/.state/demo_users.sql
INSERT INTO users (username, password_hash, role) VALUES
  ('${DEMO_ADMIN_USERNAME}', crypt('${DEMO_ADMIN_PASSWORD}', gen_salt('bf', 10)), 'admin'),
  ('${DEMO_ENGINEER_1_USERNAME}', crypt('${DEMO_ENGINEER_1_PASSWORD}', gen_salt('bf', 10)), 'engineer'),
  ('${DEMO_ENGINEER_2_USERNAME}', crypt('${DEMO_ENGINEER_2_PASSWORD}', gen_salt('bf', 10)), 'engineer')
ON CONFLICT DO NOTHING;
EOF

compose exec -T postgres psql -U "${POSTGRES_USER}" -d logrider -f - < example/.state/demo_users.sql

echo "Demo setup complete."
