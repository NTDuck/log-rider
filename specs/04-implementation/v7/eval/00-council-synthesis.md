# v7 Council Evaluation: Foundational Blindspots

## The Verdict
The v7 implementation tracks succeeded in enforcing the DAG structure, but failed catastrophically at the asynchronous boundaries. The current state represents **Semantic Overfitting**: the agents correctly declared the constraints, but mechanically implemented structures that guarantee distributed deadlocks, metric corruption, and data loss.

**CRITICAL ANTI-OVERFIT DIRECTIVE FOR v8:**
Do NOT treat this document as a simple "todo list". If you simply add a `TimeoutLayer` or change a consumer group name, you will fail the v8 audit. You must **re-architect** the fundamental relationship between state, I/O boundaries, and actor loops. 

## 1. State, Consistency, & The Kafka Loop

**The Rebalance Death Spiral**
* **The Flaw:** Backpressure is implemented by `consumer.pause()` followed by an infinite `while/sleep` or `tokio-retry` loop waiting for ClickHouse. Because the actor is asleep, it stops calling `consumer.recv().await`. 
* **The Catastrophe:** `rdkafka` requires `recv()` calls to yield control for heartbeat background tasks. A 5-minute database outage breaches `max.poll.interval.ms`, causing the Kafka broker to violently evict the worker. The cluster will enter a perpetual rebalance thrashing loop.
* **The Structural Fix:** Backpressure loops *must* yield to the broker or run the retry in a separate task while the main consumer loop continues to poll (but immediately pauses/buffers).

**The Non-Transactional Dedup Blackhole**
* **The Flaw:** Alert Consumer checks Redis, increments the rate-limit token, *then* calls the Telegram API. If Telegram throws a 503 HTTP error, the DAG dictates withholding the Kafka offset. 
* **The Catastrophe:** On the immediate retry, the token bucket increments again, fails the rate limit, and commits the offset *without sending the alert*. A transient HTTP error permanently deletes the alert.
* **The Structural Fix:** Redis mutations and external I/O cannot be split across a retry boundary without a rollback mechanism or idempotency key.

**Configuration Split-Brain (Amnesia)**
* **The Flaw:** Admin API updates ClickHouse, then fire-and-forgets a Redis Pub/Sub event. The Alert Consumer is forbidden from polling ClickHouse and relies solely on Pub/Sub. 
* **The Catastrophe:** If the Redis publish fails, the Admin API returns 201 OK, but the Alert cluster will never see the update until manual restart.
* **The Structural Fix:** Event-driven config distribution requires a reconciliation mechanism (e.g., periodic background polling or guaranteed delivery), not just raw Pub/Sub.

## 2. Resource & Topology Leaks

**Unbounded Connection OOMs**
* **The Flaw:** Edge has a 256KB body limit but no `TimeoutLayer` (Slowloris vulnerability). WebSocket server caps channels at 1024 but has no limit on concurrent connection upgrades.
* **The Catastrophe:** Malicious actors can hold thousands of 1-byte/min connections or infinitely spawn WebSocket Tokio tasks until the host exhausts file descriptors and OOMs.
* **The Structural Fix:** Connection duration and concurrent upgrade counts must be physically bounded at the router level.

**Topology Paralysis**
* **The Flaw:** WebSockets share the `"ws-server-cg"` consumer group.
* **The Catastrophe:** Only one WS instance will receive a given Kafka message. You cannot horizontally scale the WS tier to multiple pods without partitioning the users.

## 3. The ClickHouse / AI Bottleneck
* **The Flaw:** The AI Consumer inserts inference results row-by-row into ClickHouse via HTTP.
* **The Catastrophe:** ClickHouse dies under high-frequency, single-row inserts. It requires batched asynchronous ingestion. 

## 4. Telemetry Corruption
* **The Flaw:** Error retries increment the "processed" counter *inside* the infinite loop. WebSocket fan-outs increment "processed" per connected client.
* **The Catastrophe:** A 5-minute outage artificially inflates `events_processed_total` by thousands of fake retries. 100 WS clients multiply the ingestion metric by 100.
* **The Structural Fix:** Telemetry must be mathematically isolated from fan-out loops and retry cycles. Count *messages consumed*, not *delivery attempts*.
