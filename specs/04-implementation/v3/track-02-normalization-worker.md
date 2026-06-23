# Track 2: Normalization Worker

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role normalization`
- **Upstream Input Source**: Redpanda Topic `logs-raw`
- **Downstream Destinations**: Redpanda Topics `logs-normalized`, `alerts-priority-stream`, `logs-dlq`
- **Performance Constraints**:
  - MUST process static compiled regex PII redaction efficiently.
  - MUST wrap processing failures (Poison Pills > 64KB) in `DLQEnvelope` with max 2KB truncated original payload.

## Section 2: Interface Contracts & Data Models

### Domain Models
- **NormalizedLog**:
  - `log_id`: UUID
  - `timestamp`: String
  - `level`: String
  - `message`: String
  - `app_name`: String
  - `error_code`: Optional String
  - `attribute_keys`: Array of Strings
  - `attribute_values_string`: Array of Strings (strictly parallel to `attribute_keys`)

- **DLQEnvelope**:
  - `failed_at`: String
  - `error_reason`: String
  - `worker_id`: String
  - `original_payload_truncated`: String (Strictly limited to 2KB)
  - `sha256_hash`: String (Hash of the original payload for traceback)

### Error Variants
- `PoisonPill`: Payload cannot be parsed or strictly violates max consumption limits.
- `RegexFailure`: An error occurred during PII regex compilation or execution.

### Component Contracts
- **LogConsumer Interface**: Exposes a `consume` operation pulling messages from the source topic.
- **NormalizedProducer Interface**: Exposes multiple discrete operations:
  - `produce_normalized`: Publishes standard logs.
  - `produce_alert`: Duplicates high-priority logs to the alert stream.
  - `produce_dlq`: Routes malformed payloads wrapped in the `DLQEnvelope`.

## Section 3: Behavior-Driven Specification (BDD)

```gherkin
Feature: Normalization Worker
  Scenario: Valid log is redacted and normalized
    Given a log in logs-raw with PII in the message
    When the Normalization Worker consumes it
    Then it MUST statically run regex PII redaction
    And transform flattened JSON into parallel arrays (attribute_keys, attribute_values_string)
    And publish to logs-normalized

  Scenario: High-priority log is duplicated
    Given a log in logs-raw with level ERROR
    When the Normalization Worker redacts and normalizes it
    Then it MUST duplicate the log to alerts-priority-stream

  Scenario: Poison Pill is truncated and sent to DLQ
    Given a log in logs-raw > 64KB compressed
    When the Normalization Worker consumes it
    Then it MUST wrap the error in DLQEnvelope truncating the payload to 2KB
    And publish to logs-dlq
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement statically compiled regex PII redactor. Implement parallel array transformer extracting flattened keys into separate column arrays. Implement `DLQEnvelope` factory enforcing string truncation to 2KB.
2. **Infrastructure Adapters**: Implement the `LogConsumer` and `NormalizedProducer` interface contracts mapping directly to native `rdkafka` streams.
3. **The Event Loop**: Implement a persistent background thread fetching from the consumer, executing the redactor/transformer, and pushing to the appropriate producers. 
   - **Constraint**: Broker offsets MUST be explicitly committed *only after* a successful push.
   - **Telemetry**: Loop MUST contain explicit `tracing::debug` for successful routing and `tracing::error` on regex/push failures. Prometheus counters `logger_pii_redactions_total`, `logger_normalized_success_total`, and `logger_dlq_events_total` MUST be explicitly incremented.

## Section 5: Wiring & Registration
**Registration Directives:**
1. In the application entry point, capture the `--role normalization` command line argument.
2. If triggered, instantiate the concrete Kafka Consumer and Producer adapters using environment variables for the broker URLs and group IDs.
3. Explicitly initialize and register the Prometheus metrics for PII redactions, DLQ events, and normalized successes into the global registry.
4. Pass the initialized interfaces into the core worker loop.
5. Spawn the worker loop as an independent, asynchronous task attached to the main application lifecycle.

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Code guaranteed to contain NO stubbed/mock data interfaces.
- [ ] Offsets are explicitly committed *after* the push.
- [ ] Explicit tracing spans and Prometheus increments implemented for both success and error/DLQ paths.
- [ ] NO raw Rust syntax blocks inside this blueprint specification document.
