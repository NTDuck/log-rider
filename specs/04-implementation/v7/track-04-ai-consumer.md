# Track 4: AI Consumer — v7

Trace: FR-007, User Story 3, Edge Case "No Sidecar UUID Joins"
Deployment: --role ai-consumer
Upstream: Redpanda topic "logs-normalized"
Downstream: ClickHouse sidecar table "log_ai_tags", Redpanda topic "ai-tags-stream"

---

## Phase 1: The Domain & Contracts

### 1.1 Trigger & Topology

The AI Consumer is activated via the CLI role flag "--role ai-consumer". It joins a dedicated consumer group on the "logs-normalized" Redpanda topic, deserializes each message into the NormalizedLog model (defined in Track 2), classifies the message body via an ONNX runtime session, writes the resulting tag to the ClickHouse "log_ai_tags" sidecar table, and publishes the same tag as a patch event to the "ai-tags-stream" Redpanda topic.

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
- Dictionary: A ClickHouse Dictionary MUST be defined over log_ai_tags to allow the dashboard layer to resolve tags by log_id without JOIN. The dictionary source is the log_ai_tags table, keyed by log_id, returning tag, confidence, and model_version.

AIError Variants (an Erratum enum):
- InferenceError: The ONNX runtime session returned an error during model execution. Wraps the ort error source.
- SidecarWriteError: The ClickHouse HTTP insert to log_ai_tags failed. Wraps the reqwest error source.
- StreamPublishError: The rdkafka producer failed to deliver the tag patch to ai-tags-stream. Wraps the rdkafka error source.
- ConsumerError: The rdkafka consumer failed to poll or deserialize a message from logs-normalized. Wraps the rdkafka error source.

### 1.3 Boundary Traits

AIClassifier Trait:
- Method: classify(message: borrowed str) -> Fallible containing Result of AITag or AIError.
- Semantic: Accepts the raw message body string, runs the ONNX session, interprets the output tensor to extract the top-1 label and its confidence score, and constructs an AITag.

SidecarWriter Trait:
- Method: write_tag(tag: borrowed AITag) -> Fallible containing Result of unit or AIError.
- Semantic: Serializes the AITag into a JSONEachRow HTTP INSERT payload and sends it to the ClickHouse log_ai_tags table endpoint.

TagStreamPublisher Trait:
- Method: publish_patch(tag: borrowed AITag) -> Fallible containing Result of unit or AIError.
- Semantic: Serializes the AITag to JSON bytes and produces the message to the "ai-tags-stream" Redpanda topic, awaiting delivery confirmation.

### 1.4 Physical Constraints

- No Sidecar UUID Joins: Relational JOIN operations and IN(UUID) filtering on the primary "logs" table are strictly forbidden. All sidecar tag lookups MUST be resolved via the ClickHouse Dictionary defined over log_ai_tags.
- ONNX inference MUST execute asynchronously via tokio::task::spawn_blocking wrapping the synchronous ort Session::run call, to prevent blocking the Tokio runtime.
- All internal memory channels (if any) MUST have explicit bounded capacity.
- No .unwrap(), .expect(), panic!(), or todo!() anywhere in this track.
- No std::sync::Mutex held across .await points.

---

## Phase 2: The Behavioral Specification

### 2.1 The Gherkin Feature: AI Consumer Classification

Feature: AI Consumer Classification

  Scenario 1: Log is successfully classified and sidecar stored
    Given a log payload has been published to "logs-normalized"
    And the ONNX runtime is initialized with a valid model
    When the AI Consumer polls and receives the message
    And extracts the message body from the NormalizedLog
    And invokes the AIClassifier::classify method
    Then the classify call MUST return an AITag with a non-empty tag and confidence in 0.0..=1.0
    And the consumer MUST call SidecarWriter::write_tag to insert the AITag into ClickHouse log_ai_tags
    And the consumer MUST call TagStreamPublisher::publish_patch to produce the AITag to "ai-tags-stream"
    And the consumer MUST commit the Redpanda consumer offset ONLY after both write_tag and publish_patch succeed
    And logger_events_processed_total with labels stage="ai_consumer" and status="success" MUST be incremented by 1

  Scenario 2: ONNX classification fails
    Given a log payload has been published to "logs-normalized"
    And the ONNX model returns an inference error
    When the AI Consumer attempts to classify the message
    Then the classify call MUST return an InferenceError
    And the consumer MUST NOT call write_tag or publish_patch
    And logger_events_processed_total with labels stage="ai_consumer" and status="error" MUST be incremented by 1
    And the consumer MUST commit the offset to skip the poison message (classification failures are non-retryable)

  Scenario 3: ClickHouse sidecar is offline
    Given the ClickHouse sidecar table is unreachable
    When the AI Consumer attempts to call write_tag
    Then write_tag MUST return a SidecarWriteError
    And the consumer MUST immediately call consumer.pause on the assigned TopicPartitionList to halt further message fetching
    And the consumer MUST enter a tokio-retry exponential backoff loop retrying write_tag
    And the consumer MUST NOT commit the Redpanda offset until write_tag succeeds
    And upon successful retry, the consumer MUST call consumer.resume on the assigned TopicPartitionList
    And then proceed to publish_patch and offset commit
    And logger_events_processed_total with labels stage="ai_consumer" and status="error" MUST be incremented once per failed retry attempt

  Scenario 4: ai-tags-stream publish fails
    Given the tag has been successfully written to ClickHouse
    When the consumer attempts to call publish_patch
    And the rdkafka producer returns a StreamPublishError
    Then the consumer MUST pause the rdkafka consumer and enter exponential backoff retrying publish_patch
    And the consumer MUST NOT commit the Redpanda offset until publish_patch succeeds
    And upon successful retry, the consumer MUST resume and commit
    And logger_events_processed_total with labels stage="ai_consumer" and status="error" MUST be incremented once per failed retry attempt

### 2.2 Crucial Directive

Do NOT write any application logic until the cucumber step definitions for all four scenarios above are scaffolded under tests/steps/ and the BDD runner confirms they FAIL (red phase). Only then proceed to Phase 3.

### 2.3 BDD World Struct

AIWorld:
- Fields:
  - consumer: Option holding a test rdkafka StreamConsumer
  - classifier: Option holding a concrete OnnxClassifier instance (real ONNX model, NOT a mock)
  - writer: Option holding a concrete ClickHouseSidecarWriter instance (real HTTP client)
  - publisher: Option holding a concrete KafkaTagPublisher instance (real rdkafka producer)
  - received_message: Option of String
  - generated_tag: Option of AITag
  - write_result: Option of Result
  - publish_result: Option of Result
  - metric_snapshot: Option of f64

---

## Phase 3: The Execution DAG (The Core Engine)

### Step 1: Scaffold BDD Tests

1.1. Create a Gherkin feature file at tests/features/ai_consumer.feature containing all four scenarios from Phase 2.
1.2. Create step definitions at tests/steps/ai_consumer_steps.rs implementing the AIWorld struct and registering Given/When/Then step matchers for every clause.
1.3. Register the feature in the cucumber test runner.
1.4. Run "cargo nextest run" and confirm all four scenarios FAIL (red). Do NOT proceed until this gate passes.

### Step 2: Pure Logic — Message Extraction & Tag Construction

2.1. Implement a pure function extract_message_body that accepts a borrowed NormalizedLog and returns a borrowed str reference to the message field. This function has no side effects and no I/O.

2.2. Implement a pure function build_ai_tag that accepts a log_id (Uuid), a model_version (borrowed str), a classification_label (borrowed str), a confidence (f32), and returns an AITag with tagged_at set to Utc::now().

2.3. Both functions MUST be total (no Result, no Option unwrapping). Inputs are guaranteed valid by the upstream normalization contract.

### Step 3: Infrastructure Adapters

3.1. OnnxClassifier Adapter (implements AIClassifier trait):
- Construction: Accept a filesystem path to the .onnx model file. Initialize an ort::Session using ort::Session::builder() with intra_threads(1) to limit per-inference CPU contention. Store the Session inside an Arc so it can be shared with spawn_blocking closures.
- classify method:
  a. Clone the Arc of Session.
  b. Call tokio::task::spawn_blocking to run the synchronous session.run() inside a blocking thread.
  c. Parse the output tensor to extract the argmax index and its softmax confidence.
  d. Map the index to a label string via a static label lookup table.
  e. Construct and return the AITag.
  f. On failure, wrap the ort error into AIError::InferenceError and return.
  g. The classify method MUST be annotated with #[::tracing::instrument(skip_all)].
  h. The session.run() call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "ONNX session.run failed")) BEFORE any ? operator.
  i. On success, emit ::tracing::debug!(tag = %tag.tag, confidence = %tag.confidence, "ONNX classification succeeded").

3.2. ClickHouseSidecarWriter Adapter (implements SidecarWriter trait):
- Construction: Accept the ClickHouse HTTP base URL as a string. Initialize a reqwest::Client with a reasonable timeout (e.g., 10 seconds). Store the client and URL.
- write_tag method:
  a. Serialize the AITag into a JSONEachRow line.
  b. POST to the ClickHouse endpoint with the query "INSERT INTO log_ai_tags FORMAT JSONEachRow" as a query parameter.
  c. Check the HTTP response status. If not 2xx, return AIError::SidecarWriteError.
  d. The write_tag method MUST be annotated with #[::tracing::instrument(skip_all)].
  e. The reqwest POST call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "ClickHouse sidecar write_tag failed")) BEFORE any ? operator.
  f. On success, emit ::tracing::debug!(log_id = %tag.log_id, "Sidecar write_tag succeeded").

3.3. KafkaTagPublisher Adapter (implements TagStreamPublisher trait):
- Construction: Accept Kafka broker addresses and the target topic "ai-tags-stream". Initialize an rdkafka FutureProducer.
- publish_patch method:
  a. Serialize the AITag to JSON bytes.
  b. Build an rdkafka FutureRecord with the tag's log_id as the message key (for partition affinity) and the JSON bytes as the payload.
  c. Call producer.send() and await the delivery future.
  d. The publish_patch method MUST be annotated with #[::tracing::instrument(skip_all)].
  e. The producer.send() call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "ai-tags-stream publish_patch failed")) BEFORE any ? operator.
  f. On success, emit ::tracing::debug!(log_id = %tag.log_id, "ai-tags-stream publish_patch succeeded").

### Step 4: The Actor Loop — The Classification Consumer

4.1. Define the run_classification_loop function. This function:
- Accepts: a StreamConsumer, an Arc of dyn AIClassifier, an Arc of dyn SidecarWriter, an Arc of dyn TagStreamPublisher, and a reference to the Prometheus IntCounterVec for logger_events_processed_total.
- Returns: Fallible containing unit (the loop runs indefinitely until shutdown signal).
- MUST be annotated with #[::tracing::instrument(skip_all)].

4.2. The loop body, for each polled message:

  a. DESERIALIZE: Deserialize the message payload bytes into a NormalizedLog.
     - On deserialization failure: increment logger_events_processed_total{stage="ai_consumer", status="error"}, log via ::tracing::error!, commit the offset (skip poison), and continue to the next message.

  b. CLASSIFY: Call classifier.classify(extract_message_body(&log)).
     - On InferenceError: increment logger_events_processed_total{stage="ai_consumer", status="error"}, commit the offset (classification failures are non-retryable — the same message will produce the same error), and continue.
     - The classify call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "AI classification failed")).
     - On success: emit ::tracing::debug!(log_id = %tag.log_id, tag = %tag.tag, "Classification complete").

  c. WRITE SIDECAR (with backpressure):
     - Call writer.write_tag(&tag).
     - On SidecarWriteError:
       1. Capture the assigned TopicPartitionList from the consumer via consumer.assignment().
       2. Call consumer.pause(&partitions) to halt the rdkafka fetch thread immediately.
       3. Enter a tokio-retry ExponentialBackoff loop (initial_interval: 500ms, max_interval: 30s, max_elapsed_time: None — retry indefinitely until ClickHouse recovers).
       4. Each retry attempt MUST increment logger_events_processed_total{stage="ai_consumer", status="error"}.
       5. Each retry attempt MUST log via ::tracing::warn!(attempt = %n, error = %e, "Retrying sidecar write_tag").
       6. On successful retry: call consumer.resume(&partitions) to re-enable fetching.
       7. Emit ::tracing::info!("ClickHouse sidecar recovered, consumer resumed").
     - The write_tag call (both initial and retry) MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "Sidecar write_tag failed")).

  d. PUBLISH PATCH (with backpressure):
     - Call publisher.publish_patch(&tag).
     - On StreamPublishError:
       1. Apply identical pause/backoff/resume mechanics as step (c).
       2. Each retry attempt MUST increment logger_events_processed_total{stage="ai_consumer", status="error"}.
       3. Each retry attempt MUST log via ::tracing::warn!(attempt = %n, error = %e, "Retrying publish_patch").
     - The publish_patch call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "publish_patch failed")).

  e. COMMIT OFFSET:
     - Call consumer.commit_message(&message, CommitMode::Async).
     - The commit call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "Offset commit failed")).
     - Offsets are NEVER committed before both write_tag and publish_patch succeed.

  f. INCREMENT SUCCESS:
     - Increment logger_events_processed_total{stage="ai_consumer", status="success"} exactly once per fully processed message (after sidecar write + patch publish + offset commit all succeed).
     - Emit ::tracing::debug!(log_id = %tag.log_id, "AI consumer pipeline complete for message").

4.3. Graceful Shutdown:
- The loop MUST select! on a tokio::sync::watch or CancellationToken for shutdown signals alongside the consumer.recv() future.
- On shutdown signal: break the loop, log ::tracing::info!("AI consumer shutting down"), and return Ok(()).

---

## Phase 4: Monolith Integration

### 4.1 Wiring Directives

In apps/src/main.rs, within the CLI role match arm for "ai-consumer":

1. Initialize the rdkafka StreamConsumer subscribed to "logs-normalized" with the consumer group "ai-consumer-group". Set enable.auto.commit to false (manual offset management). Set auto.offset.reset to "earliest".

2. Initialize the OnnxClassifier adapter by passing the configured model file path from the application config.

3. Initialize the ClickHouseSidecarWriter adapter by passing the ClickHouse HTTP base URL from the application config.

4. Initialize the KafkaTagPublisher adapter by passing the Kafka broker addresses and topic name "ai-tags-stream" from the application config.

5. Obtain a reference to the shared logger_events_processed_total IntCounterVec from the global Prometheus registry. This metric MUST already be registered at application startup (shared across all roles). Do NOT register new metrics here. Do NOT register or reference logger_ai_inference_success_total, logger_ai_sidecar_error_total, or any other invented metric names.

6. Spawn the classification loop task via tokio::spawn, passing all initialized adapters and the metric reference:
   - tokio::spawn(async move { run_classification_loop(consumer, classifier, writer, publisher, metrics).await })
   - The spawn result MUST be joined on the JoinSet or select!'d with the shutdown signal.
   - If the loop returns an error, log it via ::tracing::error!(error = %e, "AI consumer loop exited with error").

### 4.2 Metric Ledger (Closed-World Compliance)

This track uses EXACTLY ONE metric:
- logger_events_processed_total with label stage="ai_consumer" and label status="success" or "error"

No other metrics are permitted. The following metric names are EXPLICITLY FORBIDDEN in this track:
- logger_ai_inference_success_total (HALLUCINATED — does not exist)
- logger_ai_sidecar_error_total (HALLUCINATED — does not exist)
- logger_ai_inference_duration_seconds (HALLUCINATED — does not exist)
- Any metric name not in the 6-metric closed-world set

### 4.3 Observability Ledger (Tracing Boundary Compliance)

Functions that MUST carry #[::tracing::instrument(skip_all)]:
- run_classification_loop
- OnnxClassifier::classify
- ClickHouseSidecarWriter::write_tag
- KafkaTagPublisher::publish_patch

Calls that MUST carry .tap_err(|e| ::tracing::error!(...)) BEFORE any ? operator:
- session.run() inside classify
- reqwest POST inside write_tag
- producer.send() inside publish_patch
- consumer.commit_message() inside the loop

Calls that MUST carry ::tracing::debug!(...) on success:
- After successful session.run() with tag and confidence fields
- After successful write_tag with log_id field
- After successful publish_patch with log_id field
- After full pipeline completion per message with log_id field

### 4.4 Exit Gate (Track Acceptance Criteria)

- [ ] "cargo fmt --check" passes with zero warnings.
- [ ] "cargo clippy -- -D warnings" passes with zero warnings.
- [ ] "cargo nextest run" passes with all four BDD scenarios GREEN.
- [ ] Zero occurrences of .unwrap(), .expect(), panic!(), todo!(), or unimplemented!() in this track's code.
- [ ] Zero occurrences of std::sync::Mutex held across .await points.
- [ ] Zero mock or stub data interfaces — all adapters use real ort, reqwest, and rdkafka clients.
- [ ] consumer.pause() is called before every backoff retry loop.
- [ ] consumer.resume() is called after every successful retry recovery.
- [ ] Offsets are committed ONLY after both write_tag and publish_patch succeed.
- [ ] logger_events_processed_total{stage="ai_consumer", status="success"} is incremented exactly once per fully processed message.
- [ ] logger_events_processed_total{stage="ai_consumer", status="error"} is incremented on every failure path (deserialization, classification, sidecar write retry, publish retry).
- [ ] No metric names outside the 6-metric closed-world set appear anywhere in the code.
- [ ] All four #[::tracing::instrument(skip_all)] annotations are present.
- [ ] All .tap_err() calls are present on every fallible I/O call before the ? operator.
- [ ] All ::tracing::debug!() calls are present after every successful I/O completion.
