#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Running EXTREME load test (1M logs) with k6..."
# To send 1M logs, we use a batch size of 1000 logs per request.
# 1000 logs/req * 1000 requests = 1,000,000 logs
# We use 10 VUs and 20 iterations per VU = 200 requests total
# This should complete very quickly without breaking the 1MB TCP payload limits.
k6 run -e VUS=10 -e ITERATIONS=20 -e BATCH_SIZE=5000 k6-load.js

echo "Waiting 5 seconds for pipeline flush..."
sleep 5

echo "Verifying ClickHouse entries..."
COUNT=$(curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "SELECT count() FROM logrider.logs FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
