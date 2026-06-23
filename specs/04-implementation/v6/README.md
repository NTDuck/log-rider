# Implementation Roadmap: Log Collection and Application Error Monitoring System (v6 Tracks)

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
  - IngestedLog Model:
    - timestamp: String (ISO 8601 formatted date-time string)
    - level: String (Allowed values: DEBUG, INFO, WARN, ERROR, CRITICAL)
    - message: String (Max length 32768)
    - app_name: String (Max length 255)
    - error_code: Option string (Deterministic string for alert bucketing, max length 255)
    - attributes: Vector of KeyValue objects (Raw nested array, max items 250)
  - KeyValue Helper Model:
    - key: String (Max length 255)
    - value: String (Flattened dot-notation value)
  - EdgeError Variants:
    - Unauthorized: Client JWT is missing or invalid.
    - Forbidden: Application name in payload is not present in JWT app grants list.
    - BadRequest: Payloads containing malformed JSON or nested depth exceeding 5 levels.
    - PayloadTooLarge: Payload size exceeds 256KB uncompressed.
    - KafkaProduceError: Internal failure when writing to Redpanda topic.
  - LogProducer Boundary Trait:
    - Method: produce(log: IngestedLog) -> Fallible Result containing success or a vector of EdgeError.
- **Physical Constraints:**
  - Must drop connections directly at the socket level if the body size exceeds 256KB.
  - Must validate JSON nesting depth iteratively without using recursive parser logic to protect against stack-overflow DoS vectors.
  - Depth limit is 5 levels.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Edge Receiver Ingestion):**
  - Scenario 1: Valid log payload is accepted.
    - Given a valid OTLP JSON payload with nested key-value arrays.
    - And the payload size is under 256KB.
    - And the nesting depth is under 5 levels.
    - And a JWT with app_grants containing the payload's app_name.
    - When it hits the Edge Receiver.
    - Then it MUST be authenticated, iteratively parsed, flattened, and proxied to logs-raw.
  - Scenario 2: Payload exceeds depth limit.
    - Given a log payload containing dynamic attributes with a nesting depth of 6.
    - When the Edge Receiver encounters the depth breach during iterative parsing.
    - Then it MUST fail-fast immediately with HTTP 400.
  - Scenario 3: Request payload exceeds maximum size limit.
    - Given a log payload with size exceeding 256KB.
    - When it is sent to the Edge Receiver.
    - Then it MUST be rejected with HTTP 413 Payload Too Large.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define the data models using bon builders. Implement the cucumber World and step definitions for the Edge Receiver features.
- **Step 2: Pure Logic:** Implement an iterative JSON validator checking payload depth (no recursion, max depth 5). Implement a stateless JWT validator checking app grants against app name.
- **Step 3: Infrastructure Adapters:** Implement the LogProducer boundary trait natively via rdkafka FutureProducer. Suffix the produce method with a tap error call that logs the failure and increments the metric logger_edge_errors_total to prevent early returns from bypassing telemetry.
- **Step 4: The Actor Loop:** Implement the Axum POST web handler.
  - Physical Socket Limits: Enforce a default body limit of 256 * 1024 bytes (axum::extract::DefaultBodyLimit::max) directly at the Axum router level to drop large stream payloads before they enter the parser.
  - Telemetry Bypass Prevention: The Axum handler must increment logger_edge_requests_total on success, and must use an explicit tap error or exhaustive match block to log server errors and increment logger_edge_errors_total on failure before any early-returns.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogProducer with the brokers configuration.
  - Configure the Axum Router mapping POST "/v1/logs" to the edge handler.
  - Apply the body limit layer to the route.
  - Register logger_edge_requests_total and logger_edge_errors_total to the Prometheus registry.
  - Check if role is edge, then spawn Axum server on port 8080.

---

## Track 2: Normalization Worker

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via the CLI role flag "--role normalization". It consumes messages from the Redpanda topic "logs-raw". It publishes normalized log payloads to the topic "logs-normalized", duplicates high-priority errors to "alerts-priority-stream", and routes malformed payloads to "logs-dlq".
- **Data Schemas:**
  - NormalizedLog Model:
    - log_id: Uuid (Generated UUID)
    - timestamp: String (ISO 8601 formatted date-time string)
    - level: String (Allowed values: DEBUG, INFO, WARN, ERROR, CRITICAL)
    - message: String (Redacted log message string)
    - app_name: String
    - error_code: Option string
    - attribute_keys: Vector of strings
    - attribute_values_string: Vector of strings
  - DLQEnvelope Model:
    - failed_at: String (ISO 8601 date-time string)
    - error_reason: String (Error description)
    - worker_id: String (Identifier of normalizer worker)
    - original_payload_truncated: String (First 2KB of the raw payload)
    - sha256_hash: String (SHA-256 hash of raw payload)
  - NormalizationError Variants:
    - PoisonPill: Payloads exceeding 64KB compressed or structured incorrectly.
    - RegexFailure: Errors during staticregex redaction.
    - ProduceError: Downstream publishing failures to topics.
  - LogConsumer Boundary Trait:
    - Method: consume() -> Fallible Result containing raw payload or NormalizationError vector.
    - Method: commit_offset() -> Fallible Result containing unit or NormalizationError vector.
  - NormalizedProducer Boundary Trait:
    - Method: produce_normalized(log: NormalizedLog) -> Fallible Result.
    - Method: produce_alert(log: NormalizedLog) -> Fallible Result.
    - Method: produce_dlq(envelope: DLQEnvelope) -> Fallible Result.
- **Physical Constraints:**
  - Must execute regex static compile PII check prior to producing.
  - Must wrap poison pills inside a DLQEnvelope, truncating original payload to 2KB to prevent memory/storage leak.
  - Redpanda logs-raw topic must have short retention (24 hours).

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Normalization Worker Processing):**
  - Scenario 1: Valid log is redacted and normalized.
    - Given a log in logs-raw with PII in message.
    - When the Normalization Worker consumes it.
    - Then it MUST statically run regex PII redaction.
    - And publish the redacted log to logs-normalized.
  - Scenario 2: High-priority error is duplicated.
    - Given a log in logs-raw with level ERROR or CRITICAL.
    - When consumed and redacted.
    - Then the worker MUST publish to logs-normalized and alerts-priority-stream.
  - Scenario 3: Poison pill is sent to DLQ.
    - Given a log in logs-raw exceeding 64KB compressed.
    - When the Normalization Worker consumes it.
    - Then it MUST wrap the error in DLQEnvelope, truncating the payload to 2KB.
    - And publish to logs-dlq.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define NormalizedLog and DLQEnvelope using bon builders. Implement the NormalizationWorld BDD steps.
- **Step 2: Pure Logic:** Compile PII regex patterns statically (using once_cell or lazy_static). Implement the flattener converting key-value maps to parallel vectors. Implement the DLQEnvelope builder which enforces the 2KB truncation on original payload.
- **Step 3: Infrastructure Adapters:** Connect rdkafka StreamConsumer and FutureProducer. Ensure offset commits only execute on the consumer AFTER downstream produce returns success.
- **Step 4: The Actor Loop:** Implement the consumer event loop.
  - Telemetry Bypass Prevention: Every downstream produce call must have an explicit tap error hook that logs the event and increments logger_dlq_events_total or logger_pii_redactions_total before executing the early return operator to prevent silent drops.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogConsumer and KafkaNormalizedProducer.
  - Register logger_dlq_events_total and logger_pii_redactions_total metrics.
  - Check role role normalization, then spawn the normalization loop task.

---

## Track 3: DB Writer

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via the CLI role flag "--role db-writer". It consumes normalized logs from the Redpanda topic "logs-normalized". It inserts them in batches to the ClickHouse table "logs".
- **Data Schemas:**
  - Input: NormalizedLog model (from Track 2).
  - DbWriterError Variants:
    - ConnectionDropped: ClickHouse analytical database is unreachable.
    - BatchTimeout: Insert batch timed out.
    - ConsumerError: Redpanda stream read failures.
  - ClickHouseWriter Boundary Trait:
    - Method: write_batch(batch: Slice of NormalizedLog) -> Fallible Result containing success or DbWriterError.
- **Physical Constraints:**
  - ClickHouse tables must run immutable INSERTs only. UPDATE or DELETE queries are forbidden.
  - Must write logs in buffers (triggered by row count limit or elapsed timer).
  - Commit offsets only on successful analytical write.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Database Batch Writer):**
  - Scenario 1: Batch of normalized logs is written to ClickHouse.
    - Given a batch of messages consumed from logs-normalized.
    - When the DB Writer processes the batch.
    - Then it MUST format an INSERT payload.
    - And write it to the ClickHouse logs table.
    - And commit Redpanda offsets only after successful DB write.
  - Scenario 2: ClickHouse is offline.
    - Given ClickHouse is unreachable.
    - When the DB Writer attempts to write a batch.
    - Then it MUST pause the rdkafka consumer stream.
    - And implement exponential backoff.
    - And MUST NOT commit Redpanda offsets.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define the DbWriterWorld state machine and BDD tests.
- **Step 2: Pure Logic:** Implement the buffer batch accumulator accumulating row limits (e.g., 1000 items) or timing thresholds (e.g., 5 seconds).
- **Step 3: Infrastructure Adapters:** Connect reqwest HTTP client to execute raw JSONEachRow ClickHouse SQL INSERT queries. Suffix the database call with a tap error handler mapping connection errors to DbWriterError.
- **Step 4: The Actor Loop:** Implement the database worker loop.
  - Kafka Physical Backpressure Mechanics: Before entering the tokio-retry exponential backoff DB retry loop, the agent MUST explicitly call consumer.pause(&partitions) to stop the consumer thread from buffering messages in memory during ClickHouse offline states. Call consumer.resume(&partitions) only after a successful INSERT batch transaction.
  - Telemetry Bypass Prevention: Attach tap error to write_batch calls to increment logger_ch_writes_error_total and log the error before using early return operators. Suffix successful writes with logger_ch_writes_success_total increments.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogConsumer on logs-normalized topic.
  - Instantiate ClickHouseNativeWriter with HTTP url.
  - Register logger_ch_writes_success_total and logger_ch_writes_error_total metrics.
  - Check role role db-writer, then spawn the event loop task.

---

## Track 4: AI Consumer

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role ai-consumer". It consumes logs from the Redpanda topic "logs-normalized". It inserts tags to ClickHouse sidecar table "log_ai_tags" and publishes updates to "ai-tags-stream" topic.
- **Data Schemas:**
  - AITag Model:
    - log_id: Uuid
    - model_version: String
    - tag: String
    - confidence: Float32
  - AIError Variants:
    - InferenceError: Failure during ONNX model runtime.
    - SidecarWriteError: ClickHouse tag insert failure.
    - StreamPublishError: Failure producing tag patches.
    - ConsumerError: Redpanda stream consume failures.
  - AIClassifier Boundary Trait:
    - Method: classify(message: str) -> Fallible Result containing AITag or AIError vector.
  - SidecarWriter Boundary Trait:
    - Method: write_tag(tag: AITag) -> Fallible Result.
    - Method: publish_patch(tag: AITag) -> Fallible Result.
- **Physical Constraints:**
  - Relational JOINs or IN filters on UUIDs on the primary logs table are strictly forbidden. System must store tags in the log_ai_tags sidecar.
  - ONNX model inference must run asynchronously.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (AI Consumer Classification):**
  - Scenario 1: Log is classified and sidecar stored.
    - Given a log payload published to logs-normalized.
    - When the AI Consumer extracts the message body.
    - Then it MUST run its ONNX model.
    - And write the output tag to log_ai_tags sidecar table.
    - And publish a patch to ai-tags-stream.
  - Scenario 2: ClickHouse sidecar is offline.
    - Given the ClickHouse sidecar table is unreachable.
    - When the AI Consumer attempts to write the tag.
    - Then it MUST pause the rdkafka stream.
    - And implement exponential backoff/retry.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AIWorld BDD steps.
- **Step 2: Pure Logic:** Extract message text from NormalizedLog. Parse model output metrics.
- **Step 3: Infrastructure Adapters:** Initialize ONNX classification runtime using ort framework. Build reqwest HTTP writer for sidecar inserts, and rdkafka producer for tag streaming.
- **Step 4: The Actor Loop:** Implement the classification consumer loop.
  - Kafka Physical Backpressure Mechanics: Explicitly invoke consumer.pause(&partitions) prior to starting database write retry loops to prevent memory bloat, resuming offset consumption after successful writes.
  - Telemetry Bypass Prevention: Enforce tap error handlers logging errors and incrementing logger_ai_sidecar_error_total before returning.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogConsumer, OnnxClassifier, and CombinedSidecarWriter.
  - Register metrics logger_ai_inference_success_total and logger_ai_sidecar_error_total.
  - Spawn AI run loop on CLI role ai-consumer match.

---

## Track 5: Alert Consumer

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role alert-consumer". It consumes logs from Redpanda topic "alerts-priority-stream". It connects to Redis for deduplication and token buckets, and sends notifications to Telegram API.
- **Data Schemas:**
  - AlertConfig Model:
    - threshold: U64
    - window_seconds: U64
  - AlertError Variants:
    - RedisError: Connection or query issues with rate limits.
    - TelegramError: Rate limits or request rejections from Telegram API.
    - ConsumerError: Consumer stream failures.
  - RateLimiter Boundary Trait:
    - Method: check_and_increment(fingerprint: str, window_sec: U64, limit: U64, strict_ttl: U64) -> Fallible Result containing boolean or AlertError vector.
  - AlertNotifier Boundary Trait:
    - Method: notify(message: str) -> Fallible Result.
  - ConfigSubscriber Boundary Trait:
    - Method: listen_for_updates() -> Receiver for dynamic AlertConfig objects.
- **Physical Constraints:**
  - Must run Lua Token Bucket rate limit scripts to protect Telegram API.
  - Must write keys to Redis using a strict TTL/eviction constraint to prevent infinite Redis memory growth.
  - Lose of ephemeral counting state on Redis crash is acceptable to protect the primary ingestion loop.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Alert Tumbling Window & Notifications):**
  - Scenario 1: High-priority errors are deduplicated safely and limited.
    - Given a threshold configuration of 100 errors per 60 seconds.
    - When 150 errors with matching fingerprints are consumed.
    - Then the Alert Consumer MUST deduplicate them using Redis.
    - And apply a strict TTL to the tracking structures to prevent OOM.
    - And apply a Lua Token Bucket rate limit.
    - And fire exactly 1 notification to Telegram.
  - Scenario 2: Admin dynamically updates configurations.
    - Given the Alert Consumer is running.
    - When a configuration update is broadcast via Redis Pub/Sub.
    - Then the Alert Consumer MUST update its internal window and threshold limits in real-time.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AlertWorld cucumber tests.
- **Step 2: Pure Logic:** Implement SHA-256 fingerprint generation. Implement thread-safe RwLock cache for config storage.
- **Step 3: Infrastructure Adapters:** Build Redis adapters for Lua token bucket execution. Build Telegram HTTP notifier. Build Redis Pub/Sub subscriber listener.
- **Step 4: The Actor Loops:**
  - Config Listener Task:
    - Resilient Socket Mechanics: Wrap the Redis Pub/Sub configuration subscription thread in an infinite loop containing sleep reconnections to prevent config update stalls.
  - Event Processor Task: Consume from alerts-priority-stream, pull configuration limits from RwLock, perform Redis O(1) deduplication check, execute Lua Token Bucket rate check, send Telegram alerts.
  - Telemetry Bypass Prevention: Use tap error or match blocks on all rate limiter and notifier calls to increment logger_alert_errors_total and log errors before early return operators. Suffix fires with logger_alerts_fired_total increments.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogConsumer, RedisRateLimiter, TelegramNotifier, and RedisConfigSubscriber.
  - Setup RwLock wrapping default AlertConfig (e.g., limit 100, window 60).
  - Register metrics logger_alerts_fired_total and logger_alert_errors_total.
  - Spawn config_loop and run_loop when role is alert-consumer.

---

## Track 6: WebSocket Server

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role ws-server". It consumes from the Redpanda topic "logs-normalized" and broadcasts logs to connected WebSocket viewer clients.
- **Data Schemas:**
  - WsClientConfig Model:
    - allowed_apps: Vector of strings
    - is_admin: Boolean (True if wildcard grant is found)
  - WSError Variants:
    - InvalidToken: Handshake JWT validation failures.
    - ConnectionDropped: Network disconnect from client side.
    - LaggingClient: WS client lagging behind broadcast channel.
    - ConsumerError: Kafka stream consumer failures.
- **Physical Constraints:**
  - Broadcast Consumer Pattern: Ingestion loop must produce logs to a shared bounded memory channel.
  - Client sessions must pull from memory channels. No database queries during streaming.
  - Bounded memory channel must use capacity limit (max 1024) to enforce backpressure.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (WebSocket Viewer):**
  - Scenario 1: Client receives authorized logs.
    - Given a client requests a WebSocket connection passing a cryptographically valid JWT containing app_grants: ["payment-api"].
    - When logs flow through logs-normalized.
    - Then the client MUST receive logs only for payment-api.
  - Scenario 2: Admin client receives all logs.
    - Given an admin client connects with app_grants: ["*"].
    - Then the client MUST receive all logs.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup WSWorld BDD testing.
- **Step 2: Pure Logic:** Implement JWT claim parser and app grant filter.
- **Step 3: Infrastructure Adapters:** Connect Axum WebSocket framework handler.
- **Step 4: The Event Loops:**
  - Ingestion Loop: Consumes from logs-normalized, pushing logs to a bounded broadcast channel: tokio::sync::broadcast::channel(1024).
  - Session Loops: Run one thread per socket client, subscribing to broadcast channel, matching against AllowedApps, and pushing over WebSocket.
  - Telemetry Bypass Prevention: Handshake and message loop failures must trigger logger_ws_dropped_total increments via tap error or exhaustive match statements. Suffix sessions with logger_ws_connections_active tracking.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Create the bounded broadcast channel (size 1024).
  - Setup KafkaLogConsumer.
  - Register metrics logger_ws_connections_active and logger_ws_dropped_total.
  - Route WebSocket upgrades on "/v1/ws" with state.
  - Spawn WS server task on role ws-server.

---

## Track 7: Admin API

### Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role admin-api". It receives POST updates on "/v1/admin/config" (JWT authorization required). It appends config updates to ClickHouse table "alert_configs" and publishes notifications via Redis Pub/Sub.
- **Data Schemas:**
  - Input payload: AlertConfig model (config_id, threshold, window_seconds, created_at).
  - AdminError Variants:
    - Unauthorized: Missing admin claim in JWT token.
    - WriteFailed: ClickHouse analytical write failures.
    - BroadcastFailed: Redis Pub/Sub publishing failures.
  - ConfigWriter Boundary Trait:
    - Method: append_config(config: AlertConfig) -> Fallible Result containing success or AdminError.
    - Method: publish_update_event(config: AlertConfig) -> Fallible Result.
- **Physical Constraints:**
  - ReplacingMergeTree or mutable updates inside ClickHouse analytical store are forbidden. The config table must be strictly append-only MergeTree.

### Phase 2: The Behavioral Specification
- **The Gherkin Feature (Admin API Configurations):**
  - Scenario 1: Admin updates threshold configuration.
    - Given an Admin user authenticated with JWT.
    - When they submit a new alert configuration.
    - Then the system MUST append the config to the MergeTree table.
    - And publish an update event via Redis Pub/Sub.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

### Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AdminWorld cucumber features.
- **Step 2: Pure Logic:** Implement admin JWT claim checking.
- **Step 3: Infrastructure Adapters:** Connect reqwest HTTP client to execute ClickHouse config writes. Build Redis client for PubSub.
- **Step 4: The Actor Loop:** Implement the Axum POST handler orchestrating config updates.
  - Telemetry Bypass Prevention: Suffix append_config and publish_update_event calls with tap error hooks logging errors and incrementing logger_admin_config_errors_total to prevent silent failure returns. Suffix success with logger_admin_config_writes_total increments.

### Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate AdminConfigWriter client.
  - Setup Axum Router on "/v1/admin/config" pointing to handler.
  - Register metrics logger_admin_config_writes_total and logger_admin_config_errors_total.
  - Spawn Admin API server task when role is admin-api.
