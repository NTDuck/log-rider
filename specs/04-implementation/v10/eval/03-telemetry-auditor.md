# Telemetry Ledger Auditor (Lens 5) - v10 Report

**Status:** 🔴 REJECTED

**Directives:**
- Verify mathematical telemetry isolation.
- Reject if `logger_events_processed_total` is incremented inside a retry loop, or if it is tied to an intermediary channel push rather than the terminal completion of the processing task.
- **DAG-Only Verification Rule:** Enforcement based exclusively on Phase 3 explicit programmatic instructions.

### Findings

#### Track 6 (WebSocket Server): PASS
In v9, this track failed Lens 5 because telemetry was tied to the intermediary `broadcast_tx` channel push. In v10, Phase 3 explicitly mandates a decoupled Egress Sink (Task C) and strictly instructs that `logger_events_processed_total` is incremented EXACTLY ONCE per delivery attempt, occurring *after* `sink.send().await` resolves. This successfully ties the telemetry to terminal completion rather than an intermediary memory push.

#### Tracks 2, 4, 5, 7: PASS
These tracks explicitly decouple telemetry from internal retry loops. Phase 3 mechanics dictate that `logger_events_processed_total` is incremented strictly *outside* of retry blocks, strictly occurring after the terminal completion of the outbox produce, batch publish, or database write.

#### Track 1 (Edge Receiver): 🔴 FAILURE (Structural Violation)
**Location:** `track-01-edge-receiver.md` -> Phase 3 -> Step 4

**Violation (Decoupled Telemetry Execution):** 
Phase 3 mandates that the `KafkaLogProducer.produce` phase must be "wrapped in a guaranteed-completion future or spawned `tokio::task` so it cannot be cancelled mid-flight by client disconnects" (Step 4.7). However, the DAG places the increment for `logger_events_processed_total` in the Axum handler's "Success Terminal" (Step 4.8). 

If a client drops the HTTP connection while the spawned task is in-flight, the Axum handler's execution is cancelled and aborted immediately. It will *never* reach Step 4.8. Meanwhile, the spawned task completes the Kafka write successfully in the background. The result is a ghost message: the log is stored in Kafka, but `logger_events_processed_total` drops the success increment because the metric is improperly tied to the lifecycle of the HTTP handler rather than the terminal completion of the spawned processing task.

#### Track 3 (DB Writer): 🔴 FAILURE (Ledger Omission on Retry)
**Location:** `track-03-db-writer.md` -> Phase 3 -> Step 4 (Flush Subroutine)

**Violation (Mathematical Omission):**
Phase 3 dictates an initial success path where the metric is correctly incremented by the batch length. However, inside the "Structural Backpressure Mechanics" failure path, it specifies an exponential backoff retry loop. It explicitly mandates: *"If the sleep completes, execute writer.write_batch(&batch).await. Do NOT increment metrics inside the loop."* 

While preventing increments *inside* the loop is correct, the DAG fails to instruct the agent to increment the telemetry once the retry loop succeeds. The instruction reads: *"On retry success: Emit info trace, commit offsets, and reset timer."* Because the metric increment is completely omitted from the retry success path, any batch that experiences a transient network failure will be successfully written to ClickHouse but will silently vanish from the telemetry ledger.

### Verdict
**REJECT.** Track 1 and Track 3 fail to maintain mathematical telemetry isolation. Track 1 structurally drops telemetry under network cancellation due to decoupled metric execution, and Track 3 drops telemetry for all retried batches due to explicit omission. Both Phase 3 DAGs must be rewritten to tie telemetry strictly to the terminal resolution of the I/O task.
