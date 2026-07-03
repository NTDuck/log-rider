#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Clearing ClickHouse tables..."

curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "TRUNCATE TABLE IF EXISTS logrider.logs_enriched;"
curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "TRUNCATE TABLE IF EXISTS logrider.logs;"
curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "TRUNCATE TABLE IF EXISTS logrider.log_tags;"
curl -s -X POST "http://localhost:8123/?user=default&password=password" -d "TRUNCATE TABLE IF EXISTS logrider.hourly_health_mv;"

echo "Done!"
