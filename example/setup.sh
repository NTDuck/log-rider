#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "Missing .env file. Copying from .env.example..."
  cp .env.example .env
fi

# Ensure LOGRIDER_ENABLE_DEMO is true
sed -i 's/LOGRIDER_ENABLE_DEMO=false/LOGRIDER_ENABLE_DEMO=true/g' .env

echo "Setting up infrastructure..."
./scripts/setup.sh

# The above will bring up docker-compose and create topics.

echo "Waiting for services to be ready..."
sleep 10

echo "Demo environment setup complete!"
echo "You can now run benchmarks using ./example/run-standard.sh or ./example/run-alerts.sh"
