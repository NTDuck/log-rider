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

### Error Variants
- `RedisError`: Failed to execute the Lua script, ping the cache server, or connect to the Pub/Sub channel.
- `TelegramError`: The upstream API rejected the notification payload.

### Component Contracts
- **RateLimiter Interface**: An abstract boundary enforcing deduplication limits. It exposes a `check_and_increment` operation requiring a fingerprint, window dimensions, and a strict TTL parameter (for OOM prevention).
- **AlertNotifier Interface**: An outbound gateway exposing a `notify` operation to trigger the Telegram API.
- **ConfigSubscriber Interface**: An asynchronous listener interface that yields continuous dynamic `AlertConfig` updates from a Pub/Sub topic.

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

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement the error fingerprint hashing logic. Implement an atomic, thread-safe dynamic configuration holder (e.g., Reader-Writer lock) to cache the latest thresholds.
2. **Infrastructure Adapters**: Implement the `RateLimiter` applying a Redis Lua script with a mandatory `EXPIRE` directive attached to every tracked key. Implement the `AlertNotifier` wrapping an HTTP client. Implement the `ConfigSubscriber` binding to a Redis Pub/Sub stream.
3. **The Event Loops**: 
   - **Task A (Config Listener)**: A background thread listening to the Pub/Sub interface and updating the atomic configuration holder.
   - **Task B (Event Processor)**: The primary loop fetching logs, querying the configuration holder, invoking the rate limiter, and triggering notifications.
   - **Telemetry**: Loops MUST emit `tracing::debug` for successful alerts and `tracing::error` for cache/API failures. MUST explicitly increment `logger_alerts_fired_total` and `logger_alert_errors_total`.

## Section 5: Wiring & Registration
**Registration Directives:**
1. Capture `--role alert-consumer` from CLI.
2. Instantiate the message consumer, Redis Rate Limiter, Redis Config Subscriber, and Telegram HTTP Notifier using standard environment variables.
3. Initialize the threshold update structures.
4. Register the Prometheus alert/error metrics.
5. Spawn the Config Listener task and the Event Processor task concurrently.

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Explicit mandatory TTL / Expiration rule verified in the Redis tracking structures to prevent OOM.
- [ ] Redis Pub/Sub listener integrated to update thresholds dynamically.
- [ ] Explicit tracing spans and dual-channel Prometheus metrics included in the loops.
- [ ] NO raw Rust syntax blocks inside this blueprint specification document.
