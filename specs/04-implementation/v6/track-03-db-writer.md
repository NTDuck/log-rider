# Track 3: DB Writer

## Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via the CLI role flag "--role db-writer". It consumes normalized logs from the Redpanda topic "logs-normalized". It inserts them in batches to the ClickHouse table "logs".
- **Data Schemas:**
  - Input: NormalizedLog model (from Track 2).
  - DbWriterError Variants:
    - ConnectionDropped: ClickHouse analytical database is unreachable.
    - BatchTimeout: Insert batch timed out.
    - ConsumerError: Redpanda stream read failures.
  - ClickHouseWriter Boundary Trait:
    - Method: write_batch(batch: Slice of NormalizedLog) -> Fallible Result containing success or DbWriterError.
- **Physical Constraints:**
  - ClickHouse tables must run immutable INSERTs only. UPDATE or DELETE queries are forbidden.
  - Must write logs in buffers (triggered by row count limit or elapsed timer).
  - Commit offsets only on successful analytical write.

## Phase 2: The Behavioral Specification
- **The Gherkin Feature (Database Batch Writer):**
  - Scenario 1: Batch of normalized logs is written to ClickHouse.
    - Given a batch of messages consumed from logs-normalized.
    - When the DB Writer processes the batch.
    - Then it MUST format an INSERT payload.
    - And write it to the ClickHouse logs table.
    - And commit Redpanda offsets only after successful DB write.
  - Scenario 2: ClickHouse is offline.
    - Given ClickHouse is unreachable.
    - When the DB Writer attempts to write a batch.
    - Then it MUST pause the rdkafka consumer stream.
    - And implement exponential backoff.
    - And MUST NOT commit Redpanda offsets.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

## Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define the DbWriterWorld state machine and BDD tests.
- **Step 2: Pure Logic:** Implement the buffer batch accumulator accumulating row limits (e.g., 1000 items) or timing thresholds (e.g., 5 seconds).
- **Step 3: Infrastructure Adapters:** Connect reqwest HTTP client to execute raw JSONEachRow ClickHouse SQL INSERT queries. Suffix the database call with a tap error handler mapping connection errors to DbWriterError.
- **Step 4: The Actor Loop:** Implement the database worker loop.
  - Kafka Physical Backpressure Mechanics: Before entering the tokio-retry exponential backoff DB retry loop, the agent MUST explicitly call consumer.pause(&partitions) to stop the consumer thread from buffering messages in memory during ClickHouse offline states. Call consumer.resume(&partitions) only after a successful INSERT batch transaction.
  - Telemetry Bypass Prevention: Attach tap error to write_batch calls to increment logger_ch_writes_error_total and log the error before using early return operators. Suffix successful writes with logger_ch_writes_success_total increments.

## Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogConsumer on logs-normalized topic.
  - Instantiate ClickHouseNativeWriter with HTTP url.
  - Register logger_ch_writes_success_total and logger_ch_writes_error_total metrics.
  - Check role role db-writer, then spawn the event loop task.
