# Track 4: AI Consumer — v9

Trace: FR-007, User Story 3, Edge Case "No Sidecar UUID Joins"
Deployment: `--role ai-consumer`
Upstream: Redpanda topic "logs-normalized"
Downstream: Redpanda topic "ai-tags-stream"

---

## Phase 1: The Domain & Contracts

### 1.1 Trigger & Topology

The AI Consumer is activated via the CLI role flag `--role ai-consumer`. It joins a dedicated consumer group on the "logs-normalized" Redpanda topic, deserializes messages into the NormalizedLog model, classifies the message bodies via an ONNX runtime session, and publishes the tags as patch events to the "ai-tags-stream" Redpanda topic (the immutable ledger).

*Architectural Directive (The Outbox / Single-Sink Pattern)*: The AI Consumer MUST NOT write to ClickHouse and Redpanda sequentially. It must write its classification tag strictly to the `ai-tags-stream` Redpanda topic. A separate, independent projection process will move those tags to ClickHouse.

### 1.2 Data Schemas

AITag Model:
- log_id: Uuid — The UUID of the source log entry.
- model_version: String — Semantic version identifier of the ONNX model that produced the tag.
- tag: String — The classification label output by the model (e.g., "anomaly", "security", "performance").
- confidence: f32 — Model confidence score in the range 0.0..=1.0.
- tagged_at: DateTime64(3, 'UTC') — Timestamp of when classification occurred, set by the consumer at inference time.

AIError Variants (an Erratum enum):
- InferenceError: The ONNX runtime session returned an error during model execution.
- StreamPublishError: The rdkafka producer failed to deliver the tag patch to ai-tags-stream.
- ConsumerError: The rdkafka consumer failed to poll or deserialize a message.

### 1.3 Boundary Traits

AIClassifier Trait:
- Method: classify(message: borrowed str) -> Fallible containing Result of AITag or AIError.
- Semantic: Accepts the raw message body string, runs the ONNX session, and extracts the top-1 label and confidence to construct an AITag.

TagStreamPublisher Trait:
- Method: publish_patch(tag: borrowed AITag) -> Fallible containing Result of unit or AIError.
- Semantic: Serializes the AITag to JSON bytes and produces the message to the "ai-tags-stream" Redpanda topic.

### 1.4 Physical Constraints

- The Outbox / Single-Sink Pattern MUST be enforced: no secondary direct DB writes.
- The Decoupled Consumer Pattern MUST be enforced: Fetching and Processing must be split into two tasks connected by a bounded `mpsc` channel.
- Idempotent Cancellation MUST be enforced: Eradicate `tokio::sync::watch::Receiver`. Mandate `tokio_util::sync::CancellationToken`.
- `librdkafka` handles heartbeats autonomously. Do NOT poll `consumer.recv()` inside backoff/retry loops.
- ONNX inference MUST execute asynchronously via spawn_blocking wrapping the synchronous ort call.
- No unwrap, expect, panic, or todo.
- No mutex held across await points.

---

## Phase 2: The Behavioral Specification

### 2.1 The Gherkin Feature: AI Consumer Classification

Feature: AI Consumer Classification

  Scenario 1: Logs are successfully classified and published to stream
    Given a batch of log payloads have been published to "logs-normalized"
    And the ONNX runtime is initialized with a valid model
    When the Fetcher Task polls and pushes a batch of messages to the mpsc channel
    And the Processor Task extracts the message bodies and invokes the AIClassifier::classify method
    Then the classify call MUST return AITags with valid tags and confidences
    And the Processor Task MUST call TagStreamPublisher::publish_patch for each tag
    And the Processor Task MUST commit the Redpanda consumer offsets ONLY after all publish_patch calls succeed
    And logger_events_processed_total with status="success" MUST be incremented by the batch size OUTSIDE of any retry loops

  Scenario 2: ONNX classification fails
    Given a log payload has been published to "logs-normalized"
    And the ONNX model returns an inference error
    When the Processor Task attempts to classify the message
    Then the classify call MUST return an InferenceError
    And the Processor Task MUST NOT include this tag in publish_patch
    And logger_events_processed_total with status="error" MUST be incremented by 1
    And the Processor Task MUST commit the offset to skip the poison message

  Scenario 3: ai-tags-stream publish fails (Decoupled Backpressure)
    Given the tags have been successfully classified
    When the Processor Task attempts to call publish_patch
    And the rdkafka producer returns a StreamPublishError
    Then the Processor Task MUST enter a backoff loop retrying publish_patch in place
    And the retry sleep MUST be selectable against the CancellationToken
    And the mpsc channel MUST fill up, naturally blocking the Fetcher Task via TCP backpressure
    And the Fetcher Task MUST NOT call consumer.recv() while blocked
    And the telemetry counter MUST NOT be incremented during the retry loop
    And upon successful retry, the Processor Task MUST proceed to commit offsets

### 2.2 Crucial Directive

Do NOT write any application logic until the cucumber step definitions for all scenarios above are scaffolded and the BDD runner confirms they FAIL (red phase).

### 2.3 BDD World Struct

AIWorld:
- Fields: consumer, classifier, publisher, received_messages (Vec), generated_tags (Vec), metric_snapshot, cancellation_token.

---

## Phase 3: The Execution DAG (The Core Engine)

### Step 1: Scaffold BDD Tests

1.1. Create a Gherkin feature file at tests/features/ai_consumer.feature containing all three scenarios.
1.2. Create step definitions implementing AIWorld.
1.3. Run tests and ensure they fail.

### Step 2: Pure Logic — Message Extraction & Tag Construction

2.1. Implement pure function extract_message_body.
2.2. Implement pure function build_ai_tag.
2.3. Both functions MUST be total (no Result).

### Step 3: Infrastructure Adapters

3.1. OnnxClassifier Adapter:
- Initialize ort::Session with intra_threads(1). Wrap in Arc.
- classify method: Run session.run() in spawn_blocking. Instrument with tracing and tap_err.

3.2. KafkaTagPublisher Adapter:
- publish_patch method: Serialize AITag to JSON, build FutureRecord, call producer.send().
- Instrument with tracing skip_all and tap_err.

### Step 4: The Actor Loop — The Decoupled Consumer

4.1. Define run_classification_loop.
- Accepts: Arc StreamConsumer, Arc dyn AIClassifier, Arc dyn TagStreamPublisher, reference to Prometheus IntCounterVec, and a CancellationToken.
- Creates a bounded `tokio::sync::mpsc` channel (e.g., capacity 100).
- Spawns Task A (Fetcher) and Task B (Processor).

4.2. Task A (Fetcher Loop):
  - Enters a loop.
  - Uses `select!` on:
    1. `consumer.recv()`
    2. `cancellation_token.cancelled()`
  - On `cancellation_token` trigger: cleanly break the loop.
  - On `recv()` success: parse, and send to the `mpsc` channel.
  - *Decoupled Backpressure*: If the `mpsc` channel is full, the `.send().await` naturally blocks. This blocks `consumer.recv()`, naturally pushing backpressure to the TCP socket, leaving pre-fetched messages safely inside `librdkafka`'s internal queues while it autonomously handles heartbeats.

4.3. Task B (Processor Loop):
  - Enters a loop.
  - Uses `select!` on:
    1. `mpsc::Receiver::recv_many()` (or batching logic)
    2. `cancellation_token.cancelled()`
  - On `cancellation_token` trigger: cleanly break the loop.
  - For the received batch:
    
    a. CLASSIFY: Iterate the batch. Call `classifier.classify`. On `InferenceError`, increment error metric OUTSIDE retry loops, log, and mark offset for commit. On success, accumulate to `tags_batch`.
    
    b. PUBLISH BATCH (Outbox Pattern):
       - Iterate `tags_batch` and call `publisher.publish_patch`.
       - On `StreamPublishError`:
         1. Enter an in-place retry loop.
         2. The retry sleep MUST be wrapped in a `select!` alongside `cancellation_token.cancelled()`.
         3. Do NOT poll `consumer.recv()`. Do NOT call `consumer.pause()`. The backpressure will naturally propagate to Task A.
         4. Do NOT increment telemetry inside this retry loop.
         5. Break loop on success.
    
    c. COMMIT OFFSET:
       - Find the highest offset in the batch per partition and call `consumer.commit`.
       - Offsets are NEVER committed before publish succeeds.
    
    d. INCREMENT SUCCESS:
       - Increment `logger_events_processed_total{stage="ai_consumer", status="success"}` by the number of successfully published messages.
       - This increment MUST occur OUTSIDE of any infinite retry loops.

---

## Phase 4: Monolith Integration

### 4.1 Wiring Directives

In apps/src/main.rs, within the CLI role match arm for "ai-consumer":

1. Initialize rdkafka StreamConsumer ("ai-consumer-group", enable.auto.commit=false). Wrap in Arc.
2. Initialize OnnxClassifier.
3. Initialize KafkaTagPublisher.
4. Obtain the shared logger_events_processed_total IntCounterVec.
5. Obtain the global application CancellationToken.
6. Invoke run_classification_loop, passing all adapters, metrics, and the token.

### 4.2 Metric Ledger (Closed-World Compliance)

Exactly ONE metric:
- logger_events_processed_total with label stage="ai_consumer" and label status="success" or "error".

Forbidden metrics (Hallucinations):
- logger_ai_inference_success_total
- logger_ai_sidecar_error_total
- logger_ai_inference_duration_seconds

### 4.3 Observability Ledger

- skip_all instrumentation on all major boundaries.
- .tap_err() calls before all ? operators.
- debug!() tracking on success.

### 4.4 Exit Gate (Track Acceptance Criteria)

- [ ] "cargo fmt --check" and clippy pass.
- [ ] BDD scenarios GREEN.
- [ ] Zero unwrap(), expect(), panic!(), or todo!().
- [ ] The Outbox/Single-Sink pattern is used (Redpanda only, no DB writes).
- [ ] The Decoupled Consumer pattern is used (Fetcher and Processor are separate tasks connected by mpsc).
- [ ] Task A strictly handles recv(). Task B strictly handles processing, publishing, and committing.
- [ ] Task B retries publish errors in-place, without polling recv() or pausing the consumer.
- [ ] Cancellation Safety: tokio_util::sync::CancellationToken is strictly used instead of watch::Receiver.
- [ ] Telemetry Safety: logger_events_processed_total is incremented OUTSIDE infinite retry loops.
- [ ] Offsets are committed ONLY after publish succeeds.
