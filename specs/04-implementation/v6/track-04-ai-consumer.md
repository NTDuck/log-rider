# Track 4: AI Consumer

## Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role ai-consumer". It consumes logs from the Redpanda topic "logs-normalized". It inserts tags to ClickHouse sidecar table "log_ai_tags" and publishes updates to "ai-tags-stream" topic.
- **Data Schemas:**
  - AITag Model:
    - log_id: Uuid
    - model_version: String
    - tag: String
    - confidence: Float32
  - AIError Variants:
    - InferenceError: Failure during ONNX model runtime.
    - SidecarWriteError: ClickHouse tag insert failure.
    - StreamPublishError: Failure producing tag patches.
    - ConsumerError: Redpanda stream consume failures.
  - AIClassifier Boundary Trait:
    - Method: classify(message: str) -> Fallible Result containing AITag or AIError vector.
  - SidecarWriter Boundary Trait:
    - Method: write_tag(tag: AITag) -> Fallible Result.
    - Method: publish_patch(tag: AITag) -> Fallible Result.
- **Physical Constraints:**
  - Relational JOINs or IN filters on UUIDs on the primary logs table are strictly forbidden. System must store tags in the log_ai_tags sidecar.
  - ONNX model inference must run asynchronously.

## Phase 2: The Behavioral Specification
- **The Gherkin Feature (AI Consumer Classification):**
  - Scenario 1: Log is classified and sidecar stored.
    - Given a log payload published to logs-normalized.
    - When the AI Consumer extracts the message body.
    - Then it MUST run its ONNX model.
    - And write the output tag to log_ai_tags sidecar table.
    - And publish a patch to ai-tags-stream.
  - Scenario 2: ClickHouse sidecar is offline.
    - Given the ClickHouse sidecar table is unreachable.
    - When the AI Consumer attempts to write the tag.
    - Then it MUST pause the rdkafka stream.
    - And implement exponential backoff/retry.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

## Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AIWorld BDD steps.
- **Step 2: Pure Logic:** Extract message text from NormalizedLog. Parse model output metrics.
- **Step 3: Infrastructure Adapters:** Initialize ONNX classification runtime using ort framework. Build reqwest HTTP writer for sidecar inserts, and rdkafka producer for tag streaming.
- **Step 4: The Actor Loop:** Implement the classification consumer loop.
  - Kafka Physical Backpressure Mechanics: Explicitly invoke consumer.pause(&partitions) prior to starting database write retry loops to prevent memory bloat, resuming offset consumption after successful writes.
  - Telemetry Bypass Prevention: Enforce tap error handlers logging errors and incrementing logger_ai_sidecar_error_total before returning.

## Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogConsumer, OnnxClassifier, and CombinedSidecarWriter.
  - Register metrics logger_ai_inference_success_total and logger_ai_sidecar_error_total.
  - Spawn AI run loop on CLI role ai-consumer match.
