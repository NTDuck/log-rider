#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

exec "$DIR/run.sh" \
  --protocol "${EXAMPLE_STANDARD_PROTOCOL}" \
  --logs "${EXAMPLE_STANDARD_LOGS}" \
  --duration "${EXAMPLE_STANDARD_DURATION}" \
  --levels "${EXAMPLE_STANDARD_LEVELS}" \
  --batch-size "${EXAMPLE_STANDARD_BATCH_SIZE}" \
  --seed "${EXAMPLE_STANDARD_SEED}" \
  --wait \
  --report
