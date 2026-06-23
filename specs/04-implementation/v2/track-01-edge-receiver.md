# Track 1: Edge Receiver

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role edge`
- **Upstream Input Source**: HTTP POST `/v1/logs` (Authenticated via stateless JWT)
- **Downstream Destination**: Redpanda Topic `logs-raw`
- **Performance Constraints**:
  - Max payload size: 256KB uncompressed (returns HTTP 413).
  - Max nested depth: 5 levels (evaluated by iterative JSON parser; returns HTTP 400).
  - MUST NOT use recursive parsing (stack-overflow DoS vector).

## Section 2: Interface Contracts & Data Models
```rust
#[derive(bon::Builder, Debug, Clone)]
pub struct KeyValue {
    pub key: String,
    pub value: String, // Flattened dot-notation value
}

// Internal Domain representation after iterative flattening.
#[derive(bon::Builder, Debug, Clone)]
pub struct IngestedLog {
    pub timestamp: String,
    pub level: String,
    pub message: String,
    pub app_name: String,
    pub error_code: Option<String>,
    pub attributes: ::std::vec::Vec<KeyValue>,
}

#[derive(::axiom::Erratum, Debug)]
pub enum EdgeError {
    #[error("Unauthorized JWT")]
    Unauthorized,
    #[error("App Name does not match JWT Grants")]
    Forbidden,
    #[error("Malformed JSON or Depth > 5")]
    BadRequest,
    #[error("Payload exceeds 256KB limit")]
    PayloadTooLarge,
}

#[async_trait::async_trait]
pub trait LogProducer: Send + Sync {
    async fn produce(
        &self,
        log: IngestedLog,
    ) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<EdgeError>>>;
}
```

## Section 3: Behavior-Driven Specification (BDD)
```gherkin
Feature: Edge Receiver Ingestion
  Scenario: Valid log payload is accepted
    Given a valid OTLP JSON payload with nested key-value arrays
    And the payload size is under 256KB
    And the nesting depth is under 5 levels
    And a JWT with app_grants containing the payload's app_name
    When it hits the Edge Receiver
    Then it MUST be authenticated, iteratively parsed and flattened
    And proxied to logs-raw

  Scenario: Payload exceeds depth limit
    Given a log payload containing dynamic attributes with a nesting depth of 6
    When the Edge Receiver encounters the depth breach during iterative parsing
    Then it MUST fail-fast immediately with HTTP 400
```
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct EdgeWorld {
    pub raw_payload: Option<String>,
    pub jwt_token: Option<String>,
    pub response_status: Option<u16>,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement the iterative (non-recursive) JSON parser against `serde_json::Value` to dynamically walk the tree without structural deserialization failures. Implement depth and size validators. Implement the stateless JWT RBAC validator checking `app_grants` against `app_name`.
2. **Infrastructure Adapters**: Implement `LogProducer` using `rdkafka` to produce to `logs-raw`.
3. **The Event Loop**: Implement the Tokio-spawned Axum web server. The HTTP handler MUST accept raw bytes or `serde_json::Value` (not a rigid struct) to allow the iterative validator to work. The loop MUST emit `::tracing::debug!` on ingestion, `::tracing::error!` on validation/Kafka failures, and MUST increment Prometheus counters for success, HTTP 400, HTTP 403, and HTTP 413 channels independently.

## Section 5: Wiring & Registration
```rust
if cli.role == "edge" {
    let producer = KafkaLogProducer::new(&config.kafka_brokers);
    let app = edge_receiver::router(producer);
    
    // Register metrics
    let registry = prometheus::default_registry();
    registry.register(Box::new(logger_ingest_bytes_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_edge_requests_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_edge_errors_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        axum::Server::bind(&"0.0.0.0:8080".parse().unwrap())
            .serve(app.into_make_service())
            .await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()` in application logic.
- [ ] Code guaranteed to contain NO stubbed/mock data interfaces (using concrete `rdkafka` and HTTP clients).
- [ ] Axum handler explicitly accepts dynamically structured JSON to prevent framework HTTP 422 before iterative validation.
- [ ] Prometheus metrics incremented on BOTH success and error boundaries.
- [ ] `::tracing::debug!` and `::tracing::error!` spans are explicitly written in the HTTP handler loop.
