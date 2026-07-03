#!/usr/bin/env bash
export NIXPKGS_ALLOW_UNFREE=1
cd "$(dirname "$0")"

echo "Running standard load test with k6 (exactly 500 logs in 2 seconds)..."
echo "Clearing old ClickHouse data..."
curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "TRUNCATE TABLE IF EXISTS logrider.logs_enriched"
curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "TRUNCATE TABLE IF EXISTS logrider.logs"
curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "TRUNCATE TABLE IF EXISTS logrider.log_tags"

# Using k6 run to fire 250 requests/sec for 2 seconds = exactly 500 requests
# 2 * 250 = 500 logs in 2 seconds.
nix-shell ../../shell.nix --run "k6 run -e RATE=250 -e DURATION=2s k6-load.js"

echo "Waiting for pipeline flush..."
MAX_WAIT=60
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    COUNT=$(curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
    if [ "$COUNT" -ge 500 ]; then
        break
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

echo "Verifying ClickHouse entries..."
COUNT=$(curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
