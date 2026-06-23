# Track 2: Normalization Worker

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role normalization`
- **Upstream Input Source**: Redpanda Topic `logs-raw`
- **Downstream Destinations**: Redpanda Topics `logs-normalized`, `alerts-priority-stream`, `logs-dlq`
- **Performance Constraints**:
  - MUST process static compiled regex PII redaction efficiently.
  - MUST wrap processing failures (Poison Pills > 64KB) in `DLQEnvelope` with max 2KB truncated original payload.

## Section 2: Interface Contracts & Data Models
```rust
#[derive(bon::Builder, Debug, Clone)]
pub struct NormalizedLog {
    pub log_id: ::uuid::Uuid,
    pub timestamp: String,
    pub level: String,
    pub message: String,
    pub app_name: String,
    pub error_code: Option<String>,
    pub attribute_keys: ::std::vec::Vec<String>,
    pub attribute_values_string: ::std::vec::Vec<String>,
}

#[derive(bon::Builder, Debug, Clone)]
pub struct DLQEnvelope {
    pub failed_at: String,
    pub error_reason: String,
    pub worker_id: String,
    pub original_payload_truncated: String,
    pub sha256_hash: String,
}

#[derive(::axiom::Erratum, Debug)]
pub enum NormalizationError {
    #[error("Poison Pill Detected")]
    PoisonPill,
    #[error("PII Regex Processing Failed")]
    RegexFailure,
}

#[async_trait::async_trait]
pub trait LogConsumer: Send + Sync {
    async fn consume(&self) -> ::axiom::result::Fallible<::core::result::Result<NormalizedLog, ::std::vec::Vec<NormalizationError>>>;
}

#[async_trait::async_trait]
pub trait NormalizedProducer: Send + Sync {
    async fn produce_normalized(&self, log: NormalizedLog) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<NormalizationError>>>;
    async fn produce_alert(&self, log: NormalizedLog) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<NormalizationError>>>;
    async fn produce_dlq(&self, envelope: DLQEnvelope) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<NormalizationError>>>;
}
```

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
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct NormalizationWorld {
    pub input_log: Option<String>,
    pub dlq_envelope: Option<DLQEnvelope>,
    pub is_alert: bool,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement statically compiled regex PII redactor. Implement parallel array transformer. Implement `DLQEnvelope` builder truncating string to 2KB.
2. **Infrastructure Adapters**: Implement `LogConsumer` and `NormalizedProducer` using `rdkafka`.
3. **The Event Loop**: Implement `tokio::spawn` loop fetching from consumer, running logic, and sending to producers. 
   - **Constraint**: Offsets MUST be auto-committed *only after* a successful push.
   - **Telemetry**: Loop MUST contain explicit `::tracing::debug!` for successful routing and `::tracing::error!` on regex/push failures. Prometheus counters `logger_pii_redactions_total`, `logger_normalized_success_total`, and `logger_dlq_events_total` MUST be explicitly incremented.

## Section 5: Wiring & Registration
```rust
if cli.role == "normalization" {
    let consumer = KafkaLogConsumer::new(&config.kafka_brokers, "logs-raw");
    let producer = KafkaNormalizedProducer::new(&config.kafka_brokers);
    
    let registry = prometheus::default_registry();
    registry.register(Box::new(logger_pii_redactions_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_dlq_events_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_normalized_success_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        normalization_worker::run(consumer, producer).await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Code guaranteed to contain NO stubbed/mock data interfaces.
- [ ] Offsets are explicitly committed *after* the push.
- [ ] Explicit `::tracing::error!` spans and Prometheus increments implemented for both success and error/DLQ paths.
