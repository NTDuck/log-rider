# Track 7: Admin API Actor

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role admin-api`
- **Upstream Input Source**: HTTP POST `/v1/admin/config` (JWT Admin Auth required)
- **Downstream Destinations**: ClickHouse append-only `MergeTree` table, Redis Pub/Sub
- **Performance Constraints**: MUST NOT use `ReplacingMergeTree` or mutable updates in ClickHouse.

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
    async fn publish_update_event(&self, config: &AlertConfig) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<AdminError>>>;
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
1. **Pure Logic**: Admin JWT validator ensuring strict Role Claims. JSON payload deserializer building `AlertConfig`.
2. **Infrastructure Adapters**: `reqwest` client bound to ClickHouse executing standard immutable `INSERT` operations. `redis-async` client bound to PubSub.
3. **The Event Loop**: Axum HTTP handler orchestrating logic.
   - Extract JWT, validate.
   - Build Config object.
   - Execute `append_config` DB insert.
   - Execute `publish_update_event` to Redis.
   - **Telemetry Bypass Prevention**: The agent MUST explicitly suffix `append_config` and `publish_update_event` calls with `.tap_err(|e| { ::tracing::error!(...); logger_admin_config_errors_total.inc(); })` before using the `?` operator. This mechanically guarantees that telemetry cannot be bypassed by an early return on HTTP failure.

## Section 5: Wiring & Registration
```rust
if cli.role == "admin-api" {
    let writer = crate::adapters::AdminConfigWriter::new(&config.ch_url, &config.redis_url).await?;
    
    let registry = ::prometheus::default_registry();
    registry.register(::std::boxed::Box::new(logger_admin_config_writes_total.clone())).unwrap_or_default();
    registry.register(::std::boxed::Box::new(logger_admin_config_errors_total.clone())).unwrap_or_default();

    let app = ::axum::Router::new()
        .route("/v1/admin/config", ::axum::routing::post(crate::admin::handler))
        .with_state(crate::admin::AppState { writer });

    ::tokio::spawn(async move {
        match ::axum::Server::bind(&"0.0.0.0:8082".parse().unwrap_or_else(|_| return))
            .serve(app.into_make_service())
            .await 
        {
            Ok(_) => {},
            Err(e) => ::tracing::error!("Admin API Server error: {}", e),
        }
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] NO `.unwrap()` or mock data interfaces.
- [ ] ClickHouse interaction strictly verified as `INSERT` append-only.
- [ ] Explicit tracing spans and Prometheus metrics in HTTP handler.
