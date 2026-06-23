# Architectural Evaluation: Resource Boundary Hacker

## 1. Streaming JSON Tokenizer Exploit (Track 1)
**Inspected:** `specs/04-implementation/v8/track-01-edge-receiver.md` (Step 2 - Pure Logic)

**Current Behavior:** The specification dictates using `serde_json::Deserializer::from_slice(bytes).into_iter::<serde_json::Value>()` to parse the JSON byte stream, manually checking depths and sizes on the fly "BEFORE constructing an AST in memory", explicitly forbidding recursion.

**Risk/Flaw:** This is a paradoxical constraint in Rust. The `into_iter::<serde_json::Value>()` method does not yield individual structural JSON tokens (like start-object or end-array); it yields fully constructed AST sub-trees (`serde_json::Value`). If the payload is a single 250KB JSON object, `into_iter` will block and allocate the entire AST in memory before yielding its first value, completely bypassing the fail-fast memory protection. Furthermore, `serde_json::Value` parsing is internally recursive. An attacker sending deeply nested JSON will trigger stack recursion inside the library long before the post-yield depth check can execute. Finally, an attacker can bypass property count limits by sending a single, extremely long scalar string value (e.g., 200KB) for an attribute, which will be loaded directly into RAM since string value lengths are unconstrained.

**Recommendation:** The instruction to use `into_iter::<serde_json::Value>` must be discarded. To achieve true zero-allocation stream parsing without recursion, the architecture must mandate a token-level pull-parser or a custom push-based state machine that can abort cleanly mid-stream. Additionally, architectural constraints must enforce hard byte limits on scalar values.

## 2. Memory Leak vs. Silent Data Loss in Backpressure (Track 3)
**Inspected:** `specs/04-implementation/v8/track-03-db-writer.md` (Step 4 - The Actor Loop)

**Current Behavior:** During a ClickHouse outage, the DB Writer pauses Kafka partitions and enters an exponential backoff loop. Inside this loop, it uses `tokio::select!` to poll `consumer.recv()` alongside the sleep to "maintain the rdkafka heartbeat," explicitly instructing the developer to "buffer or discard the result" of any pre-fetched messages.

**Risk/Flaw:** This creates a fatal structural trap. If the implementation chooses to "buffer" the results of `recv()`, a prolonged ClickHouse outage will cause the buffer to grow unbounded with pre-fetched messages, leading to a catastrophic Out-Of-Memory (OOM) crash. If the implementation chooses to "discard" the results to save memory, those messages are permanently lost from the current execution session. Because `rdkafka`'s internal fetcher state advances when `recv()` is called, committing the offset of the *original* pending batch after ClickHouse recovers will commit past the discarded messages, resulting in silent data loss.

**Recommendation:** Remove the instruction to poll `consumer.recv()` inside the retry sleep loop. The `rdkafka` C library automatically runs a background thread that handles broker heartbeats independently of `recv()` calls. To safely handle long backoffs without triggering rebalances or losing data, the architecture must decouple the consumer read loop from the blocking I/O write loop, or rely natively on rdkafka's background thread management with appropriate timeout tuning.

## 3. Cancellation Unsafety and Telemetry Corruption (Track 1)
**Inspected:** `specs/04-implementation/v8/track-01-edge-receiver.md` (Phase 4 - Monolith Integration)

**Current Behavior:** The Axum Router is wrapped in a `tower::timeout::TimeoutLayer` (e.g., 10 seconds) to sever Slowloris attacks. The handler produces to Kafka and is explicitly instructed to increment the `logger_events_processed_total` metric exactly once at the terminal outcome of the function.

**Risk/Flaw:** `TimeoutLayer` applies to the entire Axum handler future, not just the socket read phase. If the `rdkafka` `FutureProducer` is delayed by broker latency and takes longer than 10 seconds, the `TimeoutLayer` will aggressively drop the Axum handler's future. However, `rdkafka`'s `send` operation is not cleanly cancellation-safe in this context; the message is already enqueued in the C background thread and will still be published. The client receives an HTTP 408/504 and will likely retry, causing silent log duplication. Worse, because the future is dropped mid-flight, the terminal telemetry increment is never reached. Logs are successfully ingested into Kafka but completely invisible in the metrics, severely violating the strict closed-world observability contract.

**Recommendation:** Shift the Slowloris protection strictly to the socket or read-stream level rather than wrapping the entire request-response future. Ensure that once the payload enters the `produce` phase, its execution and corresponding telemetry updates are guaranteed to run to completion (e.g., by decoupling the write operation or utilizing an RAII drop guard).

## Confidence Level & Material Unknowns
**Confidence Level:** High. These findings identify deep semantic conflicts between Rust ecosystem behaviors (`serde_json`, Tokio cancellation, `rdkafka` internal thread mechanics) and the explicit mechanical directives of the v8 specs.

**Material Unknowns:** It is unknown if Redpanda's `max.poll.interval.ms` configuration will be tuned high enough to survive the maximum ClickHouse outage duration (60s backoff max) without rebalancing. This tuning dictates whether the Track 3 backpressure model is viable at all without a dedicated, decoupled ingestion thread.
