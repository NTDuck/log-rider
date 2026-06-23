# Track 5: Alert Consumer

## Phase 1: The Domain & Contracts

- **Trigger & Topology:** Activated via CLI role flag "--role alert-consumer". It consumes messages from the Redpanda topic "alerts-priority-stream" (which carries post-PII-redacted ERROR/CRITICAL logs duplicated by the Normalization Worker). It connects to Redis for O(1) fingerprint deduplication and atomic Lua Token Bucket rate limiting. It dispatches notifications to the Telegram Bot API via HTTPS. It subscribes to a Redis Pub/Sub channel ("alert-config-updates") to receive live threshold configuration changes published by the Admin API (Track 7).

- **Data Schemas:**
  - AlertConfig Model (received via Redis Pub/Sub, deserialized from JSON):
    - config_id: Uuid (unique identifier assigned by Admin API)
    - threshold: u64 (maximum error count before notification fires within the window)
    - window_seconds: u64 (tumbling window duration for fingerprint counting)
    - created_at: String (ISO 8601 timestamp of configuration creation)
  - AlertError Enum (Erratum-derived, non-exhaustive):
    - RedisError: Wraps connection failures, Lua script execution failures, or TTL command failures against the Redis instance.
    - TelegramError: Wraps HTTP transport failures or non-2xx responses from the Telegram Bot API.
    - ConsumerError: Wraps rdkafka stream poll failures or deserialization failures from alerts-priority-stream.
    - ConfigSubscriptionError: Wraps Redis Pub/Sub connection drops or message deserialization failures on the config channel.
  - RateLimiter Boundary Trait:
    - Method: check_and_increment(fingerprint: &str, window_sec: u64, limit: u64, strict_ttl: u64) -> Fallible<bool, Vec<AlertError>>
    - Returns Ok(true) if the fingerprint count has breached the threshold (notification should fire). Returns Ok(false) if the count is still under the limit. The strict_ttl parameter MUST be passed to the Lua script as the EXPIRE value to prevent infinite key growth on Redis crash recovery.
  - AlertNotifier Boundary Trait:
    - Method: notify(message: &str) -> Fallible<(), Vec<AlertError>>
    - Sends a formatted alert digest to the Telegram Bot API endpoint. The TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are injected via environment variables (ADR-0022).
  - ConfigSubscriber Boundary Trait:
    - Method: subscribe() -> Fallible<tokio::sync::mpsc::Receiver<AlertConfig>, Vec<AlertError>>
    - Establishes a Redis Pub/Sub subscription on channel "alert-config-updates" and returns a bounded mpsc::Receiver that emits deserialized AlertConfig values.

- **Physical Constraints:**
  - The Lua Token Bucket script MUST execute INCR + EXPIRE atomically in a single EVAL call to prevent race conditions across horizontally scaled alert-consumer instances (ADR-0022).
  - All Redis tracking keys MUST carry an explicit TTL equal to window_seconds + a small safety margin (e.g., window_seconds + 10). Keys MUST NOT be created without TTL. This prevents infinite Redis memory growth.
  - Loss of ephemeral counting state on Redis crash is an accepted dealbreaker. Synchronous database polling to reconstruct state from ClickHouse is strictly forbidden.
  - The Telegram Bot Token MUST be injected strictly via the TELEGRAM_BOT_TOKEN environment variable. Hardcoding or database lookups for secrets are forbidden.
  - If the Lua Token Bucket rejects an outbound notification (rate exceeded), pending alerts MUST be batched into a single digest message rather than dropped (ADR-0022 Batching Fallback).

- **Closed-World Telemetry Contract (This Track):**
  - logger_events_processed_total{stage="alert", status="success"}: Incremented after a consumed message is fully processed (dedup check completed, notification dispatched or correctly suppressed).
  - logger_events_processed_total{stage="alert", status="error"}: Incremented when any fallible I/O operation (Redis, Telegram, Kafka) fails during processing of a consumed message.
  - logger_alerts_fired_total: Incremented each time a notification is successfully delivered to the Telegram API (i.e., the Lua Token Bucket permitted the send AND the HTTP call returned 2xx).
  - NO other metrics are permitted. The v6 hallucinated metric "logger_alert_errors_total" is explicitly rejected.

---

## Phase 2: The Behavioral Specification

- **The Gherkin Feature (Alert Tumbling Window & Notifications):**

  - Feature: Alert Consumer Deduplication and Rate-Limited Notification

  - Scenario 1: High-priority errors are deduplicated and rate-limited.
    - Given a threshold configuration of 100 errors per 60 seconds.
    - And the Alert Consumer is running and connected to Redis.
    - When 150 errors with matching fingerprints are consumed from alerts-priority-stream.
    - Then the Alert Consumer MUST compute a SHA-256 fingerprint for each error.
    - And execute a Redis Lua script to atomically increment the fingerprint counter with a strict TTL of window_seconds + 10.
    - And detect that the threshold of 100 was breached exactly once.
    - And execute the Lua Token Bucket rate limiter to determine if a Telegram send is permitted.
    - And fire exactly 1 notification to the Telegram API.
    - And increment logger_alerts_fired_total by 1.
    - And increment logger_events_processed_total{stage="alert", status="success"} for each of the 150 successfully processed messages.

  - Scenario 2: Redis is temporarily unreachable during dedup check.
    - Given the Alert Consumer is running.
    - When a message is consumed and the Redis Lua script call fails.
    - Then the Alert Consumer MUST increment logger_events_processed_total{stage="alert", status="error"}.
    - And MUST NOT send any Telegram notification for that message.
    - And MUST NOT commit the Kafka offset for the failed message.
    - And MUST continue processing subsequent messages after a bounded backoff.

  - Scenario 3: Telegram API returns a non-2xx response.
    - Given the Lua Token Bucket has permitted a notification.
    - When the Telegram HTTP call returns a non-2xx status.
    - Then the Alert Consumer MUST increment logger_events_processed_total{stage="alert", status="error"}.
    - And MUST NOT increment logger_alerts_fired_total.
    - And MUST log the failure with tracing::error before continuing.

  - Scenario 4: Admin dynamically updates threshold configuration.
    - Given the Alert Consumer is running with threshold 100, window 60.
    - When a configuration update is broadcast via Redis Pub/Sub on channel "alert-config-updates".
    - Then the Alert Consumer MUST deserialize the new AlertConfig.
    - And update its internal RwLock-guarded configuration in real-time.
    - And subsequent dedup checks MUST use the new threshold and window values.

  - Scenario 5: Redis Pub/Sub connection drops and reconnects.
    - Given the config listener task is subscribed to "alert-config-updates".
    - When the Redis Pub/Sub connection is lost.
    - Then the config listener MUST log the disconnection via tracing::error.
    - And MUST sleep for a bounded duration before attempting to reconnect.
    - And MUST NOT terminate the alert-consumer process.

- **Crucial Directive:** Do not write application code until the cucumber World struct (AlertWorld) and step definitions for all five scenarios above are scaffolded and failing under cargo nextest run.

---

## Phase 3: The Execution DAG (The Core Engine)

- **Step 1: Scaffolding & Tests**
  - Define the AlertConfig model in src/models using bon::Builder. Fields: config_id (Uuid), threshold (u64), window_seconds (u64), created_at (String). Derive serde::Deserialize for Redis Pub/Sub JSON deserialization.
  - Define the AlertError enum in src/models using the Erratum derive macro. Variants: RedisError, TelegramError, ConsumerError, ConfigSubscriptionError. Each variant wraps a source string or error type.
  - Create the cucumber World struct AlertWorld in tests/steps/alert_steps.rs with fields: errors_consumed (u64), notifications_sent (u64), config (AlertConfig), dedup_results (Vec<bool>).
  - Write .feature files in tests/features/alert_consumer.feature containing all five scenarios from Phase 2.
  - Scaffold step definitions that reference AlertWorld, compile, and fail (red).

- **Step 2: Pure Logic (No I/O)**
  - Implement a fingerprint generator function: accepts (app_name: &str, error_code: &str) and returns a hex-encoded SHA-256 string. Use the sha2 crate. This function is pure, deterministic, and testable without I/O.
  - Implement a notification message formatter function: accepts (app_name: &str, error_code: &str, count: u64, threshold: u64) and returns a formatted Telegram message string. Pure function, no I/O.

- **Step 3: Infrastructure Adapters**
  - Redis Rate Limiter Adapter (src/adapters/redis_rate_limiter.rs):
    - Construct with a redis::Client connection and store the Lua script body as a static string constant.
    - The Lua script MUST atomically: (1) INCR the fingerprint key, (2) if the result of INCR equals 1 (first occurrence), set EXPIRE to the strict_ttl parameter, (3) return the current count.
    - The check_and_increment method MUST: call redis EVAL with the Lua script, passing the fingerprint as KEYS[1] and limit + strict_ttl as ARGV. Compare the returned count against the limit. Return Ok(true) if count == limit (threshold just breached, fire notification). Return Ok(false) if count != limit (either under threshold or already fired).
    - The check_and_increment method MUST be annotated with #[::tracing::instrument(skip_all)].
    - On EVAL failure: .tap_err(|e| ::tracing::error!(error = %e, fingerprint = %fingerprint, "Redis Lua token bucket EVAL failed")) BEFORE the ? operator.
    - On success: ::tracing::debug!(fingerprint = %fingerprint, count = %count, "Redis dedup check completed").

  - Telegram Notifier Adapter (src/adapters/telegram_notifier.rs):
    - Construct with a reqwest::Client, bot_token (from TELEGRAM_BOT_TOKEN env var), and chat_id (from TELEGRAM_CHAT_ID env var). Validate both are non-empty at construction time, returning AlertError::TelegramError if missing.
    - The notify method MUST: POST to https://api.telegram.org/bot{token}/sendMessage with JSON body containing chat_id and text fields.
    - The notify method MUST be annotated with #[::tracing::instrument(skip_all)].
    - On HTTP call failure: .tap_err(|e| ::tracing::error!(error = %e, "Telegram sendMessage HTTP request failed")) BEFORE the ? operator.
    - On non-2xx response status: construct an AlertError::TelegramError with the status code, log with ::tracing::error!(status = %status, "Telegram API returned non-2xx status"), and return Err.
    - On success (2xx): ::tracing::debug!(chat_id = %chat_id, "Telegram notification delivered successfully").

  - Redis Config Subscriber Adapter (src/adapters/redis_config_subscriber.rs):
    - Construct with a redis::Client connection.
    - The subscribe method MUST: create a bounded tokio::sync::mpsc::channel with explicit capacity (e.g., 16). Spawn a background task that subscribes to Redis Pub/Sub channel "alert-config-updates", deserializes each message as AlertConfig JSON, and sends it through the mpsc::Sender. Return the Receiver to the caller.
    - The internal subscription loop is covered in Step 4 (Config Listener Task).

  - Kafka Consumer Adapter: Reuse the shared KafkaLogConsumer from src/adapters (same adapter used by other consumer tracks), configured with consumer group "alert-consumer-group" and topic "alerts-priority-stream".

- **Step 4: The Actor Loops**

  - Config Listener Task (src/alert/config_loop.rs):
    - This function MUST be annotated with #[::tracing::instrument(skip_all)].
    - Accepts: redis_url (&str), config_cache (Arc<tokio::sync::RwLock<AlertConfig>>).
    - Resilient Socket Mechanics: The entire Redis Pub/Sub subscription MUST be wrapped in an outer infinite loop. Inside the outer loop: (1) attempt to connect to Redis and subscribe to "alert-config-updates", (2) if connection fails, log with ::tracing::error!(error = %e, "Redis Pub/Sub connection failed, retrying"), sleep for 5 seconds using tokio::time::sleep, and continue the outer loop, (3) if connection succeeds, enter an inner loop reading messages from the subscription.
    - In the inner message loop: deserialize each Pub/Sub message payload as AlertConfig JSON. On deserialization failure: .tap_err(|e| ::tracing::error!(error = %e, "Failed to deserialize AlertConfig from Pub/Sub message")), and continue the inner loop (skip the bad message). On success: acquire a write lock on the config_cache RwLock, replace the AlertConfig value, and log ::tracing::debug!(threshold = %new_config.threshold, window = %new_config.window_seconds, "AlertConfig updated from Pub/Sub").
    - If the inner loop exits (subscription dropped), log ::tracing::error!("Redis Pub/Sub subscription dropped, reconnecting"), and continue the outer loop (which will re-connect after sleeping).

  - Event Processor Task (src/alert/run_loop.rs):
    - This function MUST be annotated with #[::tracing::instrument(skip_all)].
    - Accepts: consumer (KafkaLogConsumer), rate_limiter (impl RateLimiter), notifier (impl AlertNotifier), config_cache (Arc<tokio::sync::RwLock<AlertConfig>>), metrics handles.
    - The main processing loop:
      1. Poll the Kafka consumer for the next message from alerts-priority-stream.
         - On consumer poll failure: .tap_err(|e| ::tracing::error!(error = %e, "Kafka consumer poll failed on alerts-priority-stream")), increment logger_events_processed_total{stage="alert", status="error"}, and continue the loop.
      2. Deserialize the message payload into the normalized log struct (the same struct produced by the Normalization Worker). Extract app_name and error_code.
         - On deserialization failure: .tap_err(|e| ::tracing::error!(error = %e, "Failed to deserialize alert message payload")), increment logger_events_processed_total{stage="alert", status="error"}, and continue the loop.
      3. Compute the SHA-256 fingerprint from (app_name, error_code) using the pure function from Step 2.
      4. Read the current AlertConfig from the RwLock (acquire a read lock, clone, release immediately — do NOT hold the read lock across any .await point).
      5. Call rate_limiter.check_and_increment(fingerprint, config.window_seconds, config.threshold, config.window_seconds + 10).
         - On Redis failure: .tap_err(|e| ::tracing::error!(error = %e, fingerprint = %fingerprint, "Rate limiter check_and_increment failed")), increment logger_events_processed_total{stage="alert", status="error"}, do NOT commit the Kafka offset for this message, and continue the loop.
         - On Ok(false) — threshold not yet breached or already breached previously: ::tracing::debug!(fingerprint = %fingerprint, "Dedup check passed, threshold not breached"), increment logger_events_processed_total{stage="alert", status="success"}, commit the Kafka offset, and continue.
         - On Ok(true) — threshold just breached, notification permitted:
      6. Format the notification message using the pure formatter from Step 2.
      7. Call notifier.notify(formatted_message).
         - On Telegram failure: .tap_err(|e| ::tracing::error!(error = %e, fingerprint = %fingerprint, "Telegram notification dispatch failed")), increment logger_events_processed_total{stage="alert", status="error"}, do NOT commit the Kafka offset, and continue the loop.
         - On Telegram success: ::tracing::debug!(fingerprint = %fingerprint, "Alert notification fired to Telegram"), increment logger_alerts_fired_total, increment logger_events_processed_total{stage="alert", status="success"}, and commit the Kafka offset.

    - Strict Offset Management: Kafka consumer offsets MUST only be committed after the entire processing pipeline for a message has succeeded (dedup check + optional notification). If any downstream step fails, the offset MUST NOT be committed so the message will be re-delivered on the next poll cycle.

    - Async-Blocking Safety: The RwLock read on config_cache MUST be performed via a synchronous clone-and-drop pattern (let config = config_cache.read().await.clone();) so that the lock guard is NOT held across any subsequent .await calls (Redis, Telegram).

---

## Phase 4: Monolith Integration

- **Wiring Directives (in apps/src/main.rs, under the "--role alert-consumer" branch):**

  1. Instantiate the KafkaLogConsumer with the configured Kafka broker addresses, consumer group "alert-consumer-group", and topic "alerts-priority-stream".
  2. Instantiate the RedisRateLimiter with the configured Redis URL. The Lua script body is embedded as a static constant inside the adapter.
  3. Instantiate the TelegramNotifier with a reqwest::Client, reading TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from environment variables. If either variable is missing, the process MUST exit with a descriptive error (not a panic — use a Fallible return with tracing::error).
  4. Create the config_cache as Arc<tokio::sync::RwLock<AlertConfig>> initialized with default values: threshold = 100, window_seconds = 60. Use bon::Builder for construction.
  5. Register exactly two metric families to the Prometheus registry:
     - logger_events_processed_total (IntCounterVec with labels ["stage", "status"]) — this is the shared global metric; register it once at process startup if not already registered.
     - logger_alerts_fired_total (IntCounter) — track-specific counter.
     - NO other metrics. Do NOT register logger_alert_errors_total or any other invented metric.
  6. Spawn the config listener task: tokio::spawn(crate::alert::config_loop(redis_url, config_cache.clone())). This task runs for the lifetime of the process.
  7. Spawn the event processor task: tokio::spawn(crate::alert::run_loop(consumer, rate_limiter, notifier, config_cache.clone(), metrics_handles)). This task runs for the lifetime of the process.
  8. Both spawned tasks MUST have their JoinHandles collected for graceful shutdown. On SIGTERM/SIGINT (via tokio::signal), the consumer MUST be paused and both tasks awaited with a bounded timeout before process exit.

### 4.2 Metric Ledger (Closed-World Compliance)

This track uses EXACTLY TWO metrics:
- logger_events_processed_total with label stage="alert" and label status="success" or "error"
- logger_alerts_fired_total (IntCounter)

No other metrics are permitted. The following metric names are EXPLICITLY FORBIDDEN in this track:
- logger_alert_errors_total (HALLUCINATED — does not exist)
- Any metric name not in the 6-metric closed-world set

### 4.3 Observability Ledger (Tracing Boundary Compliance)

Functions that MUST carry #[::tracing::instrument(skip_all)]:
- run_loop
- config_loop
- RedisRateLimiter::check_and_increment
- TelegramNotifier::notify
- RedisConfigSubscriber::subscribe

Calls that MUST carry .tap_err(|e| ::tracing::error!(...)) BEFORE any ? operator:
- redis EVAL inside check_and_increment
- reqwest POST inside notify
- consumer.poll() inside run_loop
- Message deserialization inside run_loop
- config pub/sub deserialization inside config_loop

Calls that MUST carry ::tracing::debug!(...) or ::tracing::info!(...) on success:
- After successful check_and_increment with fingerprint and count
- After successful Telegram notification with chat_id
- After successful config update from Pub/Sub
- After full pipeline completion per message with fingerprint

### 4.4 Exit Gate (Track Acceptance Criteria)

- [ ] "cargo fmt --check" passes with zero warnings.
- [ ] "cargo clippy -- -D warnings" passes with zero warnings.
- [ ] "cargo nextest run" passes with all five BDD scenarios GREEN.
- [ ] Zero occurrences of .unwrap(), .expect(), panic!(), todo!(), or unimplemented!() in this track's code.
- [ ] Zero occurrences of std::sync::Mutex held across .await points.
- [ ] Zero mock or stub data interfaces — all adapters use real redis, reqwest, and rdkafka clients.
- [ ] The Redis Lua script uses atomic INCR and EXPIRE within the same EVAL call.
- [ ] Redis keys are never written without a strict TTL (window_seconds + 10).
- [ ] Offsets are committed ONLY after the deduplication check and optional notification succeed.
- [ ] logger_alerts_fired_total is incremented exactly once per successful Telegram API 2xx response.
- [ ] logger_events_processed_total{stage="alert", status="success"} is incremented exactly once per fully processed message.
- [ ] No metric names outside the 6-metric closed-world set appear anywhere in the code.
- [ ] All #[::tracing::instrument(skip_all)] annotations are present.
- [ ] All .tap_err() calls are present on every fallible I/O call before the ? operator.
- [ ] All ::tracing::debug!() calls are present after every successful I/O completion.
