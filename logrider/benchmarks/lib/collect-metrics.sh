#!/usr/bin/env bash
RES_DIR=$1
echo "timestamp,cpu_pct,mem_usage,mem_pct,net_io,block_io,pids" > "$RES_DIR/docker-stats.csv"
while true; do
  docker stats --no-stream --format "{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}" >> "$RES_DIR/docker-stats.csv" || true
  sleep 1
done
