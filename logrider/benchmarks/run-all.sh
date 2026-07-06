#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for scenario in benchmarks/scenarios/*.env; do
  name=$(basename "$scenario" .env)
  ./benchmarks/run.sh "$name"
done
