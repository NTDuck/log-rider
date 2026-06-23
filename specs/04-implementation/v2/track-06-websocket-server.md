# Track 6: WebSocket Server

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role ws-server`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destination**: WebSocket Clients (Viewer Dashboard)
- **Performance Constraints**:
  - MUST use the Broadcast Consumer Pattern to fan out messages in-memory.
  - MUST enforce stateless RBAC (JWT validation) directly without DB lookup.
  - MUST enforce internal backpressure via bounded channels.

## Section 2: Interface Contracts & Data Models
```rust
#[derive(::axiom::Erratum, Debug)]
pub enum WSError {
    #[error("Invalid JWT")]
    InvalidToken,
    #[error("Connection dropped")]
    ConnectionDropped,
    #[error("Broadcast channel full / Lagging client")]
    LaggingClient,
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
1. **Pure Logic**: JWT RBAC extractor generating `WsClientConfig`. Filter logic executing in-memory filtering.
2. **Infrastructure Adapters**: Implement Axum WebSocket upgrade handler.
3. **The Event Loop**: 
   - Task A: Fetch from `logs-normalized` and send to `tokio::sync::broadcast` (bounded limit).
   - Task B: Per-client WebSocket loops listening to the broadcast channel, filtering, and sending.
   - **Telemetry**: Loops MUST emit `::tracing::debug!` upon client connection/disconnection and `::tracing::error!` upon handshake failures or dropped connections due to client lag. Prometheus counters `logger_ws_connections_active`, `logger_ws_fanout_success_total`, and `logger_ws_dropped_total` MUST be incremented.

## Section 5: Wiring & Registration
```rust
if cli.role == "ws-server" {
    let (tx, _rx) = ::tokio::sync::broadcast::channel(1024); // Bounded queue
    let tx_clone = tx.clone();
    
    let registry = prometheus::default_registry();
    registry.register(Box::new(logger_ws_connections_active.clone())).unwrap_or_default();
    registry.register(Box::new(logger_ws_fanout_success_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_ws_dropped_total.clone())).unwrap_or_default();

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
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Explicit unbounded queue ban adherence (channel strictly bounded to 1024 or similar).
- [ ] Stateless filter verified (no DB or external cache calls for RBAC).
- [ ] Explicit `::tracing` spans and dual-channel Prometheus metrics included in the execution loops.
