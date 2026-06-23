# Track 4: AI Consumer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role ai-consumer`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destinations**: ClickHouse Sidecar Table `log_ai_tags` and Redpanda Topic `ai-tags-stream`
- **Performance Constraints**:
  - Asynchronous processing, completely decoupled from the primary ingestion pipeline.
  - No database JOINs allowed (sidecar table relies on Dictionaries).

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
    Then it MUST implement exponential backoff/retry or route to a DLQ flow to prevent dropping classifications or crashing
```
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct AIWorld {
    pub message: Option<String>,
    pub generated_tag: Option<AITag>,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Payload parsing and mapping logic.
2. **Infrastructure Adapters**: Implement `AIClassifier` using `ort`. Implement `SidecarWriter` using ClickHouse HTTP client for DB write, and `rdkafka` for the stream patch to `ai-tags-stream`.
3. **The Event Loop**: Implement `tokio::spawn` loop fetching from `logs-normalized`, executing `classify`, executing `write_tag` (with exponential backoff/retry on DB failure), executing `publish_patch`, and committing offsets.
   - **Telemetry**: MUST include `::tracing::debug!` for successful classifications, and `::tracing::error!` for inference or write failures. Prometheus counters `logger_ai_inference_success_total`, `logger_ai_inference_error_total`, and `logger_ai_sidecar_error_total` MUST be explicitly incremented.

## Section 5: Wiring & Registration
```rust
if cli.role == "ai-consumer" {
    let consumer = KafkaLogConsumer::new(&config.kafka_brokers, "logs-normalized");
    let classifier = OnnxClassifier::new(&config.model_path);
    let writer = CombinedSidecarWriter::new(&config.ch_url, &config.kafka_brokers);

    let registry = prometheus::default_registry();
    registry.register(Box::new(logger_ai_inference_success_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_ai_inference_error_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_ai_sidecar_error_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        ai_consumer::run(consumer, classifier, writer).await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Code guaranteed to contain NO stubbed/mock data interfaces.
- [ ] Includes `publish_patch` to `ai-tags-stream` as explicitly required by User Story 3.
- [ ] Includes safe retry/backoff flow for sidecar DB write failures.
- [ ] Explicit `::tracing` spans and dual-channel Prometheus tracking implemented in the execution loop.
