# Track 4: AI Consumer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role ai-consumer`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destination**: ClickHouse Sidecar Table `log_ai_tags` (and `ai-tags-stream` patch publish)
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
}

#[async_trait::async_trait]
pub trait AIClassifier: Send + Sync {
    async fn classify(&self, message: &str) -> ::axiom::result::Fallible<::core::result::Result<AITag, ::std::vec::Vec<AIError>>>;
}

#[async_trait::async_trait]
pub trait SidecarWriter: Send + Sync {
    async fn write_tag(&self, tag: AITag) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<AIError>>>;
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
```
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct AIWorld {
    pub message: Option<String>,
    pub generated_tag: Option<AITag>,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Not much pure logic beyond parsing. Wait, ONNX loading logic if wrapped purely.
2. **Infrastructure Adapters**: Implement `AIClassifier` using `ort` (ONNX Runtime Rust bindings). Implement `SidecarWriter` using ClickHouse HTTP client.
3. **The Event Loop**: Implement `tokio::spawn` loop fetching from `logs-normalized`, executing `classify`, executing `write_tag`, and committing offsets.

## Section 5: Wiring & Registration
```rust
if cli.role == "ai-consumer" {
    let consumer = KafkaLogConsumer::new(&config.kafka_brokers, "logs-normalized");
    let classifier = OnnxClassifier::new(&config.model_path);
    let writer = ClickHouseSidecarWriter::new(&config.ch_url);

    ::tokio::spawn(async move {
        ai_consumer::run(consumer, classifier, writer).await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check` has been successfully run.
- [ ] `cargo clippy` has been successfully run with no warnings.
- [ ] `cargo nextest run` has been successfully run.
- [ ] Code has been manually checked to guarantee NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()` in application code.
- [ ] Code has been manually checked to guarantee NO stubbed/mock data interfaces.
