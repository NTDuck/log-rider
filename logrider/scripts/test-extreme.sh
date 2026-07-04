#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Running extreme load test with k6 (1,000,000 logs in 1 second)..."
docker run --rm --network host -i -e RATE=100 -e DURATION=1s -e BATCH_SIZE=10000 grafana/k6 run - < k6-load.js

echo "Waiting 5 seconds for pipeline flush..."
sleep 5

echo "Verifying ClickHouse entries..."
COUNT=$(docker compose -f ../docker-compose.yml exec -T clickhouse clickhouse-client -u default --password password -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
