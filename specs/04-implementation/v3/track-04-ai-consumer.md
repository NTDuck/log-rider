# Track 4: AI Consumer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role ai-consumer`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destinations**: ClickHouse Sidecar Table `log_ai_tags` and Redpanda Topic `ai-tags-stream`
- **Performance Constraints**:
  - Asynchronous processing, completely decoupled from the primary ingestion pipeline.
  - No database JOINs allowed (sidecar table relies on Dictionaries).

## Section 2: Interface Contracts & Data Models

### Domain Models
- **AITag**:
  - `log_id`: UUID
  - `model_version`: String
  - `tag`: String
  - `confidence`: Float (32-bit)

### Error Variants
- `InferenceError`: The ONNX Model execution failed or timed out.
- `SidecarWriteError`: The ClickHouse sidecar table insertion failed.
- `StreamPublishError`: Publishing the tag patch to the event stream failed.

### Component Contracts
- **AIClassifier Interface**: Exposes a `classify` operation that evaluates a string and returns an `AITag`.
- **SidecarWriter Interface**: Exposes dual operations:
  - `write_tag`: Persists the tag to the sidecar database.
  - `publish_patch`: Broadcasts the tag to the real-time event stream.

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

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Map and parse the payload to extract the message text.
2. **Infrastructure Adapters**: Implement the `AIClassifier` interface via the native ONNX runtime framework. Implement the `SidecarWriter` utilizing a ClickHouse native HTTP client for database inserts and a Redpanda producer for stream patches.
3. **The Event Loop**: Implement a background polling thread fetching from `logs-normalized`, executing the classifier, and writing the tag out. 
   - **Resilience**: The DB write MUST utilize explicit exponential backoff/retry on failure to guarantee delivery.
   - **Telemetry**: MUST include `tracing::debug` for successful classifications, and `tracing::error` for inference or write failures. Prometheus counters `logger_ai_inference_success_total`, `logger_ai_inference_error_total`, and `logger_ai_sidecar_error_total` MUST be explicitly incremented.

## Section 5: Wiring & Registration
**Registration Directives:**
1. Upon detecting `--role ai-consumer`, initialize the ONNX model from the environment path.
2. Initialize the Kafka Consumer, the ClickHouse native writer, and the Kafka Patch Producer.
3. Register the AI telemetry counters within the application's global metric registry.
4. Pass the initialized interfaces into the core worker loop and spawn the asynchronous task.

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Code guaranteed to contain NO stubbed/mock data interfaces.
- [ ] Includes `publish_patch` to `ai-tags-stream` as explicitly required by User Story 3.
- [ ] Includes safe retry/backoff flow for sidecar DB write failures.
- [ ] Explicit tracing spans and dual-channel Prometheus tracking implemented in the execution loop.
- [ ] NO raw Rust syntax blocks inside this blueprint specification document.
