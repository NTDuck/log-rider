# Benchmark Methodology

## Environment
* **OS:** Linux 7.1.1-cachyos x86_64
* **CPU:** 20 logical CPUs
* **Memory:** 15.4 GiB RAM
* **Docker version:** 29.5.3
* **k6 version:** 2.0.0

## Scenarios
* **smoke:** Basic functional test (10 req/s, 10s)
* **burst-500:** Demo burst target (250 req/s, 2s)
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
| smoke | 100 | 100 | 100 | 0.0% | 0 ms | n/a | 3.14 ms | PASS |
| burst-500 (k6) | 501 | 501 | 501 | 0.0% | 24.0 s | 20.88 | 8.67 ms | PASS, k6 emitted 501 boundary iterations |
| exact 500 demo (`test.sh`) | 500 | 500 | 500 | 0.0% | 31.7 s | 15.75 | n/a | PASS, 500 classified |
| baseline | 75,000 target | 4,640 HTTP accepted | 2,796 within 119 s | incomplete | 119 s observed | 23.50 observed | 754.39 ms | SATURATED |
| alert 100 identical errors | 100 | 100 | 100 | 0.0% | 6.317 s | 15.83 | 161.39 ms from k6 alert run | PASS with threshold/update semantics |
| api-query | 1,501 requests | 1,501 | n/a | 0.0% | n/a | n/a | 5.16 ms | PASS with pre-created session token |
| websocket | 1,460 sessions | 1,460 | n/a | 0.0% | n/a | n/a | 1.28 ms connect p95 | PASS with pre-created session token |
| classifier batch | 100 | 100 | 100 tags | 0.0% | 7.203 s | 13.88 tagged logs/s | n/a | PASS |
| ClickHouse degraded | 20 | 20 | 13 after recovery; 7 DLQ | 0.0% observed | 12 s observation | n/a | n/a | PARTIAL FALLBACK |

## Analysis
The prototype handles the exact 500-log demo end-to-end, but persistence/classification drain is much slower than HTTP acknowledgement. The baseline scenario saturates before the configured 75,000-log target: k6 reached the VU cap and ClickHouse only held 2,796 rows after the observation window.

## Bottlenecks
Persistence/classification throughput, web-server login hashing under repeated login load, and missing per-stage instrumentation are the main bottlenecks observed. API query and WebSocket checks pass when a session token is created once before the benchmark.

## Limitations
These numbers are local Docker Compose measurements on one machine, not production multi-node benchmarks. Per-message p95 from ingest to ClickHouse/WebSocket is not instrumented yet.
