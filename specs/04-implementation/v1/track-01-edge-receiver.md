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
1. **Pure Logic**: Implement the iterative (non-recursive) JSON parser. Implement the payload depth and size validators. Implement the stateless JWT RBAC validator checking `app_grants` against `app_name`.
2. **Infrastructure Adapters**: Implement `LogProducer` using `rdkafka` to produce to `logs-raw`.
3. **The Event Loop**: Implement the Tokio-spawned Axum web server routing HTTP POST `/v1/logs` to the logic blocks and infrastructure adapters.

## Section 5: Wiring & Registration
```rust
// Example wiring in apps/src/main.rs
if cli.role == "edge" {
    let producer = KafkaLogProducer::new(&config.kafka_brokers);
    let app = edge_receiver::router(producer);
    
    // Register metrics
    prometheus::default_registry()
        .register(Box::new(logger_ingest_bytes_total.clone()))
        .unwrap_or_default(); // Exception allowed for global metric init

    ::tokio::spawn(async move {
        axum::Server::bind(&"0.0.0.0:8080".parse().unwrap())
            .serve(app.into_make_service())
            .await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check` has been successfully run.
- [ ] `cargo clippy` has been successfully run with no warnings.
- [ ] `cargo nextest run` has been successfully run.
- [ ] Code has been manually checked to guarantee NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()` in application code.
- [ ] Code has been manually checked to guarantee NO stubbed/mock data interfaces (using concrete `rdkafka` and HTTP clients).
- [ ] Prometheus metrics (`logger_ingest_bytes_total`) are emitted in the implementation.
