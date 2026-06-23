# Track 2: Normalization Worker

## Phase 1: The Domain & Contracts
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
    - RegexFailure: Errors during static regex redaction.
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

## Phase 2: The Behavioral Specification
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

## Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define NormalizedLog and DLQEnvelope using bon builders. Implement the NormalizationWorld BDD steps.
- **Step 2: Pure Logic:** Compile PII regex patterns statically (using once_cell or lazy_static). Implement the flattener converting key-value maps to parallel vectors. Implement the DLQEnvelope builder which enforces the 2KB truncation on original payload.
- **Step 3: Infrastructure Adapters:** Connect rdkafka StreamConsumer and FutureProducer. Ensure offset commits only execute on the consumer AFTER downstream produce returns success.
- **Step 4: The Actor Loop:** Implement the consumer event loop.
  - Telemetry Bypass Prevention: Every downstream produce call must have an explicit tap error hook that logs the event and increments logger_dlq_events_total or logger_pii_redactions_total before executing the early return operator to prevent silent drops.

## Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogConsumer and KafkaNormalizedProducer.
  - Register logger_dlq_events_total and logger_pii_redactions_total metrics.
  - Check role role normalization, then spawn the normalization loop task.
