# CSP and Concurrency Auditor Report
**Target:** `specs/04-implementation/v10/*`
**Lenses Applied:** 3 (Cancellation Safety) & 4 (Memory Defense)
**Constraint Enforced:** The DAG-Only Verification Rule

## Lens 3: The Cancellation Safety Inspector (All Tracks)

**DIRECTIVE:** Verify Idempotent Cancellation and Future shielding.
**Rejection Criteria:** 
- Reject if `tokio::sync::watch::Receiver` is used; it MUST be `tokio_util::sync::CancellationToken`. 
- Reject Track 1 if `TimeoutLayer` wraps the Kafka produce phase; it must only apply to the HTTP stream-read. 
- Reject Track 6 if `ws.send().await` is wrapped in `tokio::time::timeout`; it must rely on `mpsc` channel capacity to detect slow clients.

### Track 1: Edge Receiver ❌ [REJECTED]
- **Violation (DAG-Only Rule & Future Shielding):** Phase 3 structurally violates explicit task decoupling by relying on abstraction and improper layer boundaries.
- **Details:** Step 4.1 explicitly instructs the use of `tower::timeout::TimeoutLayer` inside the DAG to govern the HTTP stream-read. However, as a Tower Layer, it inherently wraps the entire Axum service/handler (and thus the Kafka produce phase). To work around this, Step 4.7 relies on abstraction, instructing that the produce phase be "wrapped in a guaranteed-completion future or spawned `tokio::task`". Under the strict DAG-Only Verification Rule, this fails because it relies on abstraction ("guaranteed-completion future") and inline spawning rather than explicitly decoupling the I/O fetch phase from the produce phase using mechanical channel primitives (`mpsc`).

### Track 2: Normalization Worker ✅ [PASSED]
- **Details:** Phase 3 explicitly decouples the consumer into Fetcher and Processor tasks connected by a bounded `mpsc` channel. Both tasks strictly mandate `tokio_util::sync::CancellationToken` and eradicate `watch::Receiver`.

### Track 3: DB Writer ✅ [PASSED]
- **Details:** Phase 3 explicitly decouples into Fetcher and Processor tasks using an `mpsc` channel. `CancellationToken` is explicitly mandated and polled recursively inside the ClickHouse HTTP insert retry loop.

### Track 4: AI Consumer ✅ [PASSED]
- **Details:** Phase 3 structurally decouples fetching and processing into separate tasks connected by an `mpsc` channel. The `CancellationToken` is correctly selected against inside the retry loops.

### Track 5: Alert Consumer ✅ [PASSED]
- **Details:** Phase 3 decouples into Fetcher and Processor tasks via an `mpsc` channel. It strictly uses `CancellationToken` for graceful shutdown, explicitly selecting against it in inner retry loops.

### Track 6: WebSocket Server ✅ [PASSED]
- **Details:** Phase 3 successfully meets the strict Track 6 rejection criteria. It explicitly decouples the connection into Task A (Ingress Fetcher), Task B (Processor), and Task C (Egress Sink). It strictly mandates pushing to a local bounded `mpsc` channel via `.try_send()` to detect slow clients via `Full` errors, and explicitly forbids wrapping `ws.send().await` in `tokio::time::timeout`.

### Track 7: Admin API ✅ [PASSED]
- **Details:** Phase 3 mandates `tokio_util::sync::CancellationToken` for internal retry loops (Step 3) and strictly forbids `tokio::sync::watch::Receiver` to prevent deadlocks.

---

## Lens 4: The Memory Defense Auditor (Track 1)

**DIRECTIVE:** Verify pure token-stream parsing.
**Rejection Criteria:** Reject if Track 1 instructs the use of `serde_json::Value`, `into_iter::<Value>()`, or building an AST. It MUST explicitly instruct the use of a low-level token scanner (e.g., `struson` or byte-level parsing) to count depth without allocation.

### Track 1: Edge Receiver ✅ [PASSED]
- **Details:** Phase 3 strictly adheres to the zero-allocation directive. Step 2.1 explicitly eradicates `serde_json::Deserializer::from_slice(bytes).into_iter::<serde_json::Value>()` and explicitly forbids building an AST (`serde_json::Value` or `WireLog`). Instead, it mandates a low-level token pull-parser (`struson` or a custom byte-scanner) to count `{` and `[` tokens directly from the byte stream, aborting before ANY memory allocation occurs if the nested depth exceeds 5.

---

## AUDITOR CONCLUSION
**Track 1 MUST be rewritten.** Its Execution DAG (Phase 3) fails Lens 3. By attempting to use `tower::timeout::TimeoutLayer` directly in the DAG and wrapping the produce phase in an abstract "guaranteed-completion future", it illegally relies on abstraction rather than explicitly using mechanical channel primitives and task boundaries to decouple the HTTP stream-read from the Kafka produce phase. All other tracks mechanically pass the CSP and Memory Defense audits.
