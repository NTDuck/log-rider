# Memory Auditor (OOM Preventer) Report

**1. Exact File Paths Inspected:**
- `specs/05-execution/v1/track-01-edge-receiver-tasks.md`
- `specs/05-execution/v1/track-05-alert-consumer-tasks.md`
- `specs/05-execution/v1/track-06-websocket-server-tasks.md`
- `specs/04-implementation/v10/track-01-edge-receiver.md`
- `specs/04-implementation/v10/track-05-alert-consumer.md`
- `specs/04-implementation/v10/track-06-websocket-server.md`

**2. Current Behavior in the Artifacts:**
- **Track 1 (Edge Receiver):** Task D.1 in `track-01-edge-receiver-tasks.md` instructs wiring the Axum router but omits the explicit configuration of `axum::extract::DefaultBodyLimit`. It mentions `tower::timeout::TimeoutLayer` and streaming parsing, but misses the crucial socket-level body limit layer.
- **Track 5 (Alert Consumer):** Task C.1 in `track-05-alert-consumer-tasks.md` instructs the implementation of `RedisRateLimiter` (Transactional Commit) but fails to explicitly mandate a strict TTL (`window_seconds + 10`) for the Lua Token Bucket EVAL call.
- **Track 6 (WebSocket Server):** Task D.1 in `track-06-websocket-server-tasks.md` successfully mandates "create bounded `tokio::sync::broadcast` channel (capacity 1024)".

**3. Correctness Risks:**
- **Track 1:** Missing `DefaultBodyLimit` creates an OOM / DoS vulnerability where the Axum server could attempt to buffer excessively large payloads into memory before the streaming parser logic even begins processing.
- **Track 5:** Missing strict TTL enforcement on Redis Lua EVAL calls means deduplication keys could persist indefinitely, leading to unbounded memory growth and eventual Redis OOM crashes.
- **Track 6:** None. The bounded capacity prevents memory exhaustion from backlogged clients.

**4. Recommendations:**
- **Track 1 (Edge Receiver):** **Amend**. Update Task D.1 to explicitly require `axum::extract::DefaultBodyLimit::max(256 * 1024)` on the Axum router.
- **Track 5 (Alert Consumer):** **Amend**. Update Task C.1 to explicitly mandate passing a strict TTL (`window_seconds + 10`) to the Redis Lua Token Bucket EVAL call.
- **Track 6 (WebSocket Server):** **Pass**.

**5. Confidence Level:**
- **100% (High)**. The missing directives were confirmed by directly reading the specified generated task files and comparing them against the requested memory defense invariants.
