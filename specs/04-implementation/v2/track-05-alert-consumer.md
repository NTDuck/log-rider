# Track 5: Alert Consumer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role alert-consumer`
- **Upstream Input Source**: Redpanda Topic `alerts-priority-stream`
- **Downstream Destination**: Telegram API, Redis (Token Bucket & O(1) deduplication counts)
- **Performance Constraints**:
  - MUST enforce a Lua Token Bucket rate limit to protect Telegram.
  - MUST deduplicate in O(1) space, mandating a strict TTL/eviction policy on Redis keys to prevent infinite memory growth (OOM).
  - MUST subscribe to Redis Pub/Sub to dynamically update threshold configurations (FR-010).

## Section 2: Interface Contracts & Data Models
```rust
#[derive(::axiom::Erratum, Debug)]
pub enum AlertError {
    #[error("Redis connection failed")]
    RedisError,
    #[error("Telegram API rejected request")]
    TelegramError,
}

#[async_trait::async_trait]
pub trait RateLimiter: Send + Sync {
    // strict_ttl enforces OOM prevention
    async fn check_and_increment(&self, fingerprint: &str, window_sec: u64, limit: u64, strict_ttl: u64) -> ::axiom::result::Fallible<::core::result::Result<bool, ::std::vec::Vec<AlertError>>>;
}

#[async_trait::async_trait]
pub trait AlertNotifier: Send + Sync {
    async fn notify(&self, message: &str) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<AlertError>>>;
}

#[async_trait::async_trait]
pub trait ConfigSubscriber: Send + Sync {
    async fn listen_for_updates(&self) -> ::tokio::sync::mpsc::Receiver<crate::models::AlertConfig>;
}
```

## Section 3: Behavior-Driven Specification (BDD)
```gherkin
Feature: Alert Tumbling Window & Notifications
  Scenario: High-priority errors are deduplicated safely and limited
    Given a threshold configuration of 100 errors per 60 seconds
    When 150 errors with matching fingerprints are consumed
    Then the Alert Consumer MUST deduplicate them using Redis
    And apply a strict TTL to the tracking structures to prevent OOM
    And apply a Lua Token Bucket rate limit
    And fire exactly 1 notification to Telegram

  Scenario: Admin dynamically updates configurations
    Given the Alert Consumer is running
    When a configuration update is broadcast via Redis Pub/Sub
    Then the Alert Consumer MUST update its internal window and threshold limits in real-time
```
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct AlertWorld {
    pub errors_consumed: u64,
    pub notifications_sent: u64,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Fingerprint generator logic. Dynamic config holder (e.g. `Arc<tokio::sync::RwLock<AlertConfig>>`).
2. **Infrastructure Adapters**: Implement `RateLimiter` applying Lua script + mandatory TTL/EXPIRE on tracking keys. Implement `AlertNotifier` (reqwest to Telegram). Implement `ConfigSubscriber` using `redis` Pub/Sub listener.
3. **The Event Loop**: 
   - Task A: Config subscriber loop dynamically updating the internal `RwLock`.
   - Task B: Main loop fetching from `alerts-priority-stream`, calling `check_and_increment` (passing TTL), conditionally calling `notify`.
   - **Telemetry**: MUST include `::tracing::debug!` for successful alerts and `::tracing::error!` for Redis/Telegram failures. MUST increment `logger_alerts_fired_total` and `logger_alert_errors_total`.

## Section 5: Wiring & Registration
```rust
if cli.role == "alert-consumer" {
    let consumer = KafkaLogConsumer::new(&config.kafka_brokers, "alerts-priority-stream");
    let rate_limiter = RedisRateLimiter::new(&config.redis_url);
    let notifier = TelegramNotifier::new(&config.telegram_bot_token, &config.telegram_chat_id);
    let subscriber = RedisConfigSubscriber::new(&config.redis_url);
    
    let registry = prometheus::default_registry();
    registry.register(Box::new(logger_alerts_fired_total.clone())).unwrap_or_default();
    registry.register(Box::new(logger_alert_errors_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        alert_consumer::run(consumer, rate_limiter, notifier, subscriber).await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Explicit mandatory TTL / Expiration rule attached to Redis tracking structures to prevent OOM.
- [ ] Redis Pub/Sub listener integrated to update thresholds.
- [ ] Explicit `::tracing` spans and dual-channel Prometheus metrics included in the loops.
