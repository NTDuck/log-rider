# LogRider Benchmark Summary - 2026-07-05

Environment:
- OS: Linux 7.1.1-cachyos x86_64
- CPU: 20 logical CPUs
- RAM: 15.4 GiB
- Docker: 29.5.3
- k6: 2.0.0

Measured results:

| Scenario | Result |
|---|---|
| 5-log smoke | 5/5 persisted in 1844 ms; 5/5 tags appeared after drain. |
| k6 smoke | 100 HTTP 202 checks passed; p95 HTTP 3.14 ms; 100 persisted. |
| k6 burst-500 | 501 HTTP 202 checks passed; p95 HTTP 8.67 ms; 501 persisted after 24.0 s. k6 emitted one boundary iteration above the nominal 500 target. |
| exact 500 demo | `test.sh` persisted 500/500 and classified 500/500 in 31.7 s. |
| baseline | 4,640 HTTP 202 checks passed at 151.85 req/s observed; p95 HTTP 754.39 ms; 2,796 rows persisted after 119 s. Saturated before the 75,000-log configured target. |
| alert burst | 100/100 identical ERROR logs persisted in 6.317 s; 100 alert stream updates; one recent notification key; dedup count 100; Telegram queue 0 without subscribers. |
| API query | 1,501 checks passed at 50.02 req/s using a pre-created session token; p95 HTTP 5.16 ms. |
| WebSocket | 1,460 connection checks passed at 47.09 sessions/s using a pre-created session token; p95 connect 1.28 ms. |
| classifier batch | 100/100 logs persisted and 100/100 tags written in 7.203 s; 13.88 tagged logs/s. |
| ClickHouse degraded | 20 logs accepted while ClickHouse was stopped; 7 records reached `dlq-clickhouse`, 13 persisted after ClickHouse recovery. |

Important caveat:
- Repeating `/login` inside the API/WebSocket k6 iteration caused web-server connection resets and temporary unavailability. API and WebSocket endpoint benchmarks therefore use one pre-created session token to measure endpoint behavior rather than password hashing throughput.
