# Non-Functional Requirements

## NFR-001: Ingestion Throughput
- **Metric:** Logs accepted per second.
- **Threshold:** 10,000 req/sec per token.
- **Measurement Instrument:** Prometheus `http_requests_total` rate.
- **Violation Consequence:** Rate limiting returns `429 Too Many Requests`.

## NFR-002: Storage Retention
- **Metric:** Days data retained in ClickHouse.
- **Threshold:** 7 days for INFO, 30 days for ERROR.
- **Measurement Instrument:** ClickHouse system tables / native TTL logs.
- **Violation Consequence:** Disk space alerts, manual `OPTIMIZE TABLE` run.

## NFR-003: Telegram Rate Limiting
- **Metric:** Outbound API calls to Telegram.
- **Threshold:** Compliant with Telegram API limits (managed via Redis token bucket).
- **Measurement Instrument:** Redis Lua script counters.
- **Violation Consequence:** Queued for batching digest.

## NFR-004: WebSocket Scaling
- **Metric:** Concurrent WebSocket connections.
- **Threshold:** Scalable via horizontal pod autoscaling and broadcast consumer pattern.
- **Measurement Instrument:** Prometheus `websocket_connections_active`.
- **Violation Consequence:** Pod OOM kills or high latency, triggering auto-scaler.

## NFR-005: Code Performance
- **Metric:** Thread block time.
- **Threshold:** Minimal blocking by prioritizing `Arc` over `Rc` and standard `String` over `Cow` except in hot paths.
- **Measurement Instrument:** Tokio console.
- **Violation Consequence:** Decreased throughput, increased latency.
