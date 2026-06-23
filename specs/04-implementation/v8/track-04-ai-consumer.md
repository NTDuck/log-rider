# Track 4: AI Consumer — v8

Trace: FR-007, User Story 3, Edge Case "No Sidecar UUID Joins"
Deployment: `--role ai-consumer`
Upstream: Redpanda topic "logs-normalized"
Downstream: ClickHouse sidecar table "log_ai_tags", Redpanda topic "ai-tags-stream"

---

## Phase 1: The Domain & Contracts

### 1.1 Trigger & Topology

The AI Consumer is activated via the CLI role flag `--role ai-consumer`. It joins a dedicated consumer group on the "logs-normalized" Redpanda topic, deserializes messages into the NormalizedLog model in bounded batches, classifies the message bodies via an ONNX runtime session, writes the resulting tags as a batch to the ClickHouse "log_ai_tags" sidecar table (to prevent ClickHouse connection exhaustion), and publishes the tags as patch events to the "ai-tags-stream" Redpanda topic.

### 1.2 Data Schemas

AITag Model:
- log_id: Uuid — The UUID of the source log entry. Used ONLY for sidecar correlation via ClickHouse Dictionaries, NEVER for JOIN or IN(UUID) queries against the primary logs table.
- model_version: String — Semantic version identifier of the ONNX model that produced the tag.
- tag: String — The classification label output by the model (e.g., "anomaly", "security", "performance").
- confidence: f32 — Model confidence score in the range 0.0..=1.0.
- tagged_at: DateTime64(3, 'UTC') — Timestamp of when classification occurred, set by the consumer at inference time.

ClickHouse Sidecar Table Contract (log_ai_tags):
- Engine: MergeTree()
- PARTITION BY: toYYYYMM(tagged_at)
- ORDER BY: (log_id, model_version)
- Columns: log_id (UUID), model_version (LowCardinality(String)), tag (LowCardinality(String)), confidence (Float32), tagged_at (DateTime64(3, 'UTC'))
- TTL: tagged_at + INTERVAL 90 DAY
- Dictionary: A ClickHouse Dictionary MUST be defined over log_ai_tags to allow the dashboard layer to resolve tags by log_id without JOIN.

AIError Variants (an Erratum enum):
- InferenceError: The ONNX runtime session returned an error during model execution.
- SidecarWriteError: The ClickHouse HTTP insert to log_ai_tags failed.
- StreamPublishError: The rdkafka producer failed to deliver the tag patch to ai-tags-stream.
- ConsumerError: The rdkafka consumer failed to poll or deserialize a message.

### 1.3 Boundary Traits

AIClassifier Trait:
- Method: classify(message: borrowed str) -> Fallible containing Result of AITag or AIError.
- Semantic: Accepts the raw message body string, runs the ONNX session, and extracts the top-1 label and confidence to construct an AITag.

SidecarWriter Trait:
- Method: write_tags_batch(tags: slice of AITag) -> Fallible containing Result of unit or AIError.
- Semantic: Serializes the slice of AITags into a multi-line JSONEachRow HTTP INSERT payload and sends it to the ClickHouse log_ai_tags table endpoint. This implements batch asynchronous ingestion to prevent high-frequency single-row insert exhaustion.

TagStreamPublisher Trait:
- Method: publish_patch(tag: borrowed AITag) -> Fallible containing Result of unit or AIError.
- Semantic: Serializes the AITag to JSON bytes and produces the message to the "ai-tags-stream" Redpanda topic.

### 1.4 Physical Constraints

- No Sidecar UUID Joins: All sidecar tag lookups MUST be resolved via the ClickHouse Dictionary.
- ONNX inference MUST execute asynchronously via spawn_blocking wrapping the synchronous ort call.
- All internal memory channels MUST have explicit bounded capacity.
- No unwrap, expect, panic, or todo.
- No mutex held across await points.

---

## Phase 2: The Behavioral Specification

### 2.1 The Gherkin Feature: AI Consumer Classification

Feature: AI Consumer Classification

  Scenario 1: Logs are successfully classified and batched to sidecar
    Given a batch of log payloads have been published to "logs-normalized"
    And the ONNX runtime is initialized with a valid model
    When the AI Consumer polls and buffers a batch of messages
    And extracts the message bodies and invokes the AIClassifier::classify method
    Then the classify call MUST return AITags with valid tags and confidences
    And the consumer MUST call SidecarWriter::write_tags_batch to insert the batch into ClickHouse
    And the consumer MUST call TagStreamPublisher::publish_patch for each tag
    And the consumer MUST commit the Redpanda consumer offsets ONLY after both write_tags_batch and all publish_patch calls succeed
    And logger_events_processed_total with status="success" MUST be incremented by the batch size OUTSIDE of any retry loops

  Scenario 2: ONNX classification fails
    Given a log payload has been published to "logs-normalized"
    And the ONNX model returns an inference error
    When the AI Consumer attempts to classify the message
    Then the classify call MUST return an InferenceError
    And the consumer MUST NOT include this tag in write_tags_batch or publish_patch
    And logger_events_processed_total with status="error" MUST be incremented by 1
    And the consumer MUST commit the offset to skip the poison message

  Scenario 3: ClickHouse sidecar is offline (Anti-Blocking Backpressure)
    Given the ClickHouse sidecar table is unreachable
    When the AI Consumer attempts to call write_tags_batch
    Then write_tags_batch MUST return a SidecarWriteError
    And the consumer MUST immediately call consumer.pause on the assigned TopicPartitionList
    And the consumer MUST enter a backoff loop retrying write_tags_batch
    And inside the backoff loop, the consumer MUST select! between the retry sleep, consumer.recv() (to discard/buffer messages and maintain rdkafka heartbeat), and the shutdown signal
    And the telemetry counter MUST NOT be incremented during the retry loop (count the message, not the attempt)
    And upon successful retry, the consumer MUST call consumer.resume on the assigned TopicPartitionList
    And proceed to publish_patch and offset commit

  Scenario 4: ai-tags-stream publish fails (Anti-Blocking Backpressure)
    Given the tags have been successfully written to ClickHouse
    When the consumer attempts to call publish_patch
    And the rdkafka producer returns a StreamPublishError
    Then the consumer MUST pause the rdkafka consumer and enter the same select! Anti-Blocking backoff loop retrying publish_patch
    And the telemetry counter MUST NOT be incremented during the retry loop
    And upon successful retry, the consumer MUST resume and commit

### 2.2 Crucial Directive

Do NOT write any application logic until the cucumber step definitions for all four scenarios above are scaffolded and the BDD runner confirms they FAIL (red phase).

### 2.3 BDD World Struct

AIWorld:
- Fields: consumer, classifier, writer, publisher, received_messages (Vec), generated_tags (Vec), metric_snapshot.

---

## Phase 3: The Execution DAG (The Core Engine)

### Step 1: Scaffold BDD Tests

1.1. Create a Gherkin feature file at tests/features/ai_consumer.feature containing all four scenarios.
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

3.2. ClickHouseSidecarWriter Adapter:
- write_tags_batch method: Serialize the slice of AITags to a multi-line JSONEachRow string. POST to the ClickHouse endpoint. Check HTTP response.
- Instrument with tracing skip_all and tap_err.

3.3. KafkaTagPublisher Adapter:
- publish_patch method: Serialize AITag to JSON, build FutureRecord, call producer.send().
- Instrument with tracing skip_all and tap_err.

### Step 4: The Actor Loop — The Classification Consumer

4.1. Define run_classification_loop.
- Accepts: StreamConsumer, Arc dyn AIClassifier, Arc dyn SidecarWriter, Arc dyn TagStreamPublisher, reference to Prometheus IntCounterVec, and a shutdown signal receiver (e.g., CancellationToken).
- Loop operates on a batch collection model.

4.2. The loop body:

  a. POLLING & BATCHING:
     - Enter an inner loop bounded by a timeout (e.g., 1 second) or max batch size (e.g., 1000).
     - Call consumer.recv() in a select! alongside the timeout and the shutdown signal.
     - On shutdown signal: exit actor gracefully.
     - On recv() success: deserialize NormalizedLog. If deserialization fails, increment error metric, log, and add to commit offsets (skip poison). If success, accumulate in the batch.

  b. CLASSIFY BATCH:
     - Iterate through the accumulated batch.
     - Call classifier.classify.
     - On InferenceError: increment error metric OUTSIDE retry loops, log, and mark offset for commit (skip poison).
     - On success: push to a tags_batch vector.

  c. WRITE SIDECAR BATCH (Anti-Blocking Backpressure):
     - If tags_batch is not empty, call writer.write_tags_batch(&tags_batch).
     - On SidecarWriteError:
       1. consumer.pause(&partitions) to halt the fetch thread.
       2. Enter a backoff retry loop.
       3. CRITICAL: The retry sleep MUST be wrapped in a select! loop:
          - select! branch 1: sleep(backoff_duration). On wake, execute write_tags_batch retry. If Ok(), break retry loop.
          - select! branch 2: consumer.recv(). If it returns a message, buffer it in a secondary backlog or discard/skip it securely based on offset tracking, purely to YIELD TO RDKAFKA and maintain the consumer heartbeat to prevent broker eviction.
          - select! branch 3: shutdown_signal.changed(). If triggered, cleanly exit the actor from INSIDE the retry loop.
       4. CRITICAL: Do NOT increment logger_events_processed_total inside this retry loop. Count the message batch, not the retry attempt.
       5. On successful retry break, call consumer.resume(&partitions).

  d. PUBLISH PATCH BATCH (Anti-Blocking Backpressure):
     - Iterate tags_batch and call publisher.publish_patch.
     - On StreamPublishError:
       1. Apply the exact same consumer.pause() and select!-based Anti-Blocking Backpressure loop as step (c).
       2. Must poll shutdown_signal and consumer.recv() during the sleep.
       3. Do NOT increment telemetry inside the retry loop.
       4. consumer.resume(&partitions) on success.

  e. COMMIT OFFSET:
     - Find the highest offset in the batch per partition and call consumer.commit.
     - Offsets are NEVER committed before both write_tags_batch and all publish_patch calls succeed.

  f. INCREMENT SUCCESS:
     - Increment logger_events_processed_total{stage="ai_consumer", status="success"} by the number of successfully classified and published messages.
     - This increment MUST occur OUTSIDE of any infinite retry loops.

---

## Phase 4: Monolith Integration

### 4.1 Wiring Directives

In apps/src/main.rs, within the CLI role match arm for "ai-consumer":

1. Initialize rdkafka StreamConsumer ("ai-consumer-group", enable.auto.commit=false).
2. Initialize OnnxClassifier.
3. Initialize ClickHouseSidecarWriter.
4. Initialize KafkaTagPublisher.
5. Obtain the shared logger_events_processed_total IntCounterVec.
6. Obtain the global application CancellationToken or shutdown watch::Receiver.
7. Spawn the classification loop via tokio::spawn, passing all adapters, metrics, and the shutdown token.

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
- [ ] Sidecar writes use write_tags_batch instead of single-row inserts.
- [ ] Anti-Blocking Backpressure: consumer.pause() is called before every backoff retry loop.
- [ ] Anti-Blocking Backpressure: The retry sleep is wrapped in a select! loop that recursively polls consumer.recv() to maintain heartbeat and prevent rebalance spirals.
- [ ] Cancellation Saftey: The shutdown signal is recursively polled inside all inner retry loops.
- [ ] Telemetry Safety: logger_events_processed_total is incremented OUTSIDE infinite retry loops.
- [ ] consumer.resume() is called after successful retry recovery.
- [ ] Offsets are committed ONLY after both write and publish succeed.
