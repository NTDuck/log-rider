# Track 6: WebSocket Server

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role ws-server`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destination**: WebSocket Clients (Viewer Dashboard)
- **Performance Constraints**: MUST use Broadcast Consumer pattern. MUST enforce stateless RBAC (JWT). MUST use bounded channels.

## Section 2: Interface Contracts & Data Models
```rust
#[derive(bon::Builder, Debug, Clone)]
pub struct WsClientConfig {
    pub allowed_apps: ::std::vec::Vec<String>,
    pub is_admin: bool,
}

#[derive(::axiom::Erratum, Debug)]
pub enum WSError {
    #[error("Invalid JWT")]
    InvalidToken,
    #[error("Connection dropped by client")]
    ConnectionDropped,
    #[error("Client lagged behind broadcast queue")]
    LaggingClient,
    #[error("Kafka consumer error")]
    ConsumerError,
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
1. **Pure Logic**: Stateless JWT parser extracting `WsClientConfig`. In-memory log filter comparing log `app_name` against `allowed_apps`.
2. **Infrastructure Adapters**: Axum WebSocket upgrade handler framework.
3. **The Event Loops**:
   - `Ingestion Task`: Consumes from `logs-normalized`, pushes directly into a `tokio::sync::broadcast::channel(1024)` bounded memory channel.
   - `Client Session Tasks`: One per WebSocket. Subscribes to the broadcast channel, runs the pure filter logic, sends strictly via WS API.
   - **Telemetry Bypass Prevention**: All session/handshake loops MUST inject their Prometheus error tracking (`logger_ws_dropped_total.inc()`) and `::tracing::error!` spans into exhaustive `match` blocks or `.tap_err()` hooks *before* any `?` early-returns, mechanically ensuring the observability contract.

## Section 5: Wiring & Registration
```rust
if cli.role == "ws-server" {
    // Explicitly bounded channel
    let (tx, _rx) = ::tokio::sync::broadcast::channel(1024);
    let tx_clone = tx.clone();

    let consumer = crate::adapters::KafkaLogConsumer::new(&config.kafka_brokers, "logs-normalized").await?;
    
    let registry = ::prometheus::default_registry();
    registry.register(::std::boxed::Box::new(logger_ws_connections_active.clone())).unwrap_or_default();
    registry.register(::std::boxed::Box::new(logger_ws_dropped_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        match crate::ws::ingestion_loop(consumer, tx_clone).await {
            Ok(_) => {},
            Err(e) => ::tracing::error!("Ingestion loop exited: {:?}", e),
        }
    });

    let app = ::axum::Router::new()
        .route("/v1/ws", ::axum::routing::get(crate::ws::handler))
        .with_state(crate::ws::AppState { broadcast_tx: tx });

    ::tokio::spawn(async move {
        match ::axum::Server::bind(&"0.0.0.0:8081".parse().unwrap_or_else(|_| return))
            .serve(app.into_make_service())
            .await 
        {
            Ok(_) => {},
            Err(e) => ::tracing::error!("WS Server error: {}", e),
        }
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] NO `.unwrap()` or mock data interfaces.
- [ ] Bounded queue explicitly verified (`channel(1024)`).
- [ ] Stateless filter verified (no external DB lookups for RBAC).
- [ ] Explicit tracing spans and Prometheus connections metrics.
