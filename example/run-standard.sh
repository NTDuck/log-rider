#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Running standard benchmark: 500 logs in 2 seconds"
./example/run.sh http 250 2s standard
