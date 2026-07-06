#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# This script would run a k6 docker image using parameters
echo "Running example/run.sh with args: $@"

# Parsing arguments (simplified for length, to be filled)
# In reality, this will execute k6 run using the benchmark runner scripts
