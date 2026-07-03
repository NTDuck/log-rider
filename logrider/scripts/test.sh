#!/usr/bin/env bash
export NIXPKGS_ALLOW_UNFREE=1
cd "$(dirname "$0")"

echo "Running standard load test with k6 (exactly 500 logs in 2 seconds)..."
# RATE=250 req/s for 2s = 500 requests. Each request has 1 log.
# 2 * 250 = 500 logs in 2 seconds.
nix-shell ../../shell.nix --run "k6 run -e RATE=250 -e DURATION=2s k6-load.js"

echo "Waiting 3 seconds for pipeline flush..."
sleep 3

echo "Verifying ClickHouse entries..."
COUNT=$(curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
