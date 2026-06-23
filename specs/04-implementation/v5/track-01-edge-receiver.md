# Track 1: Edge Receiver

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role edge`
- **Upstream Input Source**: HTTP POST `/v1/logs` (Authenticated via stateless JWT)
- **Downstream Destination**: Redpanda Topic `logs-raw`
- **Performance Constraints**: Max payload size 256KB uncompressed. Max nested depth 5 levels. MUST NOT use recursive parsing.

## Section 2: Interface Contracts & Data Models
```rust
#[derive(bon::Builder, Debug, Clone)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
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
    #[error("Kafka production failed")]
    KafkaProduceError,
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
    pub raw_payload: Option<::serde_json::Value>,
    pub jwt_token: Option<String>,
    pub response_status: Option<u16>,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement an iterative JSON depth validator taking `serde_json::Value` (no recursion). Implement a stateless JWT validator extracting `app_grants`.
2. **Infrastructure Adapters**: Implement `LogProducer` natively via `rdkafka::producer::FutureProducer`. Use `.tap_err(|e| { ::tracing::error!("Produce failed: {:?}", e); logger_edge_errors_total.inc(); })` inside the implementation so the Rust `?` operator does NOT silently bypass telemetry.
3. **The Event Loop**: Implement the Axum web handler. 
   - **Physical Socket Limits**: Apply `axum::extract::DefaultBodyLimit::max(256 * 1024)` at the router level. This physically drops streams > 256KB directly at the socket BEFORE they are aggregated into Axum `Bytes` or hit the JSON parser.
   - **Telemetry Bypass Prevention**: The handler MUST map Prometheus increments (`logger_edge_requests_total`) and `::tracing::debug!` inside the success branch, and MUST map `::tracing::error!` inside the `tap_err` or explicit exhaustive `match` block before any early returns.

## Section 5: Wiring & Registration
```rust
if cli.role == "edge" {
    let producer = crate::adapters::KafkaLogProducer::new(&config.kafka_brokers).await?;
    let app_state = crate::edge::AppState { producer };
    
    let registry = ::prometheus::default_registry();
    registry.register(::std::boxed::Box::new(logger_edge_requests_total.clone())).unwrap_or_default();
    registry.register(::std::boxed::Box::new(logger_edge_errors_total.clone())).unwrap_or_default();

    let app = ::axum::Router::new()
        .route("/v1/logs", ::axum::routing::post(crate::edge::handler))
        // Physical Socket Body Limit Enforcement
        .layer(::axum::extract::DefaultBodyLimit::max(256 * 1024))
        .with_state(app_state);

    ::tokio::spawn(async move {
        match ::axum::Server::bind(&"0.0.0.0:8080".parse().unwrap_or_else(|_| return))
            .serve(app.into_make_service())
            .await 
        {
            Ok(_) => {},
            Err(e) => ::tracing::error!("Server error: {}", e),
        }
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code checked for `.unwrap()` or mock data.
- [ ] No `std::sync::Mutex` across `.await`.
- [ ] Raw JSON accepted to avoid premature 422s.
- [ ] Telemetry fully integrated.
