#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Running alert benchmark: 1000 CRITICAL/ERROR logs in 2 seconds"
./example/run.sh http 500 2s alert-dedup
