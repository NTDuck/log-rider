#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Running standard load test with k6 (exactly 500 logs in 2 seconds)..."
echo "Clearing old ClickHouse data..."
docker compose -f ../docker-compose.yml exec -T clickhouse clickhouse-client -u default --password password -q "TRUNCATE TABLE IF EXISTS logrider.logs_enriched"
docker compose -f ../docker-compose.yml exec -T clickhouse clickhouse-client -u default --password password -q "TRUNCATE TABLE IF EXISTS logrider.logs"
docker compose -f ../docker-compose.yml exec -T clickhouse clickhouse-client -u default --password password -q "TRUNCATE TABLE IF EXISTS logrider.log_tags"

# Using k6 run to fire 250 requests/sec for 2 seconds = exactly 500 requests
# 2 * 250 = 500 logs in 2 seconds.
docker run --rm --network host -i -e RATE=250 -e DURATION=2s grafana/k6 run - < k6-load.js

echo "Waiting for pipeline flush..."
MAX_WAIT=60
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    COUNT=$(docker compose -f ../docker-compose.yml exec -T clickhouse clickhouse-client -u default --password password -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
    if [ "$COUNT" -ge 500 ]; then
        break
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

echo "Verifying ClickHouse entries..."
COUNT=$(docker compose -f ../docker-compose.yml exec -T clickhouse clickhouse-client -u default --password password -q "SELECT count() FROM logrider.logs_enriched FORMAT TSV")
echo "Total logs in ClickHouse: $COUNT"
