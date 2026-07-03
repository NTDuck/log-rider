#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Creating and configuring redpanda topics..."
docker exec logrider-redpanda-1 rpk topic create logs-raw -p 64 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic add-partitions logs-raw -n 64 2>/dev/null || true

docker exec logrider-redpanda-1 rpk topic create logs-ingested -p 1 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic create logs-persist -p 1 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic create logs-normalized -p 1 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic create ws-events -p 1 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic create alerts-raw -p 1 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic create alerts-state -p 1 2>/dev/null || true
docker exec logrider-redpanda-1 rpk topic create dlq-logs -p 1 2>/dev/null || true

echo "Done."
docker exec logrider-redpanda-1 rpk topic create logs-tagged -p 1 2>/dev/null || true
