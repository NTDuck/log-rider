# Track 7: Admin API Actor

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role admin-api`
- **Upstream Input Source**: HTTP POST `/v1/admin/config` (JWT Admin Auth required)
- **Downstream Destinations**: ClickHouse append-only `MergeTree` table, Redis Pub/Sub
- **Performance Constraints**:
  - MUST NOT use `ReplacingMergeTree` or mutable updates in ClickHouse.

## Section 2: Interface Contracts & Data Models
```rust
#[derive(bon::Builder, Debug, Clone)]
pub struct AlertConfig {
    pub config_id: ::uuid::Uuid,
    pub threshold: u64,
    pub window_seconds: u64,
    pub created_at: String,
}

#[derive(::axiom::Erratum, Debug)]
pub enum AdminError {
    #[error("Unauthorized Admin")]
    Unauthorized,
    #[error("Config Write Failed")]
    WriteFailed,
    #[error("PubSub Broadcast Failed")]
    BroadcastFailed,
}

#[async_trait::async_trait]
pub trait ConfigWriter: Send + Sync {
    async fn append_config(&self, config: &AlertConfig) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<AdminError>>>;
    async fn publish_update_event(&self) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<AdminError>>>;
}
```

## Section 3: Behavior-Driven Specification (BDD)
```gherkin
Feature: Admin API Configurations
  Scenario: Admin updates threshold configuration
    Given an Admin user authenticated with JWT
    When they submit a new alert configuration
    Then the system MUST append the config to the MergeTree table
    And publish an update event via Redis Pub/Sub
```
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct AdminWorld {
    pub config_payload: Option<String>,
    pub redis_event_fired: bool,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Admin JWT validator. Payload validator and builder.
2. **Infrastructure Adapters**: Implement `ConfigWriter` using ClickHouse HTTP client for append-only insert, and Redis client for Pub/Sub publish.
3. **The Event Loop**: Implement Axum web server handler orchestrating the logic blocks.
   - **Telemetry**: MUST include `::tracing::debug!` upon successful configuration update and `::tracing::error!` for DB/Redis failures. Prometheus counters `logger_admin_config_writes_total` and `logger_admin_config_errors_total` MUST be incremented accordingly.

## Section 5: Wiring & Registration
```rust
if cli.role == "admin-api" {
    let writer = AdminConfigWriter::new(&config.ch_url, &config.redis_url);
    let app = admin_api::router(writer);

    let registry = prometheus::default_registry();
    registry.register(Box::new(logger_admin_config_writes_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_admin_config_errors_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        axum::Server::bind(&"0.0.0.0:8082".parse().unwrap())
            .serve(app.into_make_service())
            .await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] ClickHouse updates verified strictly as append-only.
- [ ] Explicit `::tracing` spans and dual-channel Prometheus metrics included in the HTTP handler.
