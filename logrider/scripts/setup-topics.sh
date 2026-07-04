#!/usr/bin/env bash
# Run from any directory — changes to script directory first
cd "$(dirname "$0")/.."

REDPANDA="docker compose exec redpanda"

echo "Creating and configuring redpanda topics..."
$REDPANDA rpk topic create logs-raw       -p 64 2>/dev/null || true
$REDPANDA rpk topic add-partitions logs-raw -n 64 2>/dev/null || true

$REDPANDA rpk topic create logs-ingested  -p 1  2>/dev/null || true
$REDPANDA rpk topic create logs-persist   -p 1  2>/dev/null || true
$REDPANDA rpk topic create log-normalized -p 1  2>/dev/null || true
$REDPANDA rpk topic create logs-tagged    -p 1  2>/dev/null || true
$REDPANDA rpk topic create ws-events      -p 1  2>/dev/null || true
$REDPANDA rpk topic create alerts-raw     -p 1  2>/dev/null || true
$REDPANDA rpk topic create alerts-state   -p 1  2>/dev/null || true
$REDPANDA rpk topic create dlq-logs       -p 1  2>/dev/null || true
$REDPANDA rpk topic create dlq-clickhouse -p 1  2>/dev/null || true

echo "Done."
