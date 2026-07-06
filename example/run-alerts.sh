#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

exec "$DIR/run.sh" \
  --protocol "${EXAMPLE_ALERT_PROTOCOL}" \
  --logs "${EXAMPLE_ALERT_LOGS}" \
  --duration "${EXAMPLE_ALERT_DURATION}" \
  --levels "${EXAMPLE_ALERT_LEVELS}" \
  --unique-k "${EXAMPLE_ALERT_UNIQUE_K}" \
  --batch-size "${EXAMPLE_ALERT_BATCH_SIZE}" \
  --seed "${EXAMPLE_ALERT_SEED}" \
  --wait \
  --report
