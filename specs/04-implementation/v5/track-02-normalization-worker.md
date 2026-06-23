# Track 2: Normalization Worker

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role normalization`
- **Upstream Input Source**: Redpanda Topic `logs-raw`
- **Downstream Destinations**: `logs-normalized`, `alerts-priority-stream`, `logs-dlq`
- **Performance Constraints**: MUST process regex statically. MUST wrap poison pills > 64KB truncating payload to 2KB.

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
    #[error("Produce Failed")]
    ProduceError,
}

#[async_trait::async_trait]
pub trait LogConsumer: Send + Sync {
    async fn consume(&self) -> ::axiom::result::Fallible<::core::result::Result<String, ::std::vec::Vec<NormalizationError>>>;
    async fn commit_offset(&self) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<NormalizationError>>>;
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
    And publish to logs-normalized

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
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement statically compiled regex (`once_cell` or `lazy_static`). Implement `DLQEnvelope` builder enforcing 2KB string truncation.
2. **Infrastructure Adapters**: `rdkafka::consumer::StreamConsumer` and `rdkafka::producer::FutureProducer`.
3. **The Event Loop**: Infinite `tokio::spawn` loop fetching logs. Offsets MUST be committed explicitly via `commit_offset` ONLY AFTER producer `await` returns success.
   - **Telemetry Bypass Prevention**: All `.await` calls producing to `logs-normalized` or `logs-dlq` MUST be suffixed with `.tap_err(|e| { ::tracing::error!("..."); METRIC.inc(); })` before using the `?` operator. This mechanically guarantees that telemetry cannot be bypassed by a Rust early-return.

## Section 5: Wiring & Registration
```rust
if cli.role == "normalization" {
    let consumer = crate::adapters::KafkaLogConsumer::new(&config.kafka_brokers, "logs-raw").await?;
    let producer = crate::adapters::KafkaNormalizedProducer::new(&config.kafka_brokers).await?;
    
    let registry = ::prometheus::default_registry();
    registry.register(::std::boxed::Box::new(logger_dlq_events_total.clone())).unwrap_or_default();
    registry.register(::std::boxed::Box::new(logger_pii_redactions_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        match crate::normalization::run_loop(consumer, producer).await {
            Ok(_) => {},
            Err(e) => ::tracing::error!("Normalization loop exited: {:?}", e),
        }
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] NO `.unwrap()` or mock data interfaces.
- [ ] Offsets explicitly committed ONLY after successful push.
- [ ] Explicit tracing spans and metrics.
