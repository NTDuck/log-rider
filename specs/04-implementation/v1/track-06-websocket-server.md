# Track 6: WebSocket Server

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role ws-server`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destination**: WebSocket Clients (Viewer Dashboard)
- **Performance Constraints**:
  - MUST use the Broadcast Consumer Pattern to fan out messages in-memory.
  - MUST enforce stateless RBAC (JWT validation) directly without DB lookup.
  - Wildcard `*` claim MUST be supported.

## Section 2: Interface Contracts & Data Models
```rust
#[derive(::axiom::Erratum, Debug)]
pub enum WSError {
    #[error("Invalid JWT")]
    InvalidToken,
    #[error("Connection closed")]
    ConnectionClosed,
}

#[derive(bon::Builder, Debug, Clone)]
pub struct WsClientConfig {
    pub allowed_apps: ::std::vec::Vec<String>,
    pub is_admin: bool,
}
```

## Section 3: Behavior-Driven Specification (BDD)
```gherkin
Feature: WebSocket Viewer
  Scenario: Client receives authorized logs
    Given a client requests a WebSocket connection passing a cryptographically valid JWT containing app_grants: ["payment-api"]
    When logs flow through logs-normalized
    Then the client MUST receive logs only for payment-api

  Scenario: Admin client receives all logs
    Given an admin client connects with app_grants: ["*"]
    Then the client MUST receive all logs
```
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct WSWorld {
    pub client_grants: ::std::vec::Vec<String>,
    pub received_logs: usize,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement the JWT RBAC extractor that generates `WsClientConfig`. Implement the filter logic `if config.is_admin || config.allowed_apps.contains(&log.app_name)`.
2. **Infrastructure Adapters**: Implement Axum WebSocket upgrade handler.
3. **The Event Loop**: Implement `tokio::spawn` loop fetching from `logs-normalized` via `rdkafka`, sending through a bounded `tokio::sync::broadcast` channel, and the individual WebSocket client tasks that listen to the broadcast channel, filter, and send.

## Section 5: Wiring & Registration
```rust
if cli.role == "ws-server" {
    let (tx, _rx) = ::tokio::sync::broadcast::channel(1024);
    let tx_clone = tx.clone();
    
    // Background Kafka to Broadcast task
    ::tokio::spawn(async move {
        ws_server::kafka_to_broadcast(config.kafka_brokers, tx_clone).await
    });

    let app = ws_server::router(tx);

    ::tokio::spawn(async move {
        axum::Server::bind(&"0.0.0.0:8081".parse().unwrap())
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
- [ ] Explicit unbounded queue ban adherence (channel must be bounded).
- [ ] Stateless filter verified (no DB or external cache calls for RBAC).
