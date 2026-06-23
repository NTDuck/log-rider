# Track 2: Normalization Worker

## Phase 1: The Domain & Contracts

- **Trigger & Topology:** Activated via the CLI role flag "--role normalization". It consumes messages from the Redpanda topic "logs-raw". It publishes normalized log payloads to the topic "logs-normalized", duplicates high-priority error/critical logs to "alerts-priority-stream" (only after PII redaction is complete), and routes poison-pill payloads to "logs-dlq".
- **Data Schemas:**
  - NormalizedLog Model:
    - log_id: Uuid (Generated via Uuid::new_v4)
    - timestamp: String (ISO 8601 formatted date-time string)
    - level: String (Allowed values: DEBUG, INFO, WARN, ERROR, CRITICAL)
    - message: String (PII-redacted log message string)
    - app_name: String
    - error_code: Option of String (Deterministic string for alert bucketing)
    - attribute_keys: Vector of Strings (Dot-notation flattened keys from upstream WireLog attributes)
    - attribute_values_string: Vector of Strings (Corresponding string values, positionally aligned with attribute_keys)
  - DLQEnvelope Model:
    - failed_at: String (ISO 8601 date-time string, generated at the moment of envelope construction)
    - error_reason: String (Human-readable error description)
    - worker_id: String (Identifier of the normalization worker instance, sourced from config or hostname)
    - original_payload_truncated: String (First 2048 bytes of the raw payload; the builder MUST enforce this ceiling by slicing the raw bytes to the nearest valid UTF-8 boundary at or below 2048)
    - sha256_hash: String (SHA-256 hex digest computed over the ENTIRE original raw payload bytes, before truncation)
  - NormalizationError Variants:
    - PoisonPill: Payloads exceeding 64KB compressed, or structurally undeserializable after decompression.
    - RegexFailure: Errors during compiled regex PII redaction execution.
    - SerializationError: Failure to serialize NormalizedLog or DLQEnvelope to bytes for Kafka produce.
    - ProduceError: Downstream publishing failures to any of the three output topics.
  - LogConsumer Boundary Trait:
    - Method: consume() -> Fallible Result containing a tuple of (raw payload bytes as Vec of u8, borrowed BorrowedMessage metadata) or NormalizationError.
    - Method: commit_offset(message metadata) -> Fallible Result containing unit or NormalizationError.
  - NormalizedProducer Boundary Trait:
    - Method: produce_normalized(log: NormalizedLog) -> Fallible Result containing unit or NormalizationError.
    - Method: produce_alert(log: NormalizedLog) -> Fallible Result containing unit or NormalizationError.
    - Method: produce_dlq(envelope: DLQEnvelope) -> Fallible Result containing unit or NormalizationError.
- **Physical Constraints:**
  - Must execute statically compiled regex PII redaction on the message field BEFORE any duplication to alerts-priority-stream.
  - Must wrap poison pills inside a DLQEnvelope, enforcing the 2048-byte truncation on original_payload_truncated via UTF-8 boundary-safe slicing.
  - Consumer group ID must be deterministic and unique to normalization (e.g., "normalization-cg").
  - Redpanda logs-raw topic must have short retention (retention.ms=86400000, 24 hours) per FR-002.

## Phase 2: The Behavioral Specification

- **The Gherkin Feature (Normalization Worker Processing):**
  - Scenario 1: Valid log is PII-redacted and normalized.
    - Given a log message in logs-raw containing PII patterns (e.g., email addresses, credit card numbers).
    - When the Normalization Worker consumes and processes it.
    - Then the worker MUST apply all compiled PII regex patterns to the message field.
    - And increment logger_pii_redactions_total for each regex hit.
    - And publish the redacted NormalizedLog to logs-normalized.
    - And increment logger_events_processed_total with labels stage="normalization" and status="success".
    - And commit the consumer offset only after the produce to logs-normalized returns success.
  - Scenario 2: High-priority error is duplicated post-redaction.
    - Given a log message in logs-raw with level ERROR.
    - When the Normalization Worker consumes, PII-redacts, and normalizes it.
    - Then the worker MUST publish the redacted NormalizedLog to logs-normalized.
    - And MUST publish the same redacted NormalizedLog to alerts-priority-stream.
    - And commit the consumer offset only after both produces return success.
  - Scenario 3: High-priority critical is duplicated post-redaction.
    - Given a log message in logs-raw with level CRITICAL.
    - When the Normalization Worker consumes, PII-redacts, and normalizes it.
    - Then the worker MUST publish the redacted NormalizedLog to logs-normalized.
    - And MUST publish the same redacted NormalizedLog to alerts-priority-stream.
    - And commit the consumer offset only after both produces return success.
  - Scenario 4: Poison pill exceeding 64KB is routed to DLQ.
    - Given a raw payload in logs-raw whose compressed size exceeds 64KB.
    - When the Normalization Worker detects the size violation.
    - Then it MUST construct a DLQEnvelope with:
      - original_payload_truncated set to the first 2048 bytes (UTF-8 safe).
      - sha256_hash computed over the full original bytes.
      - error_reason describing the size violation.
      - worker_id set to the current worker's identifier.
      - failed_at set to the current UTC timestamp in ISO 8601.
    - And publish the DLQEnvelope to logs-dlq.
    - And increment logger_dlq_routed_total.
    - And increment logger_events_processed_total with labels stage="normalization" and status="error".
    - And commit the consumer offset after the DLQ produce returns success.
  - Scenario 5: Structurally undeserializable payload is routed to DLQ.
    - Given a raw payload in logs-raw that is valid in size but fails JSON deserialization.
    - When the Normalization Worker attempts to parse it.
    - Then it MUST construct a DLQEnvelope with the truncated payload and hash.
    - And publish to logs-dlq.
    - And increment logger_dlq_routed_total.
    - And increment logger_events_processed_total with labels stage="normalization" and status="error".
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

## Phase 3: The Execution DAG (The Core Engine)

- **Step 1: Scaffolding & Tests.**
  - Define NormalizedLog using bon builder with all fields specified in Phase 1. Derive Serialize and Deserialize.
  - Define DLQEnvelope using bon builder. The builder method for original_payload_truncated MUST accept the full raw bytes and internally perform the UTF-8-safe truncation to 2048 bytes. Derive Serialize and Deserialize.
  - Define NormalizationError as an enum with variants PoisonPill, RegexFailure, SerializationError, and ProduceError. Each variant carries a descriptive String. Derive thiserror::Error and Debug.
  - Implement the NormalizationWorld BDD cucumber world struct. Define step definitions targeting each of the 5 scenarios from Phase 2. Run the test suite and verify all steps are scaffolded and failing (red).

- **Step 2: Pure Logic.**
  - PII Regex Engine:
    - Declare a module-level static using std::sync::LazyLock (or once_cell::sync::Lazy) holding a Vec of compiled regex::Regex patterns covering at minimum: email addresses, credit card numbers (Luhn-plausible digit sequences), and Social Security Numbers.
    - Implement a function redact_pii(message: &str) -> (String, u64) that iterates over every compiled pattern, replaces all matches in the message with "[REDACTED]", and returns the redacted string along with the total count of substitutions performed.
    - This function is pure (no I/O) and must not allocate unboundedly; it operates on a single message string.
  - Parallel Array Flattener:
    - Implement a function flatten_to_parallel_arrays(attribute_keys: Vec of String, attribute_values_string: Vec of String) -> (Vec of String, Vec of String) that passes through the already-flattened arrays from the upstream DomainLog. This is a structural passthrough confirming positional alignment and performing no additional transformation.
  - DLQ Envelope Builder:
    - The DLQEnvelope builder MUST compute sha256_hash by hashing the full original raw bytes using sha2::Sha256.
    - The builder MUST truncate original_payload_truncated to the nearest valid UTF-8 boundary at or below 2048 bytes using String::from_utf8_lossy on a byte slice capped at 2048.
  - Poison Pill Detection:
    - Implement a function is_poison_pill(raw_bytes: &[u8]) -> bool that returns true if the byte length exceeds 65536 (64KB).

- **Step 3: Infrastructure Adapters.**
  - LogConsumer Adapter:
    - Implement the LogConsumer trait backed by rdkafka::consumer::StreamConsumer.
    - The consume() method calls StreamConsumer::recv().await, maps the received message payload to Vec of u8, and returns it alongside the borrowed message metadata.
    - The commit_offset() method calls consumer.commit_message(&message, CommitMode::Async).
    - The consume() call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "rdkafka consumer recv failed")) BEFORE the ? operator.
    - The commit_offset() call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "rdkafka offset commit failed")) BEFORE the ? operator.
    - Successful consume MUST emit ::tracing::debug!(bytes = raw.len(), "consumed raw message from logs-raw").
    - Successful commit MUST emit ::tracing::debug!("offset committed for logs-raw message").
  - NormalizedProducer Adapter:
    - Implement the NormalizedProducer trait backed by rdkafka::producer::FutureProducer.
    - produce_normalized() serializes the NormalizedLog to JSON bytes using serde_json::to_vec, then calls FutureProducer::send() targeting the "logs-normalized" topic.
      - The serde_json::to_vec call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "serialization failed for NormalizedLog")) BEFORE the ? operator.
      - The send().await call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = ?e, topic = "logs-normalized", "produce to logs-normalized failed")) BEFORE the ? operator.
      - On success, emit ::tracing::debug!(topic = "logs-normalized", log_id = %log.log_id, "produced normalized log").
    - produce_alert() serializes the NormalizedLog to JSON bytes and calls FutureProducer::send() targeting the "alerts-priority-stream" topic.
      - The serde_json::to_vec call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "serialization failed for alert NormalizedLog")) BEFORE the ? operator.
      - The send().await call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = ?e, topic = "alerts-priority-stream", "produce to alerts-priority-stream failed")) BEFORE the ? operator.
      - On success, emit ::tracing::debug!(topic = "alerts-priority-stream", log_id = %log.log_id, "produced alert duplicate").
    - produce_dlq() serializes the DLQEnvelope to JSON bytes and calls FutureProducer::send() targeting the "logs-dlq" topic.
      - The serde_json::to_vec call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "serialization failed for DLQEnvelope")) BEFORE the ? operator.
      - The send().await call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = ?e, topic = "logs-dlq", "produce to logs-dlq failed")) BEFORE the ? operator.
      - On success, emit ::tracing::debug!(topic = "logs-dlq", sha256 = %envelope.sha256_hash, "produced DLQ envelope").

- **Step 4: The Actor Loop.**
  - The consumer event loop function MUST be annotated with #[::tracing::instrument(skip_all, name = "normalization_worker_loop")].
  - The loop body executes the following mechanical sequence for every consumed message:
    1. Call consume() on the LogConsumer adapter. On error, log via the tap_err mandated in Step 3 and continue to the next iteration (do NOT commit offset for a failed consume).
    2. Poison Pill Gate: Call is_poison_pill() on the raw bytes. If true:
       a. Construct a DLQEnvelope from the raw bytes (builder handles truncation and hashing).
       b. Call produce_dlq() on the NormalizedProducer. On error, log via tap_err and continue (do NOT commit offset).
       c. Increment logger_dlq_routed_total counter by 1.
       d. Increment logger_events_processed_total with labels stage="normalization", status="error" by 1.
       e. Call commit_offset() on the LogConsumer. On error, log via tap_err and continue.
       f. Continue to next iteration.
    3. Deserialize the raw bytes into the upstream DomainLog struct (the struct with attribute_keys and attribute_values_string produced by the Edge Receiver). On deserialization failure:
       a. Construct a DLQEnvelope from the raw bytes.
       b. Call produce_dlq(). On error, log via tap_err and continue.
       c. Increment logger_dlq_routed_total counter by 1.
       d. Increment logger_events_processed_total with labels stage="normalization", status="error" by 1.
       e. Call commit_offset(). On error, log via tap_err and continue.
       f. Continue to next iteration.
    4. PII Redaction: Call redact_pii() on the message field. Capture the redaction count. If the redaction count is greater than 0, increment logger_pii_redactions_total by the redaction count.
    5. Build the NormalizedLog using the bon builder, populating:
       - log_id with a new Uuid::new_v4().
       - timestamp, level, app_name, error_code from the deserialized DomainLog.
       - message with the PII-redacted string.
       - attribute_keys and attribute_values_string passed through from the DomainLog.
    6. Call produce_normalized() on the NormalizedProducer. On error, log via tap_err, increment logger_events_processed_total with labels stage="normalization", status="error", and continue (do NOT commit offset).
    7. Alert Duplication Gate: If level equals "ERROR" or level equals "CRITICAL":
       a. Clone the NormalizedLog.
       b. Call produce_alert() on the NormalizedProducer. On error, log via tap_err, increment logger_events_processed_total with labels stage="normalization", status="error", and continue (do NOT commit offset).
    8. Increment logger_events_processed_total with labels stage="normalization", status="success" by 1.
    9. Call commit_offset() on the LogConsumer. On error, log via tap_err.
  - Telemetry Closed-World Compliance: This actor loop uses ONLY the following three metrics from the closed-world set:
    - logger_events_processed_total with label stage="normalization" and status="success" or status="error".
    - logger_dlq_routed_total (incremented on every DLQ produce).
    - logger_pii_redactions_total (incremented by the count of regex substitutions).
  - No other metric names are permitted.

## Phase 4: Monolith Integration

- **Wiring Directives:**
  - In the modular monolith entrypoint (apps/src/main.rs), when the CLI role flag matches "normalization":
    1. Instantiate the rdkafka StreamConsumer with consumer group "normalization-cg", subscribing to topic "logs-raw". Pass broker addresses from configuration.
    2. Instantiate the rdkafka FutureProducer with broker addresses from configuration.
    3. Wrap both in their respective trait adapter structs (KafkaLogConsumer, KafkaNormalizedProducer).
    4. Register the following three Prometheus metrics in the global registry:
       - logger_events_processed_total: IntCounterVec with labels ["stage", "status"]. Initialize with stage="normalization".
       - logger_dlq_routed_total: IntCounter.
       - logger_pii_redactions_total: IntCounter.
    5. Spawn the normalization actor loop as a tokio::spawn task, passing in the consumer adapter, producer adapter, and the three metric handles.
    6. The spawned task MUST be held in a JoinHandle and selected against a graceful shutdown signal (tokio::signal::ctrl_c or a CancellationToken). On shutdown signal, the task MUST be allowed to drain its current in-flight message before exiting.

- **Exit Gate — Track Acceptance Criteria:**
  - cargo fmt --check passes with zero formatting violations.
  - cargo clippy passes with zero warnings.
  - cargo nextest run passes with all five cucumber scenarios green.
  - Zero occurrences of .unwrap(), .expect(), unreachable!(), panic!(), todo!(), or unimplemented!() in any source file touched by this track.
  - Zero occurrences of std::sync::Mutex anywhere in async code paths.
  - Zero mock data interfaces — the KafkaLogConsumer and KafkaNormalizedProducer use real rdkafka StreamConsumer and FutureProducer instances.
  - The ONLY Prometheus metric names present in the codebase for this track are logger_events_processed_total, logger_dlq_routed_total, and logger_pii_redactions_total. Any other metric name is a structural violation.
  - The DLQEnvelope builder MUST truncate original_payload_truncated to a safe UTF-8 boundary at or below 2048 bytes.
  - PII regex redaction MUST run BEFORE high-priority duplicate logs are produced to the alerts-priority-stream.
  - Every fallible I/O call has an explicit .tap_err with ::tracing::error! before the ? operator.
  - Every successful I/O completion has a ::tracing::debug! confirmation.
  - The consumer event loop and all async I/O methods carry #[::tracing::instrument(skip_all)].
