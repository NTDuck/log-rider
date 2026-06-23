# Track 3: DB Writer

## Phase 1: The Domain & Contracts

- **Trigger & Topology:** Activated via the CLI role flag "--role db-writer". It consumes normalized log payloads from the Redpanda topic "logs-normalized". It inserts them in batches to the ClickHouse table "logs". The ClickHouse materialized view "app_health_mv" (AggregatingMergeTree) is populated automatically on INSERT by the database engine; the DB Writer performs no explicit writes to it.
- **Data Schemas:**
  - Input: NormalizedLog model (consumed from logs-normalized, produced by Track 2). Fields:
    - log_id: Uuid
    - timestamp: String (ISO 8601)
    - level: String (DEBUG, INFO, WARN, ERROR, CRITICAL)
    - message: String
    - app_name: String
    - error_code: Option string
    - attribute_keys: Vector of strings
    - attribute_values_string: Vector of strings
  - DbWriterError Variants:
    - ConnectionDropped: ClickHouse analytical database is unreachable or the HTTP connection was reset.
    - BatchInsertFailed: The ClickHouse HTTP interface returned a non-2xx status code on an INSERT request.
    - DeserializationError: A consumed Kafka message could not be deserialized into NormalizedLog.
    - ConsumerError: Redpanda stream read failures from rdkafka.
  - ClickHouseWriter Boundary Trait:
    - Method: write_batch(batch: Slice of NormalizedLog) -> Fallible Result containing unit or DbWriterError.
    - The trait is defined locally in src/db_writer. It is implemented by the concrete ClickHouseHttpWriter adapter in src/adapters.
- **Physical Constraints:**
  - ClickHouse tables accept immutable INSERTs only. UPDATE or DELETE mutation queries are strictly forbidden.
  - Batches are flushed on whichever condition is met first: a row count threshold (default 1000 rows) or a wall-clock timer (default 5 seconds).
  - Consumer offsets MUST be committed only after the ClickHouse INSERT returns HTTP 200. If the INSERT fails, offsets MUST NOT be committed and the batch MUST be retried.
  - INSERT format MUST be JSONEachRow to match ClickHouse HTTP interface expectations.

## Phase 2: The Behavioral Specification

- **The Gherkin Feature (Database Batch Writer):**
  - Scenario 1: Batch of normalized logs is written to ClickHouse on row count threshold.
    - Given a batch of 1000 messages has been consumed from logs-normalized.
    - When the DB Writer batch accumulator reaches the row count threshold.
    - Then it MUST serialize the batch as a JSONEachRow payload.
    - And execute an HTTP POST INSERT to the ClickHouse logs table.
    - And commit Redpanda consumer offsets only after receiving HTTP 200 from ClickHouse.
    - And increment logger_events_processed_total with labels stage="db_writer" and status="success" by the batch size.
  - Scenario 2: Batch is flushed on timer expiry.
    - Given fewer than 1000 messages have been consumed from logs-normalized.
    - When 5 seconds elapse since the last flush.
    - Then the DB Writer MUST flush the current partial batch using the same INSERT and commit sequence as Scenario 1.
  - Scenario 3: ClickHouse is offline — backpressure and retry.
    - Given ClickHouse is unreachable or returns a non-2xx status.
    - When the Processor Task attempts to write a batch.
    - Then the Processor Task MUST enter an exponential backoff retry loop (base 1 second, max 60 seconds, with jitter) in place.
    - And MUST block further processing, causing the bounded mpsc channel to fill up.
    - And the Fetcher Task MUST naturally block on channel send via TCP backpressure, leaving pre-fetched messages safely inside librdkafka's internal queues while librdkafka autonomously maintains heartbeats.
    - And MUST NOT commit Redpanda offsets during the retry loop.
    - And the Processor Task MUST select on the cancellation token during sleep to ensure idempotent cancellation.
    - And upon successful retry, the Processor Task resumes reading from the mpsc channel.
  - Scenario 4: Deserialization failure on a consumed message.
    - Given a message from logs-normalized cannot be deserialized into NormalizedLog.
    - When the DB Writer encounters the deserialization error.
    - Then it MUST log the error via tracing::error with the partition, offset, and error description.
    - And skip the message without adding it to the batch.
    - And increment logger_events_processed_total with labels stage="db_writer" and status="error".
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing. The cucumber World struct (DbWriterWorld) and step files must exist and produce red test output before any production logic is authored.

## Phase 3: The Execution DAG (The Core Engine)

- **Step 1: Scaffolding & Tests.**
  - Define the DbWriterWorld cucumber state machine with fields: batch (Vec of NormalizedLog), write_result (Option of Result), offsets_committed (bool), consumer_paused (bool).
  - Scaffold step definition files under tests/steps for all four scenarios above.
  - Run cargo nextest run and confirm all steps are failing (red).
  - Define the DbWriterError enum in src/db_writer/error.rs using the axiom Erratum derive macro.
  - Define the ClickHouseWriter boundary trait in src/db_writer/traits.rs.

- **Step 2: Pure Logic — The Batch Accumulator.**
  - Implement a BatchAccumulator struct with fields: buffer (Vec of NormalizedLog with explicit pre-allocated capacity equal to the row threshold), row_threshold (usize, default 1000), flush_interval (Duration, default 5 seconds), last_flush (Instant).
  - Method: push(log: NormalizedLog) -> Option of Vec of NormalizedLog. Appends the log to the buffer. If buffer length reaches row_threshold, drain the buffer and return the batch. Otherwise return None.
  - Method: try_flush_by_timer() -> Option of Vec of NormalizedLog. If the buffer is non-empty and Instant::now minus last_flush exceeds flush_interval, drain the buffer and return the batch. Otherwise return None.
  - Method: reset_timer(). Sets last_flush to Instant::now.
  - The accumulator is a pure data structure with no I/O. All fields are private; access is via the methods above.

- **Step 3: Infrastructure Adapters — ClickHouseHttpWriter.**
  - Implement ClickHouseHttpWriter in src/adapters/clickhouse.rs.
  - Constructor takes: base_url (String), database (String, default "default"), table (String, default "logs"), and a reqwest::Client instance.
  - The write_batch method MUST:
    - Serialize the slice of NormalizedLog into a JSONEachRow text body. Each NormalizedLog is serialized as a single JSON line. The serialization MUST map the level field to the ClickHouse Enum8 string representation and the log_id to a UUID string.
    - Construct the INSERT URL as: base_url appended with "/?query=INSERT INTO {database}.{table} FORMAT JSONEachRow".
    - Execute reqwest::Client::post(url).body(payload).send().await.
    - The send() call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, table = %self.table, "ClickHouse INSERT request failed")) BEFORE the ? operator.
    - Check the HTTP response status. If non-2xx, read the response body text, emit ::tracing::error!(status = %status, body = %body, "ClickHouse INSERT returned non-success status"), and return Err(DbWriterError::BatchInsertFailed).
    - On success, emit ::tracing::debug!(rows = batch.len(), table = %self.table, "ClickHouse INSERT batch committed").
  - The entire write_batch method MUST be annotated with #[::tracing::instrument(skip_all)].

- **Step 4: The Decoupled Actor Tasks (Fetcher and Processor).**
  - **The Fetcher Task (run_fetcher_task):**
    - Function signature: async fn run_fetcher_task(consumer: Arc rdkafka StreamConsumer, tx: tokio::sync::mpsc::Sender of NormalizedLog, cancel_token: CancellationToken) -> Fallible unit.
    - The entire function MUST be annotated with #[::tracing::instrument(skip_all)].
    - Enter a loop using tokio::select! over:
      - Branch A — Message Poll: consumer.recv().await. On success, attempt deserialization of the payload. On failure: emit error, increment error metric, and continue. On success: call tx.send(log).await. If the channel is full, this will naturally block, leaving messages in librdkafka's internal queues.
      - Branch B — Cancellation: cancel_token.cancelled().await. Return immediately.
  - **The Processor Task (run_processor_task):**
    - Function signature: async fn run_processor_task(consumer: Arc rdkafka StreamConsumer, writer: impl ClickHouseWriter, metrics: DbWriterMetrics, mut rx: tokio::sync::mpsc::Receiver of NormalizedLog, cancel_token: CancellationToken) -> Fallible unit.
    - The entire function MUST be annotated with #[::tracing::instrument(skip_all)].
    - Instantiate a BatchAccumulator with the configured thresholds.
    - Enter a loop using tokio::select! over:
      - Branch A — Channel Read: rx.recv().await. Pass the log to accumulator.push(). If a full batch is returned, proceed to Flush Subroutine.
      - Branch B — Timer Tick: tokio::time::interval(flush_interval).tick().await. Call accumulator.try_flush_by_timer(). If a batch is returned, proceed to Flush Subroutine.
      - Branch C — Cancellation: cancel_token.cancelled().await. Initiate graceful shutdown by flushing any remaining batch in the accumulator.
  - **Flush Subroutine (Inside Processor Task):**
    - Call writer.write_batch(&batch).await.
    - The write_batch call MUST be suffixed with .tap_err(|e| ::tracing::error!(...)) BEFORE entering the retry path.
    - On success:
      - Increment logger_events_processed_total{stage="db_writer", status="success"} by the batch length.
      - Call consumer.commit_consumer_state(CommitMode::Async).
      - Call accumulator.reset_timer().
    - On failure — Structural Backpressure Mechanics:
      - Enter an exponential backoff retry loop (sleep durations 1s, 2s, 4s, 8s, 16s, 32s, capped at 60s, with jitter).
      - INSIDE the retry loop, the sleep MUST be wrapped in a tokio::select! alongside cancel_token.cancelled() for idempotent cancellation.
      - Do NOT call consumer.recv() in the retry loop. Acknowledge that librdkafka handles heartbeats autonomously.
      - Do NOT call consumer.pause(). Blocking the processor loop prevents rx.recv(), filling the mpsc channel, which naturally blocks the Fetcher Task.
      - If cancel_token.cancelled() completes, abort the retry and exit gracefully immediately.
      - If the sleep completes, execute writer.write_batch(&batch).await. Do NOT increment metrics inside the loop.
      - On retry success: Emit info trace, commit offsets, and reset timer.
      - MUST NOT commit consumer offsets at any point during the retry loop.
  - **Telemetry — Closed-World Compliance:**
    - This track uses exactly one metric: logger_events_processed_total, labeled with stage="db_writer" and status="success" or status="error".
    - Telemetry increments must be exclusively bound to the terminal resolution of a batch, not to the state transitions of the retry loop.
  - **Observability Boundary Compliance:**
    - The actor tasks and write_batch trait implementation MUST carry #[::tracing::instrument(skip_all)].
    - Every fallible I/O call MUST have an explicit .tap_err with a descriptive message BEFORE the ? operator.

## Phase 4: Monolith Integration

- **Wiring Directives:**
  - In apps/src/main.rs, within the "--role db-writer" branch:
    - Instantiate rdkafka StreamConsumer configured for the "logs-normalized" topic with consumer group "db-writer-group". Wrap it in an Arc. Set enable.auto.commit to false.
    - Instantiate reqwest::Client with a connect timeout of 5 seconds and a request timeout of 30 seconds.
    - Instantiate ClickHouseHttpWriter with the ClickHouse base URL from environment configuration, the reqwest client, database "default", and table "logs".
    - Instantiate a tokio_util::sync::CancellationToken.
    - Create a bounded tokio::sync::mpsc::channel for NormalizedLog with a capacity (e.g., 1000).
    - Register logger_events_processed_total (labeled IntCounterVec with label names ["stage", "status"]) in the Prometheus default registry.
    - Spawn the run_fetcher_task as a tokio task, passing the Arc'd consumer, the mpsc Sender, and a clone of the cancellation token.
    - Spawn the run_processor_task as a tokio task, passing the Arc'd consumer, writer, metrics handle, the mpsc Receiver, and a clone of the cancellation token.
    - Await both JoinHandles. On any task exit unexpectedly, emit ::tracing::error! and trigger the cancellation token to tear down the other task.
  - **Graceful Shutdown (Idempotent Cancellation):**
    - The tasks MUST accept a tokio_util::sync::CancellationToken for shutdown signaling.
    - On shutdown signal, the Processor Task MUST flush any remaining buffered batch via the Flush Subroutine, commit final offsets on success, and then return.
    - The `cancel_token.cancelled()` MUST be recursively polled using `tokio::select!` inside ALL inner retry loops (specifically the ClickHouse HTTP insert backoff) to ensure the system can exit cleanly during prolonged ClickHouse outages without deadlocking.
  - **No Invented Metrics:** This wiring block registers ONLY logger_events_processed_total.

- **Exit Gate — Track Acceptance Criteria:**
  - cargo fmt --check passes with zero formatting violations.
  - cargo clippy passes with zero warnings.
  - cargo nextest run passes with all four cucumber scenarios green.
  - Zero occurrences of .unwrap(), .expect(), unreachable!(), panic!(), todo!(), or unimplemented!() in any source file touched by this track.
  - Zero occurrences of std::sync::Mutex anywhere in async code paths.
  - Zero mock data interfaces.
  - The ONLY Prometheus metric name present in the codebase for this track is logger_events_processed_total.
  - The ClickHouse INSERT format MUST be JSONEachRow.
  - The Kafka consumer offsets MUST NOT be committed during the backoff retry loop.
  - The architecture structurally implements the Decoupled Consumer Pattern using mpsc channels and avoids manual pre-fetch draining.
  - Shutdown relies entirely on latch-based CancellationToken, avoiding watch::Receiver deadlocks.
