#!/bin/bash
set -euo pipefail

mkdir -p benchmarks/scenarios benchmarks/k6 benchmarks/lib benchmarks/results

touch benchmarks/results/.gitkeep

cat << 'INNER' > benchmarks/REPORT_SECTION_TEMPLATE.md
# Benchmark Methodology

## Environment
* **OS:** Linux
* **CPU:** (Fill me in)
* **Memory:** (Fill me in)
* **Docker version:** (Fill me in)

## Scenarios
* **smoke:** Basic functional test (10 req/s, 10s)
* **baseline:** Normal throughput test (250 req/s, 30s)
* **ramp:** Saturation curve exploration (100 -> 1000 req/s)
* **stress:** Near failure exploration
* **soak:** Sustained moderate load (15m)
* **alert-dedup:** Verifies alert locking logic
* **api-query:** Read API latency under normal state
* **websocket:** WebSocket event throughput

## Results
| Scenario | Attempted logs | Accepted logs | Persisted logs | Loss % | Drain time | Persisted logs/sec | p95 HTTP | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| ... | ... | ... | ... | ... | ... | ... | ... | ... |

## Analysis
(Fill me in)

## Bottlenecks
(Fill me in)

## Limitations
(Fill me in)
INNER

cat << 'INNER' > benchmarks/scenarios/smoke.env
RATE=10
DURATION=10s
BATCH_SIZE=1
MAX_HTTP_FAILURE_RATE=0.01
MIN_PERSISTED_RATIO=1.0
MAX_DRAIN_SECONDS=30
MAX_HTTP_P95_MS=500
EXPECTED_LOGS=100
PROTOCOL=http
INNER

cat << 'INNER' > benchmarks/scenarios/baseline.env
RATE=250
DURATION=30s
BATCH_SIZE=10
MAX_HTTP_FAILURE_RATE=0.01
MIN_PERSISTED_RATIO=0.99
MAX_DRAIN_SECONDS=120
MAX_HTTP_P95_MS=500
EXPECTED_LOGS=75000
PROTOCOL=http
INNER

cat << 'INNER' > benchmarks/scenarios/ramp.env
RATE=ramp
DURATION=120s
BATCH_SIZE=10
MAX_HTTP_FAILURE_RATE=0.01
MIN_PERSISTED_RATIO=0.95
MAX_DRAIN_SECONDS=300
MAX_HTTP_P95_MS=2000
EXPECTED_LOGS=555000
PROTOCOL=http
INNER

cat << 'INNER' > benchmarks/scenarios/stress.env
RATE=100
DURATION=10s
BATCH_SIZE=10000
MAX_HTTP_FAILURE_RATE=0.50
MIN_PERSISTED_RATIO=0.80
MAX_DRAIN_SECONDS=600
MAX_HTTP_P95_MS=5000
EXPECTED_LOGS=10000000
PROTOCOL=http
INNER

cat << 'INNER' > benchmarks/scenarios/soak.env
RATE=100
DURATION=15m
BATCH_SIZE=10
MAX_HTTP_FAILURE_RATE=0.01
MIN_PERSISTED_RATIO=0.99
MAX_DRAIN_SECONDS=300
MAX_HTTP_P95_MS=1000
EXPECTED_LOGS=900000
PROTOCOL=http
INNER

cat << 'INNER' > benchmarks/scenarios/alert-dedup.env
RATE=500
DURATION=60s
BATCH_SIZE=1
MAX_HTTP_FAILURE_RATE=0.01
MIN_PERSISTED_RATIO=0.99
MAX_DRAIN_SECONDS=60
MAX_HTTP_P95_MS=500
EXPECTED_LOGS=500
PROTOCOL=http
INNER

cat << 'INNER' > benchmarks/scenarios/api-query.env
RATE=50
DURATION=30s
MAX_HTTP_FAILURE_RATE=0.01
MAX_HTTP_P95_MS=1000
INNER

cat << 'INNER' > benchmarks/scenarios/websocket.env
RATE=50
DURATION=30s
BATCH_SIZE=5
MAX_HTTP_FAILURE_RATE=0.01
MIN_PERSISTED_RATIO=0.99
MAX_DRAIN_SECONDS=60
MAX_HTTP_P95_MS=500
EXPECTED_LOGS=7500
PROTOCOL=http
INNER

cat << 'INNER' > benchmarks/README.md
# LogRider Benchmarks

Comprehensive benchmark suite for the LogRider project.

## Scenarios
- `smoke`: Basic correctness check.
- `baseline`: Normal throughput.
- `ramp`: Saturation curve.
- `stress`: Extreme capacity limits.
- `soak`: Long-running reliability.
- `alert-dedup`: Checks alert locking mechanisms.
- `api-query`: Benchmarks read APIs.
- `websocket`: Benchmarks real-time updates.

## How to run
```bash
./benchmarks/run.sh smoke
./benchmarks/run.sh all
```

## Environment Config
Each scenario `.env` configures:
- `RATE`: requests per sec
- `DURATION`: duration (e.g. 10s, 15m)
- `BATCH_SIZE`: logs per request
- `PROTOCOL`: 'http' or 'grpc'

Note: Benchmarks test HTTP and gRPC ingest paths.
INNER
