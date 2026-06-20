# System Boundaries

This document exhaustively defines every ingress and egress point within the Logger system.

## 1. HTTP Ingress: Edge Receiver
**Path:** `POST /api/v1/logs`
**Method:** POST
**Headers:**
- `Authorization`: Bearer token (JWT claim `app_grants`) [ADR-0009, ADR-0025]
- `Content-Type`: `application/json` or `application/x-protobuf`
**Body Structure:** OTLP payload (flattened at the edge [ADR-0016])
**Response Codes:**
- `202 Accepted`: Payload buffered to Redpanda.
- `400 Bad Request`: Malformed payload.
- `401 Unauthorized`: Invalid or missing token.
- `413 Payload Too Large`: Exceeds 64KB [ADR-0005].
- `429 Too Many Requests`: Rate limit exceeded.
**Rate-Limits:** 10,000 req/sec per token.
**Idempotency:** Non-idempotent (append-only telemetry).

**Error Scenarios:**
1. Payload exceeds 64KB -> Drops request, returns 413.
2. Token is expired -> Drops request, returns 401.
3. Redpanda is unreachable -> Returns 503, applies backpressure.
4. Schema is nested > 5 levels -> Returns 400 Bad Request.
5. Arrays are heterogeneous -> Returns 400 Bad Request.

## 2. WebSocket Ingress: Real-time Viewer
**Path:** `GET /api/v1/stream`
**Upgrade:** WebSocket
**Authentication:** JWT via query parameter or header [ADR-0009].
**Semantics:** Ephemeral consumer group ID generated per replica [ADR-0014].
**Response Codes:** 101 Switching Protocols.

**Error Scenarios:**
1. Invalid JWT -> Drops connection immediately.
2. User lacks wildcard or specific app claim -> Connects but receives no data.
3. Connection drop -> Client auto-reconnects with exponential backoff.
4. Redpanda goes offline -> Sends close frame 1011 (Internal Error).
5. Message payload malformed -> Skips message, logs error, keeps connection open.

## 3. Redpanda Topics
**Topic: `logs-raw`**
- **Partitioning:** By App ID.
- **Retention:** 24 hours.
- **Replication:** Factor 3.
- **Producer/Consumer:** Edge Receiver -> Custom Rust Workers [ADR-0002].

**Topic: `logs-dlq`**
- **Partitioning:** By Error Type.
- **Retention:** 7 days.
- **Semantics:** Poison pills only [ADR-0018].

**Topic: `logs-normalized`**
- **Partitioning:** By App ID.
- **Retention:** 24 hours.
- **Producer/Consumer:** Rust Workers -> ClickHouse, WebSocket, AI Sidecar [ADR-0017].

**Topic: `alerts-priority-stream`**
- **Partitioning:** By Alert Fingerprint [ADR-0012].
- **Retention:** 3 days.
- **Producer:** Rust Workers [ADR-0004].

**Topic: `ai-tags-stream`**
- **Partitioning:** By Log ID.
- **Producer:** AI Consumer [ADR-0019].

**Error Scenarios (Broker):**
1. Disk full -> Halts producers.
2. Partition leader election -> Transient latency spike.
3. Worker lag -> Increases offset delta, triggers Prometheus alert.
4. Poison pill -> Worker publishes to `logs-dlq` and acks original message.
5. Topic doesn't exist -> Auto-created on first write (if enabled) or throws error.

## 4. ClickHouse Tables
**Table: `logs`**
- **Engine:** MergeTree (or ReplicatedMergeTree).
- **TTL:** 7 days for INFO, 30 days for ERROR [ADR-0007].
- **Partitioning:** By `toYYYYMMDD(timestamp)`.

**Table: `log_ai_tags` (Sidecar)**
- **Engine:** MergeTree
- **Purpose:** Prevent OLAP mutations [ADR-0008].

**Materialized Views:**
- AggregatingMergeTree for dashboards [ADR-0011].

**Error Scenarios (DB):**
1. Zookeeper split-brain -> Read-only mode.
2. Too many parts -> Rejects inserts.
3. TTL thread falls behind -> Manual `OPTIMIZE TABLE` required.
4. Schema mismatch -> Insert batch fails, logs error.
5. Query exceeds memory limit -> Query aborted, returns DB error.

## 5. Telegram Webhooks
**Integration:** Outbound API to Telegram.
**Rate Limiting:** Global Redis token bucket via Lua [ADR-0022].

**Error Scenarios:**
1. Telegram API timeout -> Fallback to batching.
2. 429 from Telegram -> Pause queue, wait for Retry-After.
3. Invalid Chat ID -> Discard alert, log misconfiguration.
4. Redis offline -> Fails open or closed based on config (typically batch fallback).
5. Message too long -> Truncate payload.

## 6. Control Plane Endpoints
**Path:** `PUT /api/v1/config/thresholds`
**Storage:** Append-only config stream in ClickHouse [ADR-0015].
**Invalidation:** Redis Pub/Sub.

**Error Scenarios:**
1. Unauthorized -> 401.
2. Invalid threshold payload -> 400.
3. Redis failure -> DB updated, but cache invalidation delayed.
4. ClickHouse read-only -> 503.
5. Concurrent updates -> Last write wins.
