#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source scripts/lib/env.sh
source scripts/lib/compose.sh

load_env ".env"

if [ "${LOGRIDER_ENABLE_DEMO:-false}" != "true" ]; then
  echo "Error: LOGRIDER_ENABLE_DEMO must be true for example teardown." >&2
  exit 1
fi

STATE_FILE="example/.state/resources.env"

if [ ! -f "$STATE_FILE" ]; then
  echo "No example state file found at $STATE_FILE."
  echo "Nothing to teardown."
  exit 0
fi

source "$STATE_FILE"

echo "Tearing down demo/example resources..."

if [ -n "${DEMO_USERS:-}" ]; then
  for username in $DEMO_USERS; do
    echo "Deleting demo user: $username"
    compose exec -T postgres psql \
      -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DATABASE}" \
      -v ON_ERROR_STOP=1 \
      -c "DELETE FROM users WHERE username = '${username//\'/\'\'}';"
  done
fi

if [ -n "${REDIS_KEY_PREFIX_SESSION:-}" ]; then
  echo "Preserving sessions by default."
fi

rm -rf example/.state example/.generated example/results

echo "Example teardown complete."
