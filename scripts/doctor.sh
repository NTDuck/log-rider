#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source scripts/lib/env.sh
source scripts/lib/compose.sh

load_env ".env"

echo "Running Doctor checks..."

# Check Docker Compose services
echo -n "Checking Docker Compose services... "
if ! compose ps | grep -q "Exit"; then
  echo "OK"
else
  echo "FAIL"
  exit 1
fi

# Check Web health
echo -n "Checking Web health endpoint... "
if curl -s "http://localhost:${WEB_PORT}/health" | grep -q "ok"; then
  echo "OK"
else
  echo "FAIL"
  exit 1
fi

# Check Ingest health
echo -n "Checking Ingest health endpoint... "
if curl -s "http://localhost:${INGEST_HTTP_PORT}/health" | grep -q "ok"; then
  echo "OK"
else
  echo "FAIL"
  exit 1
fi

# Check for hardcoded demo credentials
if [ "${LOGRIDER_ENABLE_DEMO:-false}" != "true" ]; then
  if compose logs web | grep -q "Demo accounts"; then
    echo "FAIL: Demo credentials exposed in non-demo mode"
    exit 1
  fi
fi

# Check missing env variables in logs
if compose logs | grep -qi "missing required environment variable"; then
  echo "FAIL: Services reported missing environment variables"
  exit 1
fi

echo "All checks passed!"
