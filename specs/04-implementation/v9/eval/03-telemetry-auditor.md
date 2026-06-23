# Telemetry Ledger Auditor Report (Lens 5)

**Auditor:** The CSP and Concurrency Auditor  
**Directive:** Verify mathematical telemetry isolation.  
**Rejection Criteria:** Reject if `logger_events_processed_total` is incremented inside a retry loop, or if it is tied to an intermediary channel push rather than the terminal completion of the processing task.

## Evaluation Result: REJECTED

### Violation Found in Track 06 (WebSocket Server)

**Location:** `specs/04-implementation/v9/track-06-websocket-server.md` -> Phase 3 (The Execution DAG) -> Step 4: The Ingestion Loop

**Description of Violation:**
The DAG explicitly instructs the ingestion loop to increment `logger_events_processed_total` immediately after pushing the message into an intermediary memory channel:

> "Call `broadcast_tx.send(msg)`. [...] Increment `logger_events_processed_total` with stage "ws" and status "success" EXACTLY ONCE per consumed message (not per connected client), OUTSIDE of any fan-out loops. Count the message consumed, not the delivery attempts."

The `broadcast_tx` is a `tokio::sync::broadcast` channel, which acts as an in-memory intermediary buffer connecting the Kafka ingestion loop to the individual WebSocket `session_loop` tasks. 

By incrementing the metric at this stage, the telemetry is mathematically **tied to an intermediary channel push** rather than the **terminal completion of the processing task** (the actual egress delivery attempt to the clients). 

If a WebSocket client is lagging and its local `mpsc` egress channel becomes full, the DAG states that the `session_loop` will drop the message and sever the connection. However, because the ingestion loop has already incremented `logger_events_processed_total` upon successfully pushing to the internal `broadcast_tx` channel, the telemetry ledger records a "success" even if the message drops dead in memory before reaching the client socket. This breaks mathematical telemetry isolation and creates false confidence.

---

### Review of Other Tracks (Pass)
* **Track 01 (Edge Receiver):** The DAG states the metric must be incremented exactly once at the terminal outcome of the HTTP handler *after* the cancellation-safe Kafka produce phase completes. Telemetry is explicitly forbidden inside infinite retry loops. (Pass)
* **Track 02 (Normalization Worker):** The Fetcher task pushes to an `mpsc` channel, but the metric is strictly incremented at the end of Task B (Processor) OUTSIDE of any retry loops, mapping to the true terminal processing of the record. (Pass)
* **Track 03 (DB Writer):** The Fetcher task pushes to an `mpsc` channel. The metric is explicitly incremented on batch success in the Processor task and explicitly forbidden from being incremented inside the exponential backoff retry loop. (Pass)
* **Track 04 (AI Consumer):** The metric is incremented at the end of the Processor Loop completely outside of the `StreamPublishError` in-place retry loop. (Pass)
* **Track 05 (Alert Consumer):** The metric is incremented at the end of the processing pipeline, strictly outside the Telegram backoff/retry loop. (Pass)
* **Track 07 (Admin API):** The metric is incremented exactly once upon overall success of the request (terminal completion). (Pass)
