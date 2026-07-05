#!/usr/bin/env bash
# Run from any directory — changes to script directory first
cd "$(dirname "$0")/.."

REDPANDA="docker compose exec redpanda"

echo "Creating and configuring redpanda topics..."
$REDPANDA rpk topic create logs-ingested       -p 64 2>/dev/null || true
$REDPANDA rpk topic add-partitions logs-ingested -n 64 2>/dev/null || true

$REDPANDA rpk topic create logs-ingested  -p 1  2>/dev/null || true
$REDPANDA rpk topic create logs-persist   -p 1  2>/dev/null || true
$REDPANDA rpk topic create logs-normalized -p 1  2>/dev/null || true
$REDPANDA rpk topic create logs-classified    -p 1  2>/dev/null || true
$REDPANDA rpk topic create ws-events      -p 1  2>/dev/null || true
$REDPANDA rpk topic create alerts-ingested     -p 1  2>/dev/null || true
$REDPANDA rpk topic create alerts-state   -p 1  2>/dev/null || true
$REDPANDA rpk topic create dlq-logs       -p 1  2>/dev/null || true
$REDPANDA rpk topic create dlq-clickhouse -p 1  2>/dev/null || true

echo "Done."
