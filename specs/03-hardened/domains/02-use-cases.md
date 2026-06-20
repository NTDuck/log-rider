# Use Cases

## Actor Map
- **Telemetry Producer**: External apps pushing logs.
- **Alert Consumer**: Internal system aggregating and dispatching alerts.
- **Admin**: Configures thresholds and permissions.
- **AI Sidecar**: Analyzes logs to append ML metadata.
- **Live Viewer User**: End user viewing real-time streams via WebSocket.

---

## UC-01: Ingest Telemetry
**Primary Actor:** Telemetry Producer
**Boundary Referenced:** HTTP Ingress (`/api/v1/logs`), Redpanda `logs-raw`.
**Primary Flow:**
1. Producer sends a POST request with an OTLP payload to `/api/v1/logs`.
2. Edge Receiver validates JWT and structural limits (max 64KB, depth < 5).
3. Edge Receiver flattens the attributes.
4. Edge Receiver appends the payload to `logs-raw`.
5. System returns `202 Accepted`.
**Alternate Flow:**
- If payload is malformed, system returns `400 Bad Request`.
**Exceptional Flow:**
- If Redpanda is down, Edge Receiver drops the request with `503` (backpressure).

---

## UC-02: Process and Dispatch Alerts
**Primary Actor:** Alert Consumer
**Boundary Referenced:** Redpanda `alerts-priority-stream`, Redis, Telegram Webhook.
**Primary Flow:**
1. Rust Worker detects a log with level `ERROR` or `CRITICAL`.
2. Worker computes Alert Fingerprint (App + Level + Code) and pushes to `alerts-priority-stream`.
3. Alert Consumer reads the topic.
4. Alert Consumer checks Redis for the Tumbling Window counter.
5. If count hits threshold (e.g., 100 in 60s), Alert Consumer formats a message.
6. Alert Consumer invokes Telegram API (honoring Redis token bucket).
**Alternate Flow:**
- If counter is below threshold, the alert is suppressed (deduplicated).
**Exceptional Flow:**
- If Telegram rate limits (429), alert is buffered for a batch digest.

---

## UC-03: Update Configurations
**Primary Actor:** Admin
**Boundary Referenced:** Control Plane Endpoints, ClickHouse append-only stream, Redis Pub/Sub.
**Primary Flow:**
1. Admin sends `PUT` to `/api/v1/config/thresholds`.
2. Control plane inserts a new row in the ClickHouse config stream.
3. Control plane publishes invalidation message to Redis Pub/Sub.
4. Rust workers receive Redis message and reload config from ClickHouse.
**Exceptional Flow:**
- If Redis is down, workers poll ClickHouse periodically as a fallback.

---

## UC-04: AI Log Classification
**Primary Actor:** AI Sidecar
**Boundary Referenced:** Redpanda `logs-normalized`, `ai-tags-stream`, ClickHouse `log_ai_tags`.
**Primary Flow:**
1. AI Sidecar consumes from `logs-normalized`.
2. Model classifies log sentiment/category.
3. AI Sidecar writes tags to `log_ai_tags` sidecar table.
4. AI Sidecar pushes a lightweight patch to `ai-tags-stream`.
**Exceptional Flow:**
- If the AI model crashes, logs continue processing unaffected.

---

## UC-05: Real-time Live Stream
**Primary Actor:** Live Viewer User
**Boundary Referenced:** WebSocket Ingress (`/api/v1/stream`), Redpanda `logs-normalized`.
**Primary Flow:**
1. User connects via WebSocket with a valid JWT.
2. WebSocket server creates an ephemeral consumer group and reads from `logs-normalized`.
3. Server filters stream in-memory based on JWT `app_grants`.
4. Server pushes matching logs to the user's socket.
**Alternate Flow:**
- If user lacks permissions, connection succeeds but stream is empty.
**Exceptional Flow:**
- If WebSocket server restarts, client reconnects, generating a new ephemeral group.
