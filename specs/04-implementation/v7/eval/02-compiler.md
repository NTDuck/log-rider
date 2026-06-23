# Evaluation Report: The Asynchronous Rust Compiler Angle

## 1. Evidence Inspected
- `specs/04-implementation/v7/track-01-edge-receiver.md` (Phase 3, Step 4)
- `specs/04-implementation/v7/track-03-db-writer.md` (Phase 3, Step 4)
- `specs/04-implementation/v7/track-04-ai-consumer.md` (Phase 2 & Phase 3, Step 4)
- `specs/04-implementation/v7/track-06-websocket-server.md` (Phase 3, Step 3)
- Evaluated against `tokio` concurrency semantics (`tokio::select!` branch cancellation, blocking loops), `rdkafka` internal heartbeat and polling constraints, and underlying TCP backpressure mechanics.

## 2. Structural Flaws, Correctness Risks, and Edge Cases

### A. Defensive Mechanism Bypass (Track 1 - Edge Receiver)
- **Current Behavior**: The pipeline deserializes raw HTTP bytes directly into `serde_json::Value` (WireLog) via `serde_json::from_slice`, and *subsequently* runs an explicit, non-recursive stack (depth limit 5) to protect against DoS vectors.
- **Correctness Risk**: Building an untyped AST (`serde_json::Value`) inherently allocates heavily and utilizes recursion (up to `serde_json`'s internal limit). An attacker sending a 256KB payload of deeply nested objects will force massive CPU/memory allocation overhead BEFORE the explicit stack validator is ever reached. The architectural defense sits behind the vulnerability, rendering it useless.

### B. Kafka Protocol Violation via Await-Blocking (Tracks 3 & 4 - Consumers)
- **Current Behavior**: On database write failure, the consumer loops call `consumer.pause(&partitions)` and then enter a `tokio::time::sleep` exponential backoff retry loop. Only upon successful database write does the loop call `consumer.resume()`.
- **Correctness Risk (Resource Starvation/Deadlock)**: While the actor is trapped in the `.await` backoff loop, it stops calling `consumer.recv()`. The Kafka protocol (`max.poll.interval.ms`, typically 5 minutes) strictly requires continuous polling to serve rebalance callbacks and prove liveness. During a prolonged database outage, the broker will unilaterally kick the consumer from the group. When the database recovers, the consumer will awake, attempt to commit offsets and resume partitions it no longer owns, resulting in fatal `rdkafka` errors, state corruption, and endless rebalancing cycles.

### C. TCP Head-of-Line Starvation (Track 6 - WebSocket Server)
- **Current Behavior**: The session loop `select!`s between the bounded broadcast channel and the incoming client WebSocket stream. Upon receiving a broadcast log, it invokes `ws_sink.send(msg).await` inside the branch handler.
- **Correctness Risk**: `tokio::select!` executes branch handlers sequentially. If a slow or malicious client artificially restricts its TCP receive window to zero, `ws_sink.send` will pend indefinitely. Because the loop is blocked inside this branch, the actor completely stops polling the broadcast receiver (missing the `Lagged` error) AND stops polling the client stream (missing `Close` frames). The task leaks indefinitely, locking up server memory and artificially inflating the active connections gauge.

### D. Graceful Shutdown Evasion (Track 4 - AI Consumer)
- **Current Behavior**: The core loop is instructed to `select!` on a shutdown signal alongside the `consumer.recv()` future.
- **Correctness Risk (Cancellation Unsafety)**: When the actor hits an external failure (e.g., ClickHouse sidecar is down), it enters an indefinite tokio-retry loop *inside* the execution arm of the `consumer.recv()` branch. While trapped inside this branch handler, the outer `tokio::select!` macro is suspended and the `shutdown` signal is never polled. If a deploy/restart is triggered during an outage, the process will refuse to shut down, eventually resulting in a hard `SIGKILL` from the orchestrator and breaking the graceful exit contract.

## 3. Structural Recommendations

- **Deserialization Defenses**: Structural limits (depth, width) must be strictly enforced *during* the byte-stream parsing phase, intercepting tree construction at the parser boundary rather than validating an already-constructed AST in memory.
- **Asynchronous Backpressure**: Decouple partition pausing from the polling loop. Paused partitions still require the application to continuously poll the consumer to maintain group membership. Backoff state machines must yield to the polling loop rather than hijacking the entire actor.
- **Actor Non-Blocking I/O**: Network writes to untrusted clients must never block a select loop handling control planes (like broadcast receivers or close frames). Outbound streams require dedicated tasks or strict per-frame write timeouts to physically sever blocked sockets.
- **Select-Aware Cancellation**: Retry loops and extended blocking operations must recursively integrate cancellation tokens. Selecting at the top level of a loop is entirely ineffective if the loop body contains unbounded `.await` chains.

## 4. Confidence Level & Material Unknowns
- **Confidence Level**: Absolute. These flaws exploit fundamental characteristics of async Rust executor behavior and the Kafka consumer protocol. They will deterministically manifest in production under adversarial conditions (slowloris WebSocket clients) or degraded network states (DB outages).
- **Material Unknowns**: 
  - Axum defaults: It is unknown if global TCP timeouts are configured at the socket layer to eventually sever the Track 6 TCP deadlock.
  - librdkafka internals: Depending on the specific configuration of the `rdkafka` C-core, some heartbeats may continue independently, but application-level rebalances and offset commits will fundamentally break if `poll` is suspended.
