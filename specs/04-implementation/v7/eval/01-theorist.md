# Distributed Systems Architecture Evaluation: v7 Tracks

## 1. Exact file paths, concepts, or evidence inspected
- `specs/04-implementation/v7/track-02-normalization-worker.md`
- `specs/04-implementation/v7/track-03-db-writer.md`
- `specs/04-implementation/v7/track-04-ai-consumer.md`
- `specs/04-implementation/v7/track-05-alert-consumer.md`
- `specs/04-implementation/v7/track-07-admin-api.md`
- **Distributed Systems Concepts Applied:** Exactly-Once Semantics, Idempotency, Split-Brain Scenarios, Non-Transactional Dual-Writes, State Reconciliation.

## 2. The current behavior/implementation
- **Track 2 (Normalization Worker) & Track 4 (AI Consumer):** Both tracks execute non-transactional dual-writes. Track 2 sequentializes publishing to `logs-normalized` then `alerts-priority-stream`. Track 4 sequentializes writing to the ClickHouse sidecar `log_ai_tags` then publishing to `ai-tags-stream`. Kafka offsets are only committed after both operations succeed.
- **Track 3 (DB Writer):** Consumes batches from Kafka and inserts them into ClickHouse (`MergeTree`), committing offsets only on HTTP 200.
- **Track 5 (Alert Consumer):** Deduplicates logs by computing a fingerprint and executing a Redis Lua script (`INCR` + `EXPIRE`). If the counter exactly hits the threshold, it fires a Telegram alert. The internal configuration state is initialized using hardcoded defaults, dynamically updating only via a Redis Pub/Sub listener.
- **Track 7 (Admin API):** Appends new threshold configurations to ClickHouse and broadcasts them to Alert Consumers via a fire-and-forget Redis Pub/Sub channel.

## 3. Correctness risks, structural flaws, and edge cases
**A. Silent Alert Loss via Non-Transactional State Mutation (Track 5)**
The Alert Consumer executes state mutation in Redis before triggering side-effects (Telegram) and committing Kafka offsets. If the process crashes immediately after the Redis `INCR` reaches the exact threshold but before the Telegram notification is sent (or before offset commit), the consumer replays the message on restart. The subsequent `INCR` pushes the count to `threshold + 1`. The exact-match condition (`count == threshold`) evaluates to false, and the alert is permanently and silently lost. This violates exactly-once semantics by mutating state across an asynchronous boundary without transactional correlation.

**B. Permanent Split-Brain Configuration State (Track 5 & Track 7)**
The architecture relies on a fire-and-forget Redis Pub/Sub channel to reconcile configuration state between the Admin API and Alert Consumers. If the Redis broadcast fails, Track 7 explicitly dictates that the HTTP response must still be 201 Created. More critically, Track 7's spec claims "consumers will also read the latest config from ClickHouse on startup" to reconcile state, yet Track 5's wiring directives explicitly instruct initializing the configuration cache with hardcoded defaults (`threshold = 100, window_seconds = 60`) and only updating via Pub/Sub. Alert Consumers are structurally isolated from the ClickHouse source of truth, resulting in a permanent split-brain scenario upon network partitions or consumer restarts.

**C. Unbounded Data Duplication via At-Least-Once Dual-Writes (Tracks 2, 3, 4)**
Tracks 2 and 4 implement sequential dual-writes across separate IO boundaries (Kafka -> Kafka, and ClickHouse -> Kafka). Lacking a two-phase commit protocol, any crash between the first write and the offset commit forces a replay. Track 3 (DB Writer) consumes these replayed duplicates and inserts them into ClickHouse. Since the ClickHouse table engines are explicitly constrained to plain `MergeTree` (where `UPDATE` or deduplication via `ReplacingMergeTree` is strictly forbidden), the architecture guarantees silent data duplication, permanently corrupting downstream analytical accuracy.

## 4. Recommendation on how to structurally rethink the flawed approach
To restore architectural integrity and adhere to distributed systems laws, the architecture must abandon fragile dual-writes and decoupled state mutations:
- **Embrace Idempotent Sinks and Transactional Outboxes:** Eliminate dual-writes by consolidating state changes into a single durable log (e.g., Kafka) and relying on isolated, idempotent consumer offsets to project data into secondary systems (ClickHouse).
- **Decouple Evaluation from Side-Effects:** For rate-limiting, separate the counting state mutation from the alert execution. The evaluation of thresholds must emit an intermediate event rather than directly triggering external APIs, ensuring side-effects can be replayed safely.
- **Deterministic State Reconciliation:** Replace fire-and-forget Pub/Sub with a reliable pull-based reconciliation pattern or a persistent event-sourcing log for configurations. Consumers must deterministically sync with the authoritative source of truth on startup and recovery.

## 5. Confidence level and material unknowns
**Confidence Level: High.** The architectural directives defined in the Phase 3 and 4 tracks mathematically guarantee state divergence and data duplication under standard fault models (process crashes, network partitions). 
**Material Unknowns:** It is unknown whether the downstream analytics queries employ ad-hoc deduplication strategies (e.g., `LIMIT 1 BY log_id`), though the architectural restrictions strongly imply they rely on table-level append accuracy.
