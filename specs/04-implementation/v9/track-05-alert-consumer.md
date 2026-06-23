# Track 5: Alert Consumer (v9)

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
  - **Decoupled Consumer Pattern (Mechanical Backpressure):** The Kafka reading must be structurally decoupled from processing to prevent pre-fetch data loss. A dedicated Fetcher task polls `librdkafka` and pushes messages to a bounded `mpsc` channel. A separate Processor task reads from the `mpsc` channel and executes the Redis/Telegram I/O. If Telegram fails, the Processor retries in place. `librdkafka` will handle heartbeats autonomously while TCP backpressure naturally halts the Fetcher once the `mpsc` channel is full.
  - **Idempotent Cancellation:** Graceful shutdown MUST use `tokio_util::sync::CancellationToken` (latch-based) rather than `watch::Receiver`. The token MUST be polled recursively inside all inner retry loops (including Fetcher, Processor, and Config Listener) to prevent deadlocks.
  - **Telemetry Contract:** `logger_events_processed_total` MUST be incremented OUTSIDE of infinite retry loops. Count the message, not the retry attempt.

---

## Phase 2: The Behavioral Specification

- **The Gherkin Feature (Alert Tumbling Window & Notifications):**

  - Feature: Alert Consumer v9 Rate-Limited Notification

  - Scenario 1: High-priority errors are deduplicated transactionally.
    - Given the Config Listener fetches the initial threshold (e.g. 100 per 60s) from the Admin API.
    - When 150 errors with matching fingerprints are consumed by the Fetcher and pushed to the `mpsc` channel.
    - Then the Processor reads from the `mpsc` channel and computes the SHA-256 fingerprint.
    - And executes a Redis Lua script to reserve a token (`reserve_and_check`).
    - And fires exactly 1 notification to Telegram.
    - And commits the token via `commit()` upon HTTP 2xx success.
    - And batches the remaining 49 errors into a digest message (Batching Fallback) because the threshold was breached.
    - And commits the Kafka offset.
    - And increments logger_alerts_fired_total by 1.
    - And increments logger_events_processed_total OUTSIDE of any retry loop.

  - Scenario 2: Telegram API transient failure triggers Mechanical Backpressure.
    - Given the Token Bucket reserved a token.
    - When the Telegram HTTP call returns 503.
    - Then the Processor task enters an inner retry loop.
    - And the Processor sleeps using `tokio::time::sleep` wrapped in a `tokio::select!` alongside `CancellationToken::cancelled()`.
    - And the bounded `mpsc` channel fills up, blocking the Fetcher task naturally.
    - And `librdkafka` autonomously maintains the background broker heartbeat without polling `recv()`.
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
  - Ensure all features map to the v9 constraints (Transactional Commit, Decoupled Consumer Pattern).

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

- **Step 4: The Actor Tasks**

  - **Config Listener Task (`src/alert/config_loop.rs`):**
    - State Reconciliation: Call `fetch_initial()` BEFORE the infinite Pub/Sub subscription loop. Populate the `config_cache` RwLock. If `fetch_initial()` fails, retry with exponential backoff.
    - After initial fetch, enter the Redis Pub/Sub outer connection loop, maintaining the subscription and updating `config_cache`.
    - Inner and outer loops MUST explicitly select on `CancellationToken::cancelled()`.

  - **Decoupled Consumer Pattern (`src/alert/run_loop.rs`):**
    - Create a bounded channel: `let (tx, mut rx) = tokio::sync::mpsc::channel(100);`
    
    - **Task A (Fetcher Task):**
      - Infinite loop polling `tokio::select!` on `consumer.recv()` and `CancellationToken::cancelled()`.
      - On receiving a message, pushes it to `tx`. If `tx` is full, it blocks, applying natural TCP backpressure to Kafka while `librdkafka` handles heartbeats in the background. No manual partition pausing is needed.

    - **Task B (Processor Task):**
      - Infinite loop polling `tokio::select!` on `rx.recv()` and `CancellationToken::cancelled()`.
      - On reading a message:
        1. Deserialize payload.
        2. Compute fingerprint.
        3. Call `rate_limiter.reserve_and_check()`.
           - On `Ok(false)` (limit exceeded): add to the batch digest via Redis List (Batching Fallback), and immediately commit Kafka offset (via a shared consumer reference or a dedicated offset committer).
           - On `Ok(true)`:
        4. Attempt `notifier.notify()` with retries.
           - If `notify()` fails and triggers a backoff, retry in place. The retry `sleep` MUST ONLY select against `cancel_token.cancelled()`. DO NOT poll `consumer.recv()` here.
           - On final Telegram success: call `rate_limiter.commit()`, and commit Kafka offset.
           - On final Telegram failure: call `rate_limiter.rollback()`, do NOT commit Kafka offset.
        5. **Telemetry Compliance:** Increment `logger_events_processed_total` exactly ONCE at the end of the message's processing pipeline, OUTSIDE the Telegram retry loop.

---

## Phase 4: Monolith Integration

- **Wiring Directives (`apps/src/main.rs` --role alert-consumer):**

  1. Instantiate `KafkaLogConsumer`.
  2. Instantiate `RedisRateLimiter`.
  3. Instantiate `TelegramNotifier`.
  4. Instantiate `ConfigSubscriber` with the Admin API endpoint.
  5. Create the `config_cache` as `Arc<tokio::sync::RwLock<AlertConfig>>` using an uninitialized placeholder or `Option::None` until `fetch_initial()` populates it. Hardcoded defaults (like 100/60) are EXPLICITLY FORBIDDEN.
  6. Register ONLY `logger_events_processed_total` and `logger_alerts_fired_total`. No other metrics.
  7. Spawn the **Config Listener Task**.
  8. Instantiate the bounded `mpsc` channel.
  9. Spawn the **Fetcher Task** (Task A) passing `tx`.
  10. Spawn the **Processor Task** (Task B) passing `rx`.
  11. Pass the globally cloned `tokio_util::sync::CancellationToken` to all spawned tasks. Eradicate any usage of `watch::Receiver`.

### 4.2 Metric Ledger
- `logger_events_processed_total` (Labels: stage="alert", status="success"|"error") - Counted per message, NOT per retry.
- `logger_alerts_fired_total`

### 4.3 Observability Ledger
- All infinite and inner retry loops MUST carry `.tap_err()` before the `?` operator.
- `CancellationToken` must be passed down to inner futures.

### 4.4 Exit Gate (v9 Requirements)
- [ ] No hardcoded configuration defaults exist; `fetch_initial()` is called on startup (State Reconciliation).
- [ ] Redis Token Bucket uses a two-phase transactional commit (`reserve_and_check`, `commit`, `rollback`) and implements Batching Fallback.
- [ ] **Decoupled Consumer Pattern:** Kafka `recv()` polling is strictly isolated in the Fetcher task. The Processor task retries in place without polling Kafka, relying on `librdkafka`'s autonomous background heartbeat.
- [ ] **Idempotent Cancellation:** `CancellationToken` is used exclusively for graceful shutdown, with no `watch::Receiver` deadlocks.
- [ ] `logger_events_processed_total` is incremented outside of all retry loops.
- [ ] Zero `todo!()`, `unwrap()`, or `std::sync::Mutex` held across `.await`.
- [ ] Metrics strict compliance.
