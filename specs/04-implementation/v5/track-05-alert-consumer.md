# Track 5: Alert Consumer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role alert-consumer`
- **Upstream Input Source**: Redpanda Topic `alerts-priority-stream`
- **Downstream Destination**: Telegram API, Redis (Token Bucket & O(1) deduplication counts)
- **Performance Constraints**: MUST enforce Lua Token Bucket rate limit. MUST deduplicate in O(1) space with a strict Redis TTL to prevent OOM.

## Section 2: Interface Contracts & Data Models
```rust
#[derive(bon::Builder, Debug, Clone)]
pub struct AlertConfig {
    pub threshold: u64,
    pub window_seconds: u64,
}

#[derive(::axiom::Erratum, Debug)]
pub enum AlertError {
    #[error("Redis execution failed")]
    RedisError,
    #[error("Telegram API rejected request")]
    TelegramError,
    #[error("Consumer failure")]
    ConsumerError,
}

#[async_trait::async_trait]
pub trait RateLimiter: Send + Sync {
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
1. **Pure Logic**: SHA-256 fingerprint hasher for errors. Thread-safe atomic config cache (`tokio::sync::RwLock<AlertConfig>`).
2. **Infrastructure Adapters**: Redis client wrapping Lua script + EXPIRE command. `reqwest` client for Telegram API. `redis-async` PubSub subscriber.
3. **The Event Loops**:
   - `Config Listener Task`: **Resilient Socket Mechanics**: The Redis Pub/Sub background listener MUST be physically wrapped in an infinite `loop { ... tokio::time::sleep(...) }` retry-reconnect block, or it MUST return an error that causes a graceful worker shutdown if it dies. This prevents silent deaths where configuration staleness persists forever.
   - `Event Processor Task`: Fetches logs, reads `RwLock` config, runs `check_and_increment` (passing explicit TTL), executes `notify` if threshold breached.
   - **Telemetry Bypass Prevention**: All cache/Telegram fallible calls MUST inject `logger_alert_errors_total.inc()` via `.tap_err()` or exhaustive matches, ensuring the `?` early-return operator does not silently drop observability.

## Section 5: Wiring & Registration
```rust
if cli.role == "alert-consumer" {
    let consumer = crate::adapters::KafkaLogConsumer::new(&config.kafka_brokers, "alerts-priority-stream").await?;
    let rate_limiter = crate::adapters::RedisRateLimiter::new(&config.redis_url).await?;
    let notifier = crate::adapters::TelegramNotifier::new(&config.telegram_bot_token, &config.telegram_chat_id)?;
    let subscriber = crate::adapters::RedisConfigSubscriber::new(&config.redis_url).await?;

    let config_cache = ::std::sync::Arc::new(::tokio::sync::RwLock::new(crate::models::AlertConfig::builder()
        .threshold(100)
        .window_seconds(60)
        .build()));

    let registry = ::prometheus::default_registry();
    registry.register(::std::boxed::Box::new(logger_alerts_fired_total.clone())).unwrap_or_default();
    registry.register(::std::boxed::Box::new(logger_alert_errors_total.clone())).unwrap_or_default();

    ::tokio::spawn(crate::alert::config_loop(subscriber, config_cache.clone()));
    
    ::tokio::spawn(async move {
        match crate::alert::run_loop(consumer, rate_limiter, notifier, config_cache).await {
            Ok(_) => {},
            Err(e) => ::tracing::error!("Alert loop exited: {:?}", e),
        }
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] NO `.unwrap()` or mock data interfaces.
- [ ] No unbounded memory maps.
- [ ] Explicit TTL mapped onto Redis deduplication keys.
- [ ] Dynamic Redis Pub/Sub threshold updater included.
- [ ] Explicit tracing spans and metrics.
