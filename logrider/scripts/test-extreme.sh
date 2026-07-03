#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Running extreme load test with k6 (1,000,000 logs in 1 second)..."
nix-shell ../../shell.nix --run "k6 run -e RATE=100 -e DURATION=1s -e BATCH_SIZE=10000 k6-load.js"

echo "Waiting 5 seconds for pipeline flush..."
sleep 5

echo "Verifying ClickHouse entries..."
COUNT=$(curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
