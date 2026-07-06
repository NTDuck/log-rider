#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source scripts/lib/env.sh
source scripts/lib/compose.sh

echo "Warning: This will stop all services and remove ALL local state."
echo "If you just want to clean example data, run ./example/clean.sh instead."
read -p "Are you sure? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  exit 1
fi

compose down -v
rm -rf example/.state/* example/.generated/* benchmarks/results/*
echo "All local state removed."
