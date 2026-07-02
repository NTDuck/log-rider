#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Running standard load test (500 logs) with k6..."
k6 run -e VUS=10 -e ITERATIONS=500 -e BATCH_SIZE=1 k6-load.js

echo "Waiting 3 seconds for pipeline flush..."
sleep 3

echo "Verifying ClickHouse entries..."
COUNT=$(curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "SELECT count() FROM logrider.logs FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
