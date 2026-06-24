#!/bin/bash
echo "Waiting for Redpanda to start..."
until rpk cluster info; do
    echo "Redpanda not ready yet, waiting..."
    sleep 2
done

echo "Creating topics..."
rpk topic create logs-raw -p 3 || true
rpk topic create logs-normalized -p 3 || true
rpk topic create alerts-priority-stream -p 3 || true
rpk topic create ai-tags-stream -p 3 || true

echo "Topics created successfully."
