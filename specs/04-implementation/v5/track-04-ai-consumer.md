# Track 4: AI Consumer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role ai-consumer`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destinations**: ClickHouse Sidecar `log_ai_tags`, Redpanda `ai-tags-stream`
- **Performance Constraints**: No ClickHouse JOINs. Must output independent patches.

## Section 2: Interface Contracts & Data Models
```rust
#[derive(bon::Builder, Debug, Clone)]
pub struct AITag {
    pub log_id: ::uuid::Uuid,
    pub model_version: String,
    pub tag: String,
    pub confidence: f32,
}

#[derive(::axiom::Erratum, Debug)]
pub enum AIError {
    #[error("ONNX Model Execution Failed")]
    InferenceError,
    #[error("ClickHouse sidecar write failed")]
    SidecarWriteError,
    #[error("Stream patch publish failed")]
    StreamPublishError,
    #[error("Kafka consumer failed")]
    ConsumerError,
}

#[async_trait::async_trait]
pub trait AIClassifier: Send + Sync {
    async fn classify(&self, message: &str) -> ::axiom::result::Fallible<::core::result::Result<AITag, ::std::vec::Vec<AIError>>>;
}

#[async_trait::async_trait]
pub trait SidecarWriter: Send + Sync {
    async fn write_tag(&self, tag: &AITag) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<AIError>>>;
    async fn publish_patch(&self, tag: &AITag) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<AIError>>>;
}
```

## Section 3: Behavior-Driven Specification (BDD)
```gherkin
Feature: AI Consumer Classification
  Scenario: Log is classified and sidecar stored
    Given a log payload published to logs-normalized
    When the AI Consumer extracts the message body
    Then it MUST run its ONNX model
    And write the output tag to log_ai_tags sidecar table
    And publish a patch to ai-tags-stream

  Scenario: ClickHouse sidecar is offline
    Given the ClickHouse sidecar table is unreachable
    When the AI Consumer attempts to write the tag
    Then it MUST pause the rdkafka stream
    And implement exponential backoff/retry
```
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct AIWorld {
    pub message: Option<String>,
    pub generated_tag: Option<AITag>,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Message extraction mapping.
2. **Infrastructure Adapters**: `ort` framework wrapped in `AIClassifier`. `reqwest` client and `rdkafka` producer wrapped in `SidecarWriter`.
3. **The Event Loop**: 
   - Consume from `logs-normalized`.
   - Execute `classify`.
   - **Kafka Physical Backpressure Mechanics**: Before entering the `tokio-retry` exponential backoff loop for ClickHouse DB failures, explicitly instruct the consumer to pause fetching via `consumer.pause(&partitions)`. Resume via `consumer.resume(&partitions)` only once the write succeeds. This stops the C-thread from causing an OOM.
   - Execute `publish_patch`.
   - Commit Redpanda offset.
   - **Telemetry Bypass Prevention**: Enforce `.tap_err(|e| { ::tracing::error!(...); logger_ai_sidecar_error_total.inc(); })` on all fallible calls BEFORE utilizing `?` to guarantee Prometheus spans cannot be jumped.

## Section 5: Wiring & Registration
```rust
if cli.role == "ai-consumer" {
    let consumer = crate::adapters::KafkaLogConsumer::new(&config.kafka_brokers, "logs-normalized").await?;
    let classifier = crate::adapters::OnnxClassifier::new(&config.model_path)?;
    let writer = crate::adapters::CombinedSidecarWriter::new(&config.ch_url, &config.kafka_brokers).await?;

    let registry = ::prometheus::default_registry();
    registry.register(::std::boxed::Box::new(logger_ai_inference_success_total.clone())).unwrap_or_default();
    registry.register(::std::boxed::Box::new(logger_ai_sidecar_error_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        match crate::ai_consumer::run_loop(consumer, classifier, writer).await {
            Ok(_) => {},
            Err(e) => ::tracing::error!("AI Consumer loop exited: {:?}", e),
        }
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] NO `.unwrap()` or mock data interfaces.
- [ ] Safe DB retry flow explicitly implemented via `tokio-retry`.
- [ ] `publish_patch` included.
- [ ] Explicit tracing spans and metrics.
