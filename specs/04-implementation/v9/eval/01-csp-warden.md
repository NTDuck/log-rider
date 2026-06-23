# Audit Report: v9 CSP and Concurrency Constraints

## Lens 1: The CSP Boundary Warden

### Track 3: DB Writer
**Status: PASS**
- **DAG-Only Verification:** Phase 3 explicitly outlines physical task boundaries using `run_fetcher_task` and `run_processor_task`.
- **Channel Primitives:** The DAG enforces explicit types (`tokio::sync::mpsc::Sender` and `Receiver`). Boundedness and backpressure are structurally verified in Phase 3 ("If the channel is full, this will naturally block").
- **Fetcher Constraint:** The Fetcher strictly handles `consumer.recv().await` and parsing. It is entirely devoid of business logic and database retries.
- **Processor Constraint:** The Processor manages db writes and exponential backoff without ever polling the external network socket ("Do NOT call consumer.recv() in the retry loop").

### Track 4: AI Consumer
**Status: PASS**
- **DAG-Only Verification:** Phase 3 contains the explicit programmatic instruction: "Creates a bounded `tokio::sync::mpsc` channel (e.g., capacity 100)."
- **Fetcher Constraint:** Task A strictly handles network ingestion (`consumer.recv()`) and sends payloads to the channel.
- **Processor Constraint:** Task B handles ONNX processing and egress. Retries are properly handled in-place without polling the Kafka socket ("Do NOT poll `consumer.recv()`").

### Track 6: WebSocket Server
**Status: REJECTED (FATAL VIOLATION)**
- **DAG-Only Verification:** While Phase 3 correctly decouples the Egress Task using a local `mpsc` channel, the primary `session_loop` acts as the Processor task (evaluating the `should_deliver` filtering logic) while *simultaneously* polling the client network socket.
- **Violation Detail:** Inside the `session_loop` execution DAG, "Branch 3 — Client Message / Close Detection" instructs the system to "Await the next incoming WebSocket message from the client `stream`". This forces the Processor task to directly poll the external TCP socket. This is a zero-tolerance violation of the directive: *Reject if the Egress/Processor task polls the external network socket directly*. The client WebSocket ingress listener MUST be physically separated into its own Fetcher task.

---

## Lens 2: The Single-Sink Enforcer

### Track 4: AI Consumer
**Status: PASS**
- **Outbox Pattern:** The DAG perfectly adheres to the Single-Sink pattern. Phase 3 limits egress purely to the `ai-tags-stream` Redpanda topic via the `KafkaTagPublisher` adapter.
- **Eradication Check:** A strict programmatic sweep confirms zero mentions of `ClickHouseSidecarWriter`, HTTP POSTs, or ClickHouse DB writes anywhere in the track. The architecture correctly leaves projection to an external process.
