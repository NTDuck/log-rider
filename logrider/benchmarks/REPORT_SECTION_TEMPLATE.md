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
