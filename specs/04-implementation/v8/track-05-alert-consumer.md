# Track 5: Alert Consumer (v8)

## Phase 1: The Domain & Contracts

- **Trigger & Topology:** Activated via CLI role flag "--role alert-consumer". It consumes messages from the Redpanda topic "alerts-priority-stream" (which carries post-PII-redacted ERROR/CRITICAL logs duplicated by the Normalization Worker). It connects to Redis for O(1) fingerprint deduplication and atomic Lua Token Bucket rate limiting. It dispatches notifications to the Telegram Bot API via HTTPS. It synchronizes configuration state by performing a synchronous fetch from the Admin API on startup, and then subscribes to a Redis Pub/Sub channel ("alert-config-updates") for live threshold changes.
- **Data Schemas:**
  - AlertConfig Model (fetched from Admin API, then received via Redis Pub/Sub):
    - config_id: Uuid
    - threshold: u64
    - window_seconds: u64
    - created_at: String
  - AlertError Enum (Erratum-derived):
    - RedisError: Wraps connection, Lua script, or TTL failures.
    - TelegramError: Wraps HTTP transport failures or non-2xx responses.
    - ConsumerError: Wraps rdkafka stream poll failures or deserialization failures.
    - ConfigSubscriptionError: Wraps Admin API fetch errors or Redis Pub/Sub failures.
  - RateLimiter Boundary Trait:
    - Method: reserve_and_check(fingerprint: &str, window_sec: u64, limit: u64, strict_ttl: u64) -> Fallible<bool, Vec<AlertError>>
    - Method: commit(fingerprint: &str) -> Fallible<(), Vec<AlertError>>
    - Method: rollback(fingerprint: &str) -> Fallible<(), Vec<AlertError>>
    - Implementing the Token Bucket Transactional Commit to prevent dedup blackholes.
  - AlertNotifier Boundary Trait:
    - Method: notify(message: &str) -> Fallible<(), Vec<AlertError>>
    - Sends a formatted alert digest to Telegram.
  - ConfigSubscriber Boundary Trait:
    - Method: fetch_initial() -> Fallible<AlertConfig, Vec<AlertError>>
    - Method: subscribe() -> Fallible<tokio::sync::mpsc::Receiver<AlertConfig>, Vec<AlertError>>

- **Physical Constraints:**
  - **State Reconciliation:** The Config Listener MUST synchronously fetch the latest configuration from the Admin API upon startup BEFORE subscribing to Redis Pub/Sub. Hardcoded defaults are FORBIDDEN.
  - **Transactional Dedup & Batching Fallback:** The rate limiter MUST use a two-phase transactional commit. If an external I/O (Telegram) fails, the bucket reservation MUST be rolled back. If the Token Bucket rejects the outbound notification (rate exceeded), pending alerts MUST be batched into a single digest message rather than dropped.
  - **Anti-Blocking Kafka Backpressure:** During any downstream retry backoff (e.g. Telegram 503), the actor CANNOT simply sleep. The retry sleep MUST be wrapped in a `tokio::select!` loop alongside `consumer.recv()`. Partitions MUST be paused, but `recv()` must continually be polled and its results buffered/discarded to maintain the `rdkafka` heartbeat and prevent broker eviction.
  - **Select-Safe Cancellation:** The graceful shutdown `CancellationToken` MUST be polled recursively inside all inner retry loops, not just at the top-level actor loop.
  - **Telemetry Contract:** `logger_events_processed_total` MUST be incremented OUTSIDE of infinite retry loops. Count the message, not the retry attempt.

---

## Phase 2: The Behavioral Specification

- **The Gherkin Feature (Alert Tumbling Window & Notifications):**

  - Feature: Alert Consumer v8 Rate-Limited Notification

  - Scenario 1: High-priority errors are deduplicated transactionally.
    - Given the Config Listener fetches the initial threshold (e.g. 100 per 60s) from the Admin API.
    - When 150 errors with matching fingerprints are consumed.
    - Then the Alert Consumer computes the SHA-256 fingerprint.
    - And executes a Redis Lua script to reserve a token (`reserve_and_check`).
    - And fires exactly 1 notification to Telegram.
    - And commits the token via `commit()` upon HTTP 2xx success.
    - And batches the remaining 49 errors into a digest message (Batching Fallback) because the threshold was breached.
    - And increments logger_alerts_fired_total by 1.
    - And increments logger_events_processed_total OUTSIDE of any retry loop.

  - Scenario 2: Telegram API transient failure triggers Anti-Blocking Backpressure.
    - Given the Token Bucket reserved a token.
    - When the Telegram HTTP call returns 503.
    - Then the Alert Consumer enters an inner retry loop.
    - And the retry `tokio::time::sleep` is wrapped in a `tokio::select!` alongside `consumer.recv()`.
    - And the `CancellationToken` is polled inside this inner loop.
    - And if all retries fail, it executes `rollback()` on the Token Bucket.
    - And logger_events_processed_total is incremented exactly once as an error, NOT per retry.

  - Scenario 3: Config Split-Brain is avoided via State Reconciliation.
    - Given the Alert Consumer process starts.
    - When it attempts to load configuration.
    - Then it MUST NOT use hardcoded defaults.
    - And MUST fetch the source-of-truth from the Admin API via HTTP GET.
    - And only then subscribe to Redis Pub/Sub for live updates.

---

## Phase 3: The Execution DAG (The Core Engine)

- **Step 1: Scaffolding & Tests**
  - Define `AlertConfig`, `AlertError`, and `AlertWorld` in `src/models` and `tests/steps/alert_steps.rs`.
  - Ensure all features map to the v8 constraints (Transactional Commit, Anti-Blocking Backpressure).

- **Step 2: Pure Logic (No I/O)**
  - Implement a fingerprint generator (sha2).
  - Implement a notification message formatter.
  - Implement a batching digest formatter for the Batching Fallback logic.

- **Step 3: Infrastructure Adapters**
  - Redis Rate Limiter Adapter:
    - Implement the Transactional Commit: `reserve_and_check` (eval Lua script to check limit without permanently committing the count), `commit` (finalize the count), and `rollback` (release the reservation).
  - Telegram Notifier Adapter:
    - Normal HTTP POST. Returns `AlertError::TelegramError` on non-2xx status.
  - Config Subscriber Adapter:
    - `fetch_initial` makes an HTTP GET request to the Admin API to retrieve the current `AlertConfig`. Hardcoded configs are forbidden.
    - `subscribe` spawns the Pub/Sub background listener as before.

- **Step 4: The Actor Loops**

  - **Config Listener Task (`src/alert/config_loop.rs`):**
    - State Reconciliation: Call `fetch_initial()` BEFORE the infinite Pub/Sub subscription loop. Populate the `config_cache` RwLock. If `fetch_initial()` fails, retry with exponential backoff (incorporating the `CancellationToken`).
    - After initial fetch, enter the Redis Pub/Sub outer connection loop, maintaining the subscription and updating `config_cache`.
    - Inner and outer loops MUST poll the `CancellationToken`.

  - **Event Processor Task (`src/alert/run_loop.rs`):**
    - Main processing loop:
      1. `tokio::select!` on `consumer.recv()` and `CancellationToken::cancelled()`.
      2. Deserialize payload.
      3. Compute fingerprint.
      4. Call `rate_limiter.reserve_and_check()`.
         - On `Ok(false)` (limit exceeded): add to the batch digest via Redis List (Batching Fallback), do not commit offset yet.
         - On `Ok(true)`:
      5. Attempt `notifier.notify()` with retries.
         - **Anti-Blocking Kafka Backpressure:** If `notify()` fails and triggers a backoff, the retry `sleep` MUST NOT block the consumer. `consumer.pause()` the partitions. Wrap the sleep in a `tokio::select!` loop:
           ```rust
           tokio::select! {
               _ = tokio::time::sleep(backoff) => { /* proceed to retry */ },
               msg = consumer.recv() => { /* buffer/discard to maintain heartbeat */ },
               _ = cancel_token.cancelled() => { /* graceful exit */ }
           }
           ```
         - On final Telegram success: call `rate_limiter.commit()`, commit Kafka offset.
         - On final Telegram failure: call `rate_limiter.rollback()`, do NOT commit offset.
      6. **Telemetry Compliance:** Increment `logger_events_processed_total` exactly ONCE at the end of the message's processing pipeline, OUTSIDE the Telegram retry loop.

---

## Phase 4: Monolith Integration

- **Wiring Directives (`apps/src/main.rs` --role alert-consumer):**

  1. Instantiate `KafkaLogConsumer`.
  2. Instantiate `RedisRateLimiter`.
  3. Instantiate `TelegramNotifier`.
  4. Instantiate `ConfigSubscriber` with the Admin API endpoint.
  5. Create the `config_cache` as `Arc<tokio::sync::RwLock<AlertConfig>>` using an uninitialized placeholder or `Option::None` until `fetch_initial()` populates it. Hardcoded defaults (like 100/60) are EXPLICITLY FORBIDDEN.
  6. Register ONLY `logger_events_processed_total` and `logger_alerts_fired_total`. No other metrics.
  7. Spawn `config_loop` task.
  8. Spawn `run_loop` task. Pass the `CancellationToken` to both.

### 4.2 Metric Ledger
- `logger_events_processed_total` (Labels: stage="alert", status="success"|"error") - Counted per message, NOT per retry.
- `logger_alerts_fired_total`

### 4.3 Observability Ledger
- All infinite and inner retry loops MUST carry `.tap_err()` before the `?` operator.
- `CancellationToken` must be passed down to inner futures.

### 4.4 Exit Gate (v8 Requirements)
- [ ] No hardcoded configuration defaults exist; `fetch_initial()` is called on startup (State Reconciliation).
- [ ] Redis Token Bucket uses a two-phase transactional commit (`reserve_and_check`, `commit`, `rollback`) and implements Batching Fallback.
- [ ] All retry backoffs are wrapped in a `tokio::select!` alongside `consumer.recv()` and `cancel_token.cancelled()` (Anti-Blocking Kafka Backpressure).
- [ ] `logger_events_processed_total` is incremented outside of all retry loops.
- [ ] Zero `todo!()`, `unwrap()`, or `std::sync::Mutex` held across `.await`.
- [ ] Metrics strict compliance.
