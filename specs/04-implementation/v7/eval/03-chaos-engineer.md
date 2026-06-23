# Chaos Engineering Architecture Evaluation (v7)

## 1. Slowloris HTTP Exhaustion
**Evidence Inspected:** `specs/04-implementation/v7/track-01-edge-receiver.md` (Phase 3, Step 4 & Phase 4, Step 6)
**Current Behavior:** The Axum HTTP Edge Receiver enforces a strict `DefaultBodyLimit` of 256KB to protect memory at the socket level.
**Correctness Risk / Structural Flaw:** There is no structural boundary for connection duration or time-to-first-byte. An attacker can easily open thousands of TCP connections and drip-feed a malicious 255KB payload at a rate of 1 byte per second. This will hold open the asynchronous worker tasks and socket connections for days, completely exhausting the server's connection pool and causing a Slowloris Denial of Service, bypassing the memory guardrails entirely.
**Recommendation:** Rethink the HTTP ingestion boundary to explicitly define temporal boundaries (strict request read timeouts) alongside spatial boundaries (body size limits).

## 2. Kafka Rebalance Death Spirals
**Evidence Inspected:** `specs/04-implementation/v7/track-03-db-writer.md` and `track-04-ai-consumer.md` (Phase 3, Step 4: The Actor Loop / Flush Subroutine)
**Current Behavior:** When the ClickHouse database or sidecar is offline, the consumer pauses its partitions and enters an indefinite `tokio::time::sleep` exponential backoff loop directly within the message processing branch of the actor loop.
**Correctness Risk / Structural Flaw:** By sleeping indefinitely inside the processing loop, the application permanently blocks `consumer.recv().await`. This starves the `librdkafka` thread of application-level polling. Once Kafka's `max.poll.interval.ms` (default 5 minutes) is breached, the broker assumes the consumer has died and forcefully revokes its partitions, triggering a rebalance. When the database eventually recovers, the consumer's pending offset commit will fail with a `CommitFailedException` because it no longer owns the partition. The consumer will rejoin, immediately block again, and cause a cascading death spiral of rebalances and duplicate processing across all instances.
**Recommendation:** Rethink the backpressure strategy to decouple asynchronous retry backoff from the synchronous requirement to periodically yield to the Kafka polling mechanism, ensuring group leases are maintained even when downstream I/O is halted.

## 3. Infinite Retry Metric Corruption
**Evidence Inspected:** `specs/04-implementation/v7/track-03-db-writer.md` and `track-04-ai-consumer.md` (Phase 3, Step 4: Flush Subroutine)
**Current Behavior:** Inside the exponential backoff loops triggered by downstream failures, the system is instructed to increment the `logger_events_processed_total{status="error"}` metric on every failed retry attempt.
**Correctness Risk / Structural Flaw:** This metric is semantically designed to measure *event throughput*. Because the system retries indefinitely (e.g., every 60 seconds while a database is offline for hours), a single stuck batch will generate thousands of phantom "processed" error events. This fundamentally corrupts the telemetry ledger, causing downstream Prometheus dashboards to report massive hallucinated processing spikes when the system is actually 100% stalled.
**Recommendation:** Structurally separate I/O operational telemetry from domain event throughput telemetry. Throughput must only be recorded at the terminal boundaries of a message's lifecycle.

## 4. Token Bucket Exploitation & Redelivery Swallow
**Evidence Inspected:** `specs/04-implementation/v7/track-05-alert-consumer.md` (Phase 1 ADR-0022 Batching Fallback vs. Phase 3, Step 4)
**Current Behavior:** The Alert Consumer implements a Redis-backed fixed-window counter. If the Telegram notification API returns an error, the consumer increments the error metric, intentionally skips committing the Kafka offset for that specific message, and immediately continues the loop to fetch the next message.
**Correctness Risk / Structural Flaw:** 
1. **Redelivery Swallow:** Kafka offsets are high-water marks, not individual ACKs. When the *next* message is successfully processed and its offset is committed, the skipped offset of the failed Telegram alert is implicitly committed. The critical alert is permanently swallowed and will never be redelivered.
2. **Token Exhaustion:** Because the Redis `INCR` operation succeeded before the Telegram failure, the "token" for that window is permanently consumed. Subsequent legitimate occurrences of that alert will be silenced because the threshold is already breached.
3. **Specification Paradox:** Phase 1 mandates that alerts exceeding the limit "MUST be batched into a single digest message rather than dropped", but the implementation DAG directly drops them by committing and continuing on `Ok(false)`.
**Recommendation:** Rethink error handling in sequential streams. A failed terminal action cannot selectively NACK a message while the partition advances. Unprocessable or failed deliveries must halt the partition until intervention or be routed to a durable DLQ. The rate-limiting logic must also be fundamentally restructured to honor the batching constraint rather than treating excess events as silently ignorable.

### Confidence Level and Material Unknowns
**Confidence Level:** Very High. The structural contradictions between Kafka's physical polling semantics, offset high-water marks, and the DAG's retry logic are absolute. 
**Material Unknowns:** It is unknown if the telemetry dashboard relies on rate-based anomaly detection, which the metric corruption would actively trigger, leading to secondary alerting storms.
