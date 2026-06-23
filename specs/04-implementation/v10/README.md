# Implementation Roadmap: Log Collection and Application Error Monitoring System (v10 Tracks)

This document outlines the highly programmatic, execution-oriented roadmap consisting of seven independent implementation tracks using the 4-Phase Execution Ledger structure.

This v10 architecture upgrades the v9 CSP decoupling. Tracks 2, 3, 4, 5, and 7 are functionally frozen and untouched from v9. Track 1 and Track 6 underwent targeted structural surgery to completely isolate CSP ingress and finalize telemetry ledgers, satisfying the strict CSP and Concurrency Audit. It strictly enforces token-level JSON parsing, latch-based cancellation, decoupled consumer backpressure, outbox patterns, and isolated egress tasks to eliminate data loss, deadlocks, commit tearing, and WebSocket frame corruption.

No markdown code blocks are used in this document to prevent semantic overfitting and enforce strict model focus. All schemas, features, loops, and wiring directives are described using structured lists, tables, and raw text labels.

## Table of Contents
- [Track 1: Edge Receiver](#track-1-edge-receiver)
- [Track 2: Normalization Worker](#track-2-normalization-worker)
- [Track 3: DB Writer](#track-3-db-writer)
- [Track 4: AI Consumer](#track-4-ai-consumer)
- [Track 5: Alert Consumer](#track-5-alert-consumer)
- [Track 6: WebSocket Server](#track-6-websocket-server)
- [Track 7: Admin API](#track-7-admin-api)

---

## Track 1: Edge Receiver

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via the CLI role flag "--role edge". It takes upstream HTTP POST requests on the path "/v1/logs" (authenticated via stateless JWT Bearer tokens). It produces validated, flattened log payloads to the Redpanda topic "logs-raw".
- **Data Schemas:**
  - Wire Model - HTTP Boundary:
    - *Note: Deserializing into an intermediate WireLog AST or serde_json::Value is strictly forbidden to prevent memory-exhaustion DoS.*
    - timestamp: String (ISO 8601 formatted date-time string)
    - level: String (Allowed values: DEBUG, INFO, WARN, ERROR, CRITICAL)
    - message: String (Max length 32768)
    - app_name: String (Max length 255)
    - error_code: Option string (Deterministic string for alert bucketing, max length 255)
    - attributes: (Raw, unvalidated JSON - streamed and evaluated on-the-fly)
  - Domain Model (DomainLog) - Kafka Boundary:
    - log_id: UUID (Generated at edge via Uuid::now_v7)
    - timestamp: String (ISO 8601 formatted date-time string, validated)
    - level: String (Validated against the enum set)
    - message: String (Validated max length 32768)
    - app_name: String (Validated max length 255)
    - error_code: Option string (Max length 255)
    - attribute_keys: Vector of strings (Dot-notation flattened keys, e.g. "request.headers.content_type")
    - attribute_values_string: Vector of strings (Parallel array of stringified leaf values, positionally aligned with attribute_keys)
  - JWT Claims Model:
    - sub: String (Subject identifier)
    - app_grants: Vector of strings (Application names authorized for ingestion, wildcard "*" grants universal access)
    - exp: u64 (Expiration timestamp, seconds since epoch)
  - EdgeError Variants:
    - Unauthorized: Client JWT is missing, expired, or invalid.
    - Forbidden: Application name in payload is not present in JWT app grants list and no wildcard exists.
    - BadRequest: Payloads containing malformed JSON, nested depth exceeding 5 levels, invalid level enum, or any field exceeding maxLength.
    - PayloadTooLarge: Payload size exceeds 256KB uncompressed.
    - KafkaProduceError: Internal failure when writing to Redpanda topic.
  - LogProducer Boundary Trait:
    - Method: produce(log: DomainLog) -> Fallible Result containing success or EdgeError.
- **Physical Constraints:**
  - Must drop connections directly at the socket level if the body size exceeds 256KB before any JSON parsing.
  - Depth limit is 5 levels. A depth breach produces an immediate HTTP 400.
  - Wire-to-Domain Decoupling: Domain model stores flattened parallel arrays.
- **Closed-World Telemetry Contract:**
  - logger_ingest_bytes_total (Counter): Total raw bytes ingested, incremented immediately after socket extraction.
  - logger_events_processed_total (Counter, labels: stage="edge", status="success" or "error"): Incremented exactly once upon terminal completion of the produce phase.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Edge Receiver Ingestion):**
  - Scenario 1: Valid log payload is accepted and flattened.
  - Scenario 2: Payload exceeds depth limit, rejected with HTTP 400.
  - Scenario 3: Request payload exceeds maximum size limit.
  - Scenario 4: JWT is missing or invalid.
  - Scenario 5: App name not in JWT grants.
  - Scenario 6: Wildcard JWT grant allows any app_name.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define DomainLog with Serialize and bon builder. Define EdgeError enum with axiom Erratum. Define JwtClaims struct. Implement cucumber EdgeWorld and step definitions. Run tests and verify they fail.
- **Step 2: Pure Logic:**
  - True Token-Stream Parsing: Eradicate serde_json::Deserializer::from_slice(...).into_iter::<Value>(). Use a low-level token pull-parser (e.g., struson or a custom byte-scanner) to count "{" and "[" tokens directly from the byte stream, aborting before any memory allocation if depth > 5. Allocate an explicit stack vector for prefixes. Recursion is forbidden.
  - Stateless JWT validator: Use jsonwebtoken to validate token using public key. Check expiration and claims. Apply tap_err with tracing::error.
  - App name grant checker: Verify app_name is in app_grants or wildcard "*" is present.
- **Step 3: Infrastructure Adapters:** Implement KafkaLogProducer wrapping rdkafka FutureProducer. async produce method must serialize DomainLog to bytes, produce to topic "logs-raw". Method must carry #[tracing::instrument(skip_all)]. Apply tap_err to log errors. Suffix success with tracing::debug.
- **Step 4: The Actor Loop:** Implement the Axum POST handler.
  - Read request body as Bytes first. You MUST explicitly instruct the use of tower::timeout::TimeoutLayer directly within the DAG (Phase 3) to strictly govern the HTTP stream-read phase. Measure length and increment logger_ingest_bytes_total.
  - Validate JWT.
  - Use token-level pull-parser to validate enum constraints, check depth iteratively, and construct DomainLog. On depth breach or validation error, return HTTP 400.
  - Check grants.
  - Cancellation-Safe Produce: Once the payload is validated and enters the KafkaLogProducer.produce phase, wrap it in a guaranteed-completion future or spawned task so it cannot be cancelled mid-flight by client disconnects. Increment logger_events_processed_total exactly once at the termination of this guaranteed task. You MUST explicitly mandate the mechanical use of tokio_util::sync::CancellationToken for idempotent shutdown.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogProducer.
  - Register logger_ingest_bytes_total and logger_events_processed_total in the Prometheus registry.
  - Setup Axum Router. Apply DefaultBodyLimit layer of 256KB to enforce the limit at the socket level. Do not wrap the entire Axum router in TimeoutLayer (timeout logic is explicitly governed in Phase 3).
  - Check if role is edge, spawn Axum server on port 8080.
  - Wrap launch sequence in tracing instrumented span.

---

## Track 2: Normalization Worker

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role normalization". It consumes messages from Redpanda topic "logs-raw". It publishes normalized log payloads to the topic "logs-normalized", duplicates high-priority error/critical logs to "alerts-priority-stream", and routes poison pills to "logs-dlq".
- **Data Schemas:**
  - NormalizedLog Model
  - DLQEnvelope Model
  - NormalizationError Variants
  - LogConsumer Boundary Trait
  - NormalizedProducer Boundary Trait
- **Physical Constraints:**
  - Execute statically compiled PII regex check and redaction before alert duplication or normal ingestion.
  - Wrap poison pills in DLQEnvelope, truncating original payload to 2KB to prevent memory/storage leak.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="normalization", status="success" or "error")
  - logger_dlq_routed_total (Counter)
  - logger_pii_redactions_total (Counter)

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Normalization Worker Processing):**
  - Scenario 1: Valid log is PII-redacted and normalized.
  - Scenario 2: High-priority error is duplicated.
  - Scenario 3: Poison pill is sent to DLQ.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define schemas and errors. Implement NormalizationWorld BDD cucumber tests and verify they fail.
- **Step 2: Pure Logic:** Implement PII Regex Engine using std::sync::LazyLock, Parallel Array Flattener, and DLQ Envelope Builder.
- **Step 3: Infrastructure Adapters:** Connect rdkafka StreamConsumer and FutureProducer. Commit offsets only after downstream produce calls return success.
- **Step 4: The Actor Loop:** Implement consumer loop matching on consumed message. Handle decompression, size checks, deserialization.
  - Enforce Idempotent Cancellation: Eradicate tokio::sync::watch::Receiver. Mandate the use of tokio_util::sync::CancellationToken, polled recursively inside all inner retry loops without deadlocks.
  - Increment logger_events_processed_total OUTSIDE of any infinite retry loops. Count the message, not the retry attempt.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate Kafka consumer and producer.
  - Register metrics logger_events_processed_total, logger_dlq_routed_total, and logger_pii_redactions_total.
  - Spawn normalization loop when role is normalization.

---

## Track 3: DB Writer

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role db-writer". It consumes normalized logs from Redpanda topic "logs-normalized". It inserts them in batches to the ClickHouse table "logs".
- **Data Schemas:**
  - Input: NormalizedLog model
  - DbWriterError Variants
  - ClickHouseWriter Boundary Trait
- **Physical Constraints:**
  - ClickHouse tables accept immutable INSERTs only. UPDATE or DELETE queries are forbidden.
  - Batch writes by row count (1000 items) or timer (5 seconds), whichever comes first.
  - Commit offsets only on successful DB write.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="db_writer", status="success" or "error")

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Database Batch Writer):**
  - Scenario 1: Batch of normalized logs is written to ClickHouse.
  - Scenario 2: ClickHouse is offline. Task B retries in place while Task A blocks on channel backpressure.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup DbWriterWorld cucumber tests and verify they fail.
- **Step 2: Pure Logic:** Implement buffer accumulator that groups items and triggers on limit or timeout.
- **Step 3: Infrastructure Adapters:** Connect reqwest HTTP client to execute ClickHouse HTTP POST writes to the logs table using JSONEachRow format.
- **Step 4: The Actor Loop:** Implement the Decoupled Consumer Pattern for strict Anti-Blocking Kafka Backpressure mechanics without data loss:
  - Task A (Fetcher): Polls consumer.recv() and pushes messages into a bounded tokio::sync::mpsc channel. Eradicate all polling of consumer.recv() inside retry loops. Acknowledge librdkafka handles heartbeats autonomously.
  - Task B (Processor): Reads from the mpsc channel, executes the DB writes, and commits offsets. If the DB goes offline, Task B retries in place. The mpsc channel fills up, naturally blocking Task A via TCP backpressure, leaving pre-fetched messages safely inside librdkafka's internal queues.
  - Enforce Idempotent Cancellation: Use tokio_util::sync::CancellationToken recursively inside all loops.
  - Increment logger_events_processed_total OUTSIDE of the infinite retry loops. Count the message, not the retry attempt.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate Kafka consumer and ClickHouse HTTP writer.
  - Create the bounded mpsc channel and spawn Task A and Task B concurrently.
  - Register logger_events_processed_total metric.
  - Spawn DB writer orchestrator when role is db-writer.

---

## Track 4: AI Consumer

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role ai-consumer". Consumes from "logs-normalized", publishes strictly to "ai-tags-stream".
- **Data Schemas:**
  - AITag Model
  - AIError Variants
  - AIClassifier Boundary Trait
  - TagStreamPublisher Boundary Trait
- **Physical Constraints:**
  - Relational JOINs and IN(UUID) filtering on the primary logs table are strictly forbidden. 
  - ONNX inference must run asynchronously using tokio::task::spawn_blocking.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="ai_consumer", status="success" or "error")

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (AI Consumer Classification):**
  - Scenario 1: Log is classified and tag is published to stream.
  - Scenario 2: Redpanda is offline. Task B retries in place while Task A blocks on channel backpressure.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AIWorld cucumber BDD tests.
- **Step 2: Pure Logic:** Extract message text. Parse confidence scores.
- **Step 3: Infrastructure Adapters:** Initialize ONNX runtime. Build rdkafka FutureProducer for ai-tags-stream.
- **Step 4: The Actor Loop:** Implement classification loop. Spawn ort session in spawn_blocking. Implement the Decoupled Consumer Pattern and Single-Sink Pattern:
  - Task A (Fetcher): Polls consumer.recv() and pushes messages into a bounded tokio::sync::mpsc channel. Eradicate consumer.recv() polling inside retry loops.
  - Task B (Processor): Reads from the mpsc channel, performs classification, and executes writes. 
  - The Outbox / Single-Sink Pattern: Eradicate the sequential dual-write. Task B MUST NOT write to ClickHouse and Redpanda sequentially. It must write its classification tag strictly to the ai-tags-stream Redpanda topic (the immutable ledger). A separate, independent projection process will move those tags to ClickHouse.
  - If Redpanda goes offline, Task B retries in place, filling the mpsc channel and blocking Task A naturally.
  - Enforce Idempotent Cancellation: Use tokio_util::sync::CancellationToken recursively inside all loops.
  - Increment logger_events_processed_total OUTSIDE of the infinite retry loops. Count the message, not the retry attempt.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate Kafka consumer, ONNX classifier, and Redpanda publisher.
  - Create the bounded mpsc channel and spawn Task A and Task B concurrently.
  - Register logger_events_processed_total metric.
  - Spawn AI consumer orchestrator when role is ai-consumer.

---

## Track 5: Alert Consumer

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role alert-consumer". Consumes from "alerts-priority-stream". Deduplicates via Redis, sends Telegram notifications, subscribes to Redis Pub/Sub "admin:config_updates".
- **Data Schemas:**
  - AlertConfig Model
  - AlertError Variants
  - RateLimiter Boundary Trait
  - AlertNotifier Boundary Trait
  - ConfigSubscriber Boundary Trait
- **Physical Constraints:**
  - Must run Lua Token Bucket script atomically in EVAL script.
  - Must write keys to Redis using a strict TTL (window_seconds + 10).
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="alert", status="success" or "error")
  - logger_alerts_fired_total (Counter)

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Alert Tumbling Window & Notifications):**
  - Scenario 1: High-priority errors are deduplicated and limited.
  - Scenario 2: Dynamic config update.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AlertWorld cucumber tests.
- **Step 2: Pure Logic:** Compute SHA-256 fingerprint. Implement config cache storage.
- **Step 3: Infrastructure Adapters:** Build Redis Lua script execution wrapper. Build Telegram HTTP notifier client. Build Redis Pub/Sub channel listener.
- **Step 4: The Actor Loops:**
  - Config Listener Loop: Execute synchronous fetch of the latest configuration from the database/Admin API upon startup BEFORE subscribing to the Redis Pub/Sub channel. Hardcoded defaults are forbidden. Subscribe to Redis channel, updating RwLock cache. Wrap in retry loop to handle socket drops. Ensure tokio_util::sync::CancellationToken is polled recursively inside the retry loop.
  - Event Processor Loop: Consume alerts, compute fingerprint, evaluate rate limit, notify Telegram. Increment logger_events_processed_total OUTSIDE of infinite retry loops. Count the message, not the retry attempt. Ensure CancellationToken is polled recursively inside all inner retry loops.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate Kafka consumer, RedisRateLimiter, TelegramNotifier, and RedisConfigSubscriber.
  - Execute the synchronous fetch of the latest configuration before completing the initialization.
  - Register metrics logger_events_processed_total and logger_alerts_fired_total.
  - Spawn listener loops when role is alert-consumer.

---

## Track 6: WebSocket Server

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role ws-server". Consumes from logs-normalized and broadcasts logs to WebSocket viewer clients.
- **Data Schemas:**
  - WsClientConfig Model
  - BroadcastMessage Model
  - WSError Variants
- **Physical Constraints:**
  - Broadcast Consumer Pattern: Ingestion loop consumes from Kafka and pushes to shared bounded memory channel.
  - Bounded memory channel capacity MUST be exactly 1024.
  - Zero database queries: No ClickHouse or Redis queries allowed.
- **Closed-World Telemetry Contract:**
  - logger_active_connections (Gauge): Number of active WebSocket connections.
  - logger_events_processed_total (labels: stage="ws", status="success" or "error"): Incremented upon terminal delivery attempt.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (WebSocket Viewer):**
  - Scenario 1: Client receives authorized logs.
  - Scenario 2: Wildcard client receives all logs.
  - Scenario 3: Lagging client is closed.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup WSWorld cucumber tests and verify they fail.
- **Step 2: Pure Logic:** Implement JWT claim checker and app_name filter.
- **Step 3: Infrastructure Adapters:** Connect Axum WebSocket handler. Wrap async I/O in #[tracing::instrument(skip_all)] and tap_err.
- **Step 4: The Event Loops:**
  - Ingestion Loop: Consumes from logs-normalized, pushing into bounded broadcast channel of capacity 1024. Ensure tokio_util::sync::CancellationToken is polled.
  - Client Connection Loops: You MUST explicitly decouple the WebSocket connection into three distinct tasks per client:
    - Task A (Ingress Fetcher): A dedicated task that only polls the incoming client stream for Close/Ping frames and pushes them to a local channel, or triggers cancellation.
    - Task B (Processor): The session_loop that reads from the broadcast channel, runs the should_deliver filter, and pushes to the Egress channel.
    - Task C (Egress Sink): Reads from the local bounded mpsc channel and executes ws.send().await.
  - The DAG must explicitly state that logger_events_processed_total is incremented EXACTLY ONCE per client delivery attempt, and it must occur inside Task C (Egress Sink) immediately after the ws.send().await resolves, ensuring the metric records true terminal deliveries, not internal memory pushes.
  - Ensure CancellationToken is polled recursively inside all inner retry loops.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Create broadcast channel (capacity 1024).
  - Register metrics logger_active_connections and logger_events_processed_total.
  - Route WebSocket endpoint to upgraded handler.
  - Spawn WS server task on role ws-server.

---

## Track 7: Admin API

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role admin-api". It receives authenticated HTTP POST requests on path "/v1/admin/config". Appends configurations to ClickHouse alert_configs table and publishes updates to Redis Pub/Sub channel "admin:config_updates".
- **Data Schemas:**
  - AlertConfig Model
  - AdminConfigPayload Model
  - AdminError Variants
  - ConfigWriter Boundary Trait
- **Physical Constraints:**
  - ClickHouse alert_configs table must be a plain MergeTree engine.
  - Config table must be strictly append-only. No UPDATE or DELETE queries.
  - Redis Pub/Sub channel is fire-and-forget.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="admin", status="success" or "error")

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Admin API Configurations):**
  - Scenario 1: Admin updates threshold.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AdminWorld cucumber tests.
- **Step 2: Pure Logic:** Implement JWT claim checker verifying admin role.
- **Step 3: Infrastructure Adapters:** Connect reqwest HTTP client for ClickHouse config INSERT. Connect Redis client for PubSub.
- **Step 4: The Actor Loop:** Implement Axum POST handler orchestrating write and publish steps. Enforce Idempotent Cancellation: Use tokio_util::sync::CancellationToken polled recursively inside all inner retry loops (if any). Increment logger_events_processed_total OUTSIDE of infinite retry loops. Count the message, not the retry attempt.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate ClickHouse config writer and Redis pub client.
  - Register logger_events_processed_total metric.
  - Route POST handler.
  - Spawn Axum server when role is admin-api.
