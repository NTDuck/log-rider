# LogRider Benchmarks

Comprehensive benchmark suite for the LogRider project.

## Scenarios
- `smoke`: Basic correctness check.
- `burst-500`: 500-log demo burst target.
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
./benchmarks/run.sh burst-500
./benchmarks/run.sh all
```

## Environment Config
Each scenario `.env` configures:
- `RATE`: requests per sec
- `DURATION`: duration (e.g. 10s, 15m)
- `BATCH_SIZE`: logs per request
- `PROTOCOL`: 'http' or 'grpc'

Note: Benchmarks test HTTP and gRPC ingest paths.
