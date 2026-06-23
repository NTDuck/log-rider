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
    - When the DB Writer attempts to write a batch.
    - Then it MUST call consumer.pause on all assigned partitions to halt rdkafka background pre-fetching.
    - And enter an exponential backoff retry loop (base 1 second, max 60 seconds, with jitter).
    - And MUST NOT commit Redpanda offsets during the retry loop.
    - And increment logger_events_processed_total with labels stage="db_writer" and status="error" once per failed attempt.
    - And upon successful retry, call consumer.resume on all assigned partitions to restore message flow.
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

- **Step 4: The Actor Loop — run_db_writer_loop.**
  - Function signature: async fn run_db_writer_loop(consumer: rdkafka StreamConsumer, writer: impl ClickHouseWriter, metrics: DbWriterMetrics) -> Fallible unit.
  - The entire function MUST be annotated with #[::tracing::instrument(skip_all)].
  - Instantiate a BatchAccumulator with the configured thresholds.
  - Enter the main loop using tokio::select! over two branches:
    - Branch A — Message Poll: consumer.recv().await. On success, attempt deserialization of the message payload into NormalizedLog. On deserialization failure: emit ::tracing::error!(partition = %msg.partition(), offset = %msg.offset(), error = %e, "Failed to deserialize NormalizedLog from logs-normalized"), increment logger_events_processed_total{stage="db_writer", status="error"}, and continue the loop (skip this message). On success: pass the NormalizedLog to accumulator.push(). If push returns a full batch, proceed to the Flush Subroutine.
    - Branch B — Timer Tick: tokio::time::interval(flush_interval).tick().await. Call accumulator.try_flush_by_timer(). If a batch is returned, proceed to the Flush Subroutine.
  - **Flush Subroutine:**
    - Call writer.write_batch(&batch).await.
    - The write_batch call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, batch_size = batch.len(), "Batch write to ClickHouse failed")) BEFORE entering the retry path.
    - On success:
      - Increment logger_events_processed_total{stage="db_writer", status="success"} by the batch length.
      - Emit ::tracing::debug!(batch_size = batch.len(), "Batch flushed and offsets ready for commit").
      - Call consumer.commit_consumer_state(CommitMode::Async). The commit call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "Kafka offset commit failed after successful ClickHouse write")).
      - Call accumulator.reset_timer().
    - On failure — Kafka Physical Backpressure Mechanics:
      - Retrieve the current partition assignment via consumer.assignment().
      - Call consumer.pause(&partitions). The pause call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "Failed to pause rdkafka consumer partitions")).
      - Emit ::tracing::warn!(partitions = ?partitions, "Consumer paused — entering ClickHouse retry backoff").
      - Enter an exponential backoff retry loop. Use tokio::time::sleep with durations: 1s, 2s, 4s, 8s, 16s, 32s, capped at 60s. Add random jitter of up to 500ms per iteration.
      - On each retry attempt: call writer.write_batch(&batch).await. Suffix with .tap_err(|e| ::tracing::error!(error = %e, attempt = %attempt, "ClickHouse retry attempt failed")). On each failure, increment logger_events_processed_total{stage="db_writer", status="error"}.
      - On retry success:
        - Increment logger_events_processed_total{stage="db_writer", status="success"} by the batch length.
        - Call consumer.resume(&partitions). The resume call MUST be suffixed with .tap_err(|e| ::tracing::error!(error = %e, "Failed to resume rdkafka consumer partitions")).
        - Emit ::tracing::info!(attempt = %attempt, "ClickHouse retry succeeded — consumer resumed").
        - Proceed to commit offsets and reset timer as in the success path above.
      - MUST NOT commit consumer offsets at any point during the retry loop.
  - **Telemetry — Closed-World Compliance:**
    - This track uses exactly one metric: logger_events_processed_total, labeled with stage="db_writer" and status="success" or status="error".
    - No other metric names may be referenced, registered, or incremented anywhere in this track.
  - **Observability Boundary Compliance:**
    - The run_db_writer_loop function: #[::tracing::instrument(skip_all)].
    - The write_batch trait implementation: #[::tracing::instrument(skip_all)].
    - Every fallible I/O call (send, commit, pause, resume, recv, write_batch) MUST have an explicit .tap_err(|e| ::tracing::error!(...)) BEFORE the ? operator with a descriptive message identifying the operation.
    - Every successful I/O completion (INSERT committed, offset committed, consumer resumed) MUST emit ::tracing::debug!(...) or ::tracing::info!(...) confirming the operation.

## Phase 4: Monolith Integration

- **Wiring Directives:**
  - In apps/src/main.rs, within the "--role db-writer" branch:
    - Instantiate rdkafka StreamConsumer configured for the "logs-normalized" topic with consumer group "db-writer-group". Set enable.auto.commit to false (manual commit only).
    - Instantiate reqwest::Client with a connect timeout of 5 seconds and a request timeout of 30 seconds.
    - Instantiate ClickHouseHttpWriter with the ClickHouse base URL from environment configuration, the reqwest client, database "default", and table "logs".
    - Register logger_events_processed_total (labeled IntCounterVec with label names ["stage", "status"]) in the Prometheus default registry. This metric is shared across tracks; register it once at the monolith level if not already registered.
    - Spawn the run_db_writer_loop as a tokio task, passing the consumer, writer, and metrics handle.
    - The spawned task MUST capture the JoinHandle. On task exit, emit ::tracing::error!("DB Writer loop exited unexpectedly") and initiate graceful shutdown signaling.
  - **Graceful Shutdown:**
    - The run_db_writer_loop MUST accept a tokio::sync::watch Receiver for shutdown signaling.
    - On shutdown signal, the loop MUST flush any remaining buffered batch via the Flush Subroutine, commit final offsets on success, and then return.
  - **No Invented Metrics:** This wiring block registers ONLY logger_events_processed_total. No logger_ch_writes_success_total, logger_ch_writes_error_total, or any other invented metric name may appear.

- **Exit Gate — Track Acceptance Criteria:**
  - cargo fmt --check passes with zero formatting violations.
  - cargo clippy passes with zero warnings.
  - cargo nextest run passes with all four cucumber scenarios green.
  - Zero occurrences of .unwrap(), .expect(), unreachable!(), panic!(), todo!(), or unimplemented!() in any source file touched by this track.
  - Zero occurrences of std::sync::Mutex anywhere in async code paths.
  - Zero mock data interfaces — the ClickHouse HTTP writer uses a real reqwest::Client and the consumer uses a real rdkafka StreamConsumer.
  - The ONLY Prometheus metric name present in the codebase for this track is logger_events_processed_total. Any other metric name is a structural violation.
  - The ClickHouse INSERT format MUST be JSONEachRow.
  - The Kafka consumer offsets MUST NOT be committed during the backoff retry loop.
  - Every fallible I/O call has an explicit .tap_err with ::tracing::error! before the ? operator.
  - Every successful I/O completion has a ::tracing::debug! or ::tracing::info! confirmation.
  - The actor loop and all async I/O methods carry #[::tracing::instrument(skip_all)].
