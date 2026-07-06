#!/usr/bin/env bash
generate_report() {
  local scenario=$1
  local dir=$2
  
  cat << REPORT > "$dir/summary.md"
# Benchmark Report: $scenario

## Environment
* OS: $(uname -a)
* Time: $(date)

## Results
* Pass/Fail evaluated manually based on raw.log and clickhouse-counts.txt
* See raw files in this directory for detailed metrics.
REPORT

  echo '{"scenario": "'$scenario'"}' > "$dir/summary.json"
}
