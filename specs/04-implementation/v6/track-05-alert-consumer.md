# Track 5: Alert Consumer

## Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role alert-consumer". It consumes logs from Redpanda topic "alerts-priority-stream". It connects to Redis for deduplication and token buckets, and sends notifications to Telegram API.
- **Data Schemas:**
  - AlertConfig Model:
    - threshold: U64
    - window_seconds: U64
  - AlertError Variants:
    - RedisError: Connection or query issues with rate limits.
    - TelegramError: Rate limits or request rejections from Telegram API.
    - ConsumerError: Consumer stream failures.
  - RateLimiter Boundary Trait:
    - Method: check_and_increment(fingerprint: str, window_sec: U64, limit: U64, strict_ttl: U64) -> Fallible Result containing boolean or AlertError vector.
  - AlertNotifier Boundary Trait:
    - Method: notify(message: str) -> Fallible Result.
  - ConfigSubscriber Boundary Trait:
    - Method: listen_for_updates() -> Receiver for dynamic AlertConfig objects.
- **Physical Constraints:**
  - Must run Lua Token Bucket rate limit scripts to protect Telegram API.
  - Must write keys to Redis using a strict TTL/eviction constraint to prevent infinite Redis memory growth.
  - Loss of ephemeral counting state on Redis crash is acceptable to protect the primary ingestion loop.

## Phase 2: The Behavioral Specification
- **The Gherkin Feature (Alert Tumbling Window & Notifications):**
  - Scenario 1: High-priority errors are deduplicated safely and limited.
    - Given a threshold configuration of 100 errors per 60 seconds.
    - When 150 errors with matching fingerprints are consumed.
    - Then the Alert Consumer MUST deduplicate them using Redis.
    - And apply a strict TTL to the tracking structures to prevent OOM.
    - And apply a Lua Token Bucket rate limit.
    - And fire exactly 1 notification to Telegram.
  - Scenario 2: Admin dynamically updates configurations.
    - Given the Alert Consumer is running.
    - When a configuration update is broadcast via Redis Pub/Sub.
    - Then the Alert Consumer MUST update its internal window and threshold limits in real-time.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

## Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AlertWorld cucumber tests.
- **Step 2: Pure Logic:** Implement SHA-256 fingerprint generation. Implement thread-safe RwLock cache for config storage.
- **Step 3: Infrastructure Adapters:** Build Redis adapters for Lua token bucket execution. Build Telegram HTTP notifier. Build Redis Pub/Sub subscriber listener.
- **Step 4: The Actor Loops:**
  - Config Listener Task:
    - Resilient Socket Mechanics: Wrap the Redis Pub/Sub configuration subscription thread in an infinite loop containing sleep reconnections to prevent config update stalls.
  - Event Processor Task: Consume from alerts-priority-stream, pull configuration limits from RwLock, perform Redis O(1) deduplication check, execute Lua Token Bucket rate check, send Telegram alerts.
  - Telemetry Bypass Prevention: Use tap error or match blocks on all rate limiter and notifier calls to increment logger_alert_errors_total and log errors before early return operators. Suffix fires with logger_alerts_fired_total increments.

## Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogConsumer, RedisRateLimiter, TelegramNotifier, and RedisConfigSubscriber.
  - Setup RwLock wrapping default AlertConfig (e.g., limit 100, window 60).
  - Register metrics logger_alerts_fired_total and logger_alert_errors_total.
  - Spawn config_loop and run_loop when role is alert-consumer.
