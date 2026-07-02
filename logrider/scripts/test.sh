#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Configuring redpanda partitions..."
docker exec logrider-redpanda-1 rpk topic create logs-raw -p 64 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic alter-config logs-raw --set partitions=64 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic add-partitions logs-raw -n 64 2>/dev/null || true

echo "Running standard load test with k6 (constant-arrival-rate)..."
nix-shell ../../shell.nix --run "k6 run -e VUS=10 -e RATE=200 -e DURATION=10s -e BATCH_SIZE=5000 k6-load.js"

echo "Waiting 3 seconds for pipeline flush..."
sleep 3

echo "Verifying ClickHouse entries..."
COUNT=$(curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
