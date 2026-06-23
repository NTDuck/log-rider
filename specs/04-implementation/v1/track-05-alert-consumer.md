# Track 5: Alert Consumer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role alert-consumer`
- **Upstream Input Source**: Redpanda Topic `alerts-priority-stream`
- **Downstream Destination**: Telegram API, Redis (Token Bucket & O(1) deduplication counts)
- **Performance Constraints**:
  - MUST enforce a Lua Token Bucket rate limit to protect Telegram.
  - MUST deduplicate in O(1) space.
  - Redis crash "State Amnesia" is a documented, acceptable dealbreaker.

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
    async fn check_and_increment(&self, fingerprint: &str, window_sec: u64, limit: u64) -> ::axiom::result::Fallible<::core::result::Result<bool, ::std::vec::Vec<AlertError>>>;
}

#[async_trait::async_trait]
pub trait AlertNotifier: Send + Sync {
    async fn notify(&self, message: &str) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<AlertError>>>;
}
```

## Section 3: Behavior-Driven Specification (BDD)
```gherkin
Feature: Alert Tumbling Window & Notifications
  Scenario: High-priority errors are deduplicated and limited
    Given a threshold configuration of 100 errors per 60 seconds
    When 150 errors with matching fingerprints are consumed from alerts-priority-stream
    Then the Alert Consumer MUST deduplicate them using Redis
    And apply a Lua Token Bucket rate limit
    And fire exactly 1 notification to Telegram
```
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct AlertWorld {
    pub errors_consumed: u64,
    pub notifications_sent: u64,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Fingerprint generator logic from `NormalizedLog.error_code` and `app_name`.
2. **Infrastructure Adapters**: Implement `RateLimiter` using `fred` or `redis` crate invoking a Lua script. Implement `AlertNotifier` using `reqwest` targeting Telegram API.
3. **The Event Loop**: Implement `tokio::spawn` loop fetching from `alerts-priority-stream`, calling `check_and_increment`, conditionally calling `notify`, and emitting metrics.

## Section 5: Wiring & Registration
```rust
if cli.role == "alert-consumer" {
    let consumer = KafkaLogConsumer::new(&config.kafka_brokers, "alerts-priority-stream");
    let rate_limiter = RedisRateLimiter::new(&config.redis_url);
    let notifier = TelegramNotifier::new(&config.telegram_bot_token, &config.telegram_chat_id);
    
    prometheus::default_registry()
        .register(Box::new(logger_alerts_fired_total.clone()))
        .unwrap_or_default();

    ::tokio::spawn(async move {
        alert_consumer::run(consumer, rate_limiter, notifier).await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check` has been successfully run.
- [ ] `cargo clippy` has been successfully run with no warnings.
- [ ] `cargo nextest run` has been successfully run.
- [ ] Code has been manually checked to guarantee NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()` in application code.
- [ ] Code has been manually checked to guarantee NO stubbed/mock data interfaces.
- [ ] Prometheus metrics (`logger_alerts_fired_total`) are emitted.
