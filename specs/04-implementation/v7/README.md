# Implementation Roadmap: Log Collection and Application Error Monitoring System (v7 Tracks)

This document outlines the highly programmatic, execution-oriented roadmap consisting of seven independent implementation tracks using the 4-Phase Execution Ledger structure.

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
  - Wire Model (WireLog) - HTTP Boundary:
    - timestamp: String (ISO 8601 formatted date-time string)
    - level: String (Allowed values: DEBUG, INFO, WARN, ERROR, CRITICAL)
    - message: String (Max length 32768)
    - app_name: String (Max length 255)
    - error_code: Option string (Deterministic string for alert bucketing, max length 255)
    - attributes: Option serde_json::Value (Raw, unvalidated JSON - accepts any nested structure without type coercion)
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
  - Must validate JSON nesting depth iteratively using an explicit stack (vector) - never recursion - to protect against stack-overflow DoS vectors.
  - Depth limit is 5 levels. A depth breach produces an immediate HTTP 400.
  - Wire-to-Domain Decoupling: Wire model accepts raw nested JSON attributes. Domain model stores flattened parallel arrays.
- **Closed-World Telemetry Contract:**
  - logger_ingest_bytes_total (Counter): Total raw bytes ingested, incremented immediately after socket extraction.
  - logger_events_processed_total (Counter, labels: stage="edge", status="success" or "error"): Incremented exactly once at the handler's exit.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Edge Receiver Ingestion):**
  - Scenario 1: Valid log payload is accepted and flattened.
    - Given a valid OTLP JSON payload with nested key-value attributes at depth 3.
    - And the payload size is under 256KB.
    - And a JWT with app_grants containing the payload's app_name.
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST respond with HTTP 202.
    - And the payload MUST be iteratively parsed, flattened to dot-notation parallel arrays, and produced to logs-raw as a DomainLog.
  - Scenario 2: Payload exceeds depth limit.
    - Given a log payload containing attributes with a nesting depth of 6.
    - And a valid JWT.
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST fail-fast immediately with HTTP 400.
  - Scenario 3: Request payload exceeds maximum size limit.
    - Given a log payload with size exceeding 256KB.
    - When it is sent to the Edge Receiver.
    - Then it MUST be rejected with HTTP 413 Payload Too Large.
  - Scenario 4: JWT is missing or invalid.
    - Given a request with no Authorization header (or an expired/malformed JWT).
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST respond with HTTP 401 Unauthorized.
  - Scenario 5: App name not in JWT grants.
    - Given a valid JWT with app_grants containing only "payment-api".
    - And a payload with app_name "auth-service".
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST respond with HTTP 403 Forbidden.
  - Scenario 6: Wildcard JWT grant allows any app_name.
    - Given a valid JWT with app_grants containing "*".
    - And a payload with any arbitrary app_name.
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST respond with HTTP 202.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define WireLog with Deserialize. Define DomainLog with Serialize and bon builder. Define EdgeError enum with axiom Erratum. Define JwtClaims struct. Implement cucumber EdgeWorld and step definitions. Run tests and verify they fail.
- **Step 2: Pure Logic:**
  - Iterative JSON flattener and depth validator: Allocate an explicit stack vector containing prefixes, values, and depths. In a while-let loop, check depth limit of 5. For objects, push children on stack with dot-notation prefixes. For arrays, push index keys. For leaves, stringify and push to keys/values parallel arrays. Recursion is forbidden.
  - Stateless JWT validator: Use jsonwebtoken to validate token using public key. Check expiration and claims. Apply tap_err with tracing::error.
  - App name grant checker: Verify app_name is in app_grants or wildcard "*" is present.
- **Step 3: Infrastructure Adapters:** Implement KafkaLogProducer wrapping rdkafka FutureProducer. async produce method must serialize DomainLog to bytes, produce to topic "logs-raw" using app_name as partition key. Method must carry #[tracing::instrument(skip_all)]. Apply tap_err to log errors with tracing::error before propagating. Suffix success with tracing::debug.
- **Step 4: The Actor Loop:** Implement the Axum POST handler.
  - Read request body as Bytes first. Measure length and increment logger_ingest_bytes_total.
  - Validate JWT. On error, tap_err, increment logger_events_processed_total{stage="edge", status="error"}, return HTTP 401.
  - Deserialize Bytes to WireLog. On error, tap_err, increment logger_events_processed_total{stage="edge", status="error"}, return HTTP 400.
  - Validate level enum, app_name length, message length, and error_code length. On error, increment logger_events_processed_total{stage="edge", status="error"}, return HTTP 400.
  - Check grants. On error, increment logger_events_processed_total{stage="edge", status="error"}, return HTTP 403.
  - Perform iterative flattening. On depth breach, increment logger_events_processed_total{stage="edge", status="error"}, return HTTP 400.
  - Build DomainLog using bon builder.
  - Call KafkaLogProducer produce. On failure, increment logger_events_processed_total{stage="edge", status="error"}, return HTTP 502.
  - On success, increment logger_events_processed_total{stage="edge", status="success"}, emit tracing::debug, return HTTP 202.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogProducer.
  - Register logger_ingest_bytes_total and logger_events_processed_total in the Prometheus registry.
  - Setup Axum Router. Apply DefaultBodyLimit layer of 256KB to enforce the limit at the socket level.
  - Check if role is edge, spawn Axum server on port 8080.
  - Wrap launch sequence in tracing instrumented span.

---

## Track 2: Normalization Worker

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role normalization". It consumes messages from Redpanda topic "logs-raw". It publishes normalized log payloads to the topic "logs-normalized", duplicates high-priority error/critical logs to "alerts-priority-stream" (only post-redaction), and routes poison pills to "logs-dlq".
- **Data Schemas:**
  - NormalizedLog Model:
    - log_id: UUID
    - timestamp: String (ISO 8601 formatted date-time string)
    - level: String (Allowed values: DEBUG, INFO, WARN, ERROR, CRITICAL)
    - message: String (PII-redacted message)
    - app_name: String
    - error_code: Option string
    - attribute_keys: Vector of strings
    - attribute_values_string: Vector of strings
  - DLQEnvelope Model:
    - failed_at: String (ISO 8601 date-time string)
    - error_reason: String (Error description)
    - worker_id: String (Normalization worker identifier)
    - original_payload_truncated: String (First 2048 bytes of raw payload, sliced safely to nearest valid UTF-8 boundary)
    - sha256_hash: String (SHA-256 hex digest of full original payload)
  - NormalizationError Variants:
    - PoisonPill: Payloads exceeding 64KB compressed or undeserializable.
    - RegexFailure: Errors during regex execution.
    - SerializationError: JSON serialization failure.
    - ProduceError: Kafka produce failures.
  - LogConsumer Boundary Trait:
    - Method: consume() -> Fallible Result of raw payload bytes and message metadata or NormalizationError.
    - Method: commit_offset() -> Fallible Result.
  - NormalizedProducer Boundary Trait:
    - Method: produce_normalized(log: NormalizedLog) -> Fallible Result.
    - Method: produce_alert(log: NormalizedLog) -> Fallible Result.
    - Method: produce_dlq(envelope: DLQEnvelope) -> Fallible Result.
- **Physical Constraints:**
  - Execute statically compiled PII regex check and redaction before alert duplication or normal ingestion.
  - Wrap poison pills in DLQEnvelope, truncating original payload to 2KB to prevent memory/storage leak.
  - Redpanda logs-raw topic must have short retention of 24 hours.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="normalization", status="success" or "error")
  - logger_dlq_routed_total (Counter)
  - logger_pii_redactions_total (Counter)

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Normalization Worker Processing):**
  - Scenario 1: Valid log is PII-redacted and normalized.
    - Given a log message in logs-raw containing PII patterns.
    - When the Normalization Worker processes it.
    - Then the worker MUST apply compiled PII regex patterns to the message field.
    - And increment logger_pii_redactions_total for each regex hit.
    - And publish the redacted NormalizedLog to logs-normalized.
    - And commit offset only after successful produce.
  - Scenario 2: High-priority error is duplicated.
    - Given a log message in logs-raw with level ERROR or CRITICAL.
    - When consumed and processed.
    - Then the worker MUST publish to logs-normalized and alerts-priority-stream.
  - Scenario 3: Poison pill is sent to DLQ.
    - Given a raw payload in logs-raw exceeding 64KB compressed or failing deserialization.
    - When consumed.
    - Then it MUST build a DLQEnvelope with truncated payload to 2048 bytes.
    - And publish to logs-dlq.
    - And increment logger_dlq_routed_total.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define NormalizedLog and DLQEnvelope using bon builders. Define NormalizationError enum. Implement NormalizationWorld BDD cucumber tests and verify they fail.
- **Step 2: Pure Logic:**
  - PII Regex Engine: Compile regex patterns (emails, credit cards, SSNs) statically using std::sync::LazyLock. Implement redact_pii function that replaces matches with "[REDACTED]" and returns count of hits.
  - Parallel Array Flattener: Passthrough flattened keys/values from DomainLog.
  - DLQ Envelope Builder: Enforce 2048 bytes truncation using char indices to find valid UTF-8 boundaries. Compute SHA-256 hash.
- **Step 3: Infrastructure Adapters:** Connect rdkafka StreamConsumer and FutureProducer. Commit offsets only after downstream produce calls return success. Async I/O methods must use #[tracing::instrument(skip_all)] and tap_err for logging.
- **Step 4: The Actor Loop:** Implement consumer loop matching on consumed message. Handle decompression, size checks, deserialization. Suffix success and failure with metric increments and tracing logs.

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
  - Input: NormalizedLog model (from Track 2).
  - DbWriterError Variants:
    - ConnectionDropped: ClickHouse database is unreachable.
    - BatchInsertFailed: ClickHouse HTTP POST returned non-success status.
    - DeserializationError: Message failed deserialization.
    - ConsumerError: Stream read failures.
  - ClickHouseWriter Boundary Trait:
    - Method: write_batch(batch: Slice of NormalizedLog) -> Fallible Result.
- **Physical Constraints:**
  - ClickHouse tables accept immutable INSERTs only. UPDATE or DELETE queries are forbidden.
  - Batch writes by row count (1000 items) or timer (5 seconds), whichever comes first.
  - Commit offsets only on successful DB write.
  - Kafka backpressure: pause partition consumption during DB retries, resume after success.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="db_writer", status="success" or "error")

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Database Batch Writer):**
  - Scenario 1: Batch of normalized logs is written to ClickHouse.
    - Given a batch of messages consumed from logs-normalized.
    - When the DB Writer batch accumulator reaches the row count threshold (1000) or 5 seconds elapse.
    - Then it MUST write the batch as JSONEachRow to the ClickHouse logs table.
    - And commit Redpanda offsets only after successful DB write.
  - Scenario 2: ClickHouse is offline.
    - Given ClickHouse is unreachable.
    - When DB Writer attempts to write a batch.
    - Then it MUST pause the consumer partitions.
    - And enter an exponential backoff retry loop.
    - And resume partition consumption only after successful insert.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup DbWriterWorld cucumber tests and verify they fail.
- **Step 2: Pure Logic:** Implement buffer accumulator that groups items and triggers on limit or timeout.
- **Step 3: Infrastructure Adapters:** Connect reqwest HTTP client to execute ClickHouse HTTP POST writes to the logs table using JSONEachRow format. Suffix writes with tap_err for tracing error logs. Annotate methods with #[tracing::instrument(skip_all)].
- **Step 4: The Actor Loop:** Implement the writer consumer loop. Enforce backpressure mechanics: call consumer.pause(&partitions) prior to starting database retry loops, and consumer.resume(&partitions) after successful batch write.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate Kafka consumer and ClickHouse HTTP writer.
  - Register logger_events_processed_total metric.
  - Spawn DB writer event loop when role is db-writer.

---

## Track 4: AI Consumer

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role ai-consumer". It consumes from topic "logs-normalized". It inserts classification tags to ClickHouse sidecar table "log_ai_tags" and publishes updates to "ai-tags-stream" topic.
- **Data Schemas:**
  - AITag Model:
    - log_id: UUID
    - model_version: String
    - tag: String
    - confidence: f32
    - tagged_at: DateTime64
  - AIError Variants:
    - InferenceError: ONNX model runtime failures.
    - SidecarWriteError: ClickHouse insert failures.
    - StreamPublishError: Kafka produce failures.
    - ConsumerError: Consumer stream failures.
  - AIClassifier Boundary Trait:
    - Method: classify(message: str) -> Fallible Result containing AITag or AIError.
  - SidecarWriter Boundary Trait:
    - Method: write_tag(tag: AITag) -> Fallible Result.
  - TagStreamPublisher Boundary Trait:
    - Method: publish_patch(tag: AITag) -> Fallible Result.
- **Physical Constraints:**
  - Relational JOINs and IN(UUID) filtering on the primary logs table are strictly forbidden. System must store tags in the log_ai_tags sidecar.
  - Sidecar queries must resolve via ClickHouse Dictionaries.
  - ONNX inference must run asynchronously using tokio::task::spawn_blocking.
  - Kafka backpressure: pause consumption during ClickHouse sidecar offline states, resume on success.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="ai_consumer", status="success" or "error")

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (AI Consumer Classification):**
  - Scenario 1: Log is classified and sidecar stored.
    - Given a log payload consumed from logs-normalized.
    - When the AI Consumer runs the ONNX model.
    - Then it MUST write the tag to log_ai_tags sidecar table.
    - And publish a patch to ai-tags-stream.
  - Scenario 2: ClickHouse sidecar is offline.
    - Given the ClickHouse sidecar table is unreachable.
    - When the AI Consumer attempts to write the tag.
    - Then it MUST pause the consumer stream.
    - And enter an exponential backoff retry loop.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AIWorld cucumber BDD tests and verify they fail.
- **Step 2: Pure Logic:** Extract message text. Parse confidence scores.
- **Step 3: Infrastructure Adapters:** Initialize ONNX runtime session via ort crate. Build reqwest HTTP writer for sidecar writes. Build rdkafka FutureProducer for ai-tags-stream. Methods must carry #[tracing::instrument(skip_all)] and tap_err for errors.
- **Step 4: The Actor Loop:** Implement classification loop. Spawn ort session in spawn_blocking. Apply backpressure: consumer.pause(&partitions) and consumer.resume(&partitions).

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate Kafka consumer, ONNX classifier, and sidecar writer.
  - Register logger_events_processed_total metric.
  - Spawn AI consumer loop when role is ai-consumer.

---

## Track 5: Alert Consumer

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role alert-consumer". It consumes from topic "alerts-priority-stream". It connects to Redis for deduplication and token buckets, and sends notifications to Telegram Bot API. It subscribes to Redis Pub/Sub channel "admin:config_updates" for config updates.
- **Data Schemas:**
  - AlertConfig Model:
    - config_id: UUID
    - threshold: u64
    - window_seconds: u64
    - created_at: String
  - AlertError Variants:
    - RedisError: Redis connection or Lua script failures.
    - TelegramError: Telegram API failures.
    - ConsumerError: Consumer stream failures.
    - ConfigSubscriptionError: Redis Pub/Sub connection failures.
  - RateLimiter Boundary Trait:
    - Method: check_and_increment(fingerprint: str, window_sec: u64, limit: u64, strict_ttl: u64) -> Fallible Result containing boolean or AlertError.
  - AlertNotifier Boundary Trait:
    - Method: notify(message: str) -> Fallible Result.
  - ConfigSubscriber Boundary Trait:
    - Method: subscribe() -> Fallible Result containing a receiver of AlertConfig.
- **Physical Constraints:**
  - Must run Lua Token Bucket script atomically in EVAL script.
  - Must write keys to Redis using a strict TTL (window_seconds + 10) to prevent infinite Redis memory growth.
  - Redis crash state amnesia is accepted. Synchronous DB polling to reconstruct state is forbidden.
  - Telegram token MUST be injected via TELEGRAM_BOT_TOKEN env variable.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="alert", status="success" or "error")
  - logger_alerts_fired_total (Counter)

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Alert Tumbling Window & Notifications):**
  - Scenario 1: High-priority errors are deduplicated and limited.
    - Given a threshold configuration of 100 errors per 60 seconds.
    - When 150 errors with matching fingerprints are consumed.
    - Then the Alert Consumer MUST deduplicate them using Redis Lua script.
    - And apply a strict TTL of window_seconds + 10.
    - And fire exactly 1 Telegram notification.
  - Scenario 2: Dynamic config update.
    - Given Alert Consumer is running.
    - When a config update is broadcast via Redis Pub/Sub.
    - Then Alert Consumer MUST hot-reload thresholds.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AlertWorld cucumber tests and verify they fail.
- **Step 2: Pure Logic:** Compute SHA-256 fingerprint from log message, app_name, and level. Implement config cache storage wrapping AlertConfig in RwLock.
- **Step 3: Infrastructure Adapters:** Build Redis Lua script execution wrapper. Build Telegram HTTP notifier client. Build Redis Pub/Sub channel listener. Apply #[tracing::instrument(skip_all)] and tap_err.
- **Step 4: The Actor Loops:**
  - Config Listener Loop: Subscribe to Redis channel, deserializing configurations and updating RwLock cache. Wrap in retry loop to handle socket drops.
  - Event Processor Loop: Consume alerts, compute fingerprint, evaluate rate limit, notify Telegram.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate Kafka consumer, RedisRateLimiter, TelegramNotifier, and RedisConfigSubscriber.
  - Register metrics logger_events_processed_total and logger_alerts_fired_total.
  - Spawn listener loops when role is alert-consumer.

---

## Track 6: WebSocket Server

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role ws-server". It consumes from logs-normalized and broadcasts logs to WebSocket viewer clients.
- **Data Schemas:**
  - WsClientConfig Model:
    - allowed_apps: Vector of strings
    - is_admin: Boolean (true if wildcard grant is found)
  - BroadcastMessage Model:
    - app_name: String
    - payload: String (NormalizedLog JSON)
  - WSError Variants:
    - InvalidToken: JWT validation failures (maps to HTTP 401).
    - Forbidden: JWT has no grants (maps to HTTP 403).
    - ConnectionDropped: Client disconnected.
    - LaggingClient: WS client fell behind broadcast channel capacity.
    - SendFailure: WebSocket send failures.
    - ConsumerError: Kafka consumer failures.
- **Physical Constraints:**
  - Broadcast Consumer Pattern: Ingestion loop consumes from Kafka and pushes to shared bounded memory channel. Client tasks subscribe to channel.
  - Bounded memory channel capacity MUST be exactly 1024.
  - Zero database queries: No ClickHouse or Redis queries allowed.
  - Stateless RBAC: Validated in-memory via shared public keys.
- **Closed-World Telemetry Contract:**
  - logger_active_connections (Gauge): Number of active WebSocket connections.
  - logger_events_processed_total (labels: stage="ws", status="success" or "error")

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (WebSocket Viewer):**
  - Scenario 1: Client receives authorized logs.
    - Given a client upgraded WebSocket with JWT query parameter containing app_grants: ["payment-api"].
    - When logs flow through broadcast channel.
    - Then client MUST receive logs only for payment-api.
  - Scenario 2: Wildcard client receives all logs.
    - Given client upgraded WebSocket with JWT app_grants: ["*"].
    - When logs flow.
    - Then client MUST receive all logs.
  - Scenario 3: Lagging client is closed.
    - Given client stops reading.
    - When broadcast channel returns Lagged.
    - Then the server MUST close connection.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup WSWorld cucumber tests and verify they fail.
- **Step 2: Pure Logic:** Implement JWT claim checker and app_name filter matching allowed_apps.
- **Step 3: Infrastructure Adapters:** Connect Axum WebSocket handler. Wrap async I/O in #[tracing::instrument(skip_all)] and tap_err.
- **Step 4: The Event Loops:**
  - Ingestion Loop: Consumes from logs-normalized, pushing into bounded broadcast channel of capacity 1024.
  - Session Loop: Upgraded client WebSocket tasks, subscribing to broadcast, filtering messages by app_name, sending to client. Suffix with active connections increment/decrement and handle Lagged errors.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Create broadcast channel (capacity 1024).
  - Register metrics logger_active_connections and logger_events_processed_total.
  - Route WebSocket endpoint to upgraded handler.
  - Spawn WS server task on role ws-server.

---

## Track 7: Admin API

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role admin-api". It receives authenticated HTTP POST requests on path "/v1/admin/config". It appends configurations to ClickHouse alert_configs table and publishes updates to Redis Pub/Sub channel "admin:config_updates".
- **Data Schemas:**
  - AlertConfig Model:
    - config_id: UUID
    - threshold: u64
    - window_seconds: u64
    - created_at: String
  - AdminConfigPayload Model:
    - threshold: u64
    - window_seconds: u64
  - AdminError Variants:
    - Unauthorized: JWT missing, expired, or missing admin role.
    - InvalidPayload: Body fails parsing.
    - WriteFailed: ClickHouse INSERT returned non-success.
    - BroadcastFailed: Redis PUBLISH failed.
  - ConfigWriter Boundary Trait:
    - Method: append_config(config: AlertConfig) -> Fallible Result.
    - Method: publish_update_event(config: AlertConfig) -> Fallible Result.
- **Physical Constraints:**
  - ClickHouse alert_configs table must be a plain MergeTree engine. ReplacingMergeTree is forbidden.
  - Config table must be strictly append-only. No UPDATE or DELETE queries.
  - Redis Pub/Sub channel is fire-and-forget.
- **Closed-World Telemetry Contract:**
  - logger_events_processed_total (labels: stage="admin", status="success" or "error")

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Admin API Configurations):**
  - Scenario 1: Admin updates threshold.
    - Given Admin authenticated with valid JWT.
    - When POST config payload to "/v1/admin/config".
    - Then system MUST generate UUID and timestamp.
    - And append to ClickHouse alert_configs.
    - And publish update to Redis Pub/Sub.
    - And respond HTTP 201.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AdminWorld cucumber tests and verify they fail.
- **Step 2: Pure Logic:** Implement JWT claim checker verifying admin role.
- **Step 3: Infrastructure Adapters:** Connect reqwest HTTP client for ClickHouse config INSERT. Connect Redis client for PubSub. Wrap methods in #[tracing::instrument(skip_all)] and tap_err.
- **Step 4: The Actor Loop:** Implement Axum POST handler orchestrating write and publish steps.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate ClickHouse config writer and Redis pub client.
  - Register logger_events_processed_total metric.
  - Route POST handler.
  - Spawn Axum server when role is admin-api.
