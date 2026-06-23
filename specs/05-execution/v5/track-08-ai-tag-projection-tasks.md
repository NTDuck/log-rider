# Execution Tasks: Track 8: AI Tag DB Projection

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/ai_tag_db_projection.feature`. Add Gherkin scenarios testing the Redpanda consumer and ClickHouse HTTP ingestion for the ai-tags-stream.
* [ ] **Task A.2:** Create `tests/steps/ai_tag_db_projection_steps.rs`. Scaffold the `cucumber::World` (`AITagDBWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/ai_tag_db/models.rs`. Define `AITagMessage` (with `bon` builder) and `AITagDBError` (with `axiom::Erratum`). Define `AITagClickHouseWriter` trait.
* [ ] **Task B.2:** Create `apps/src/ai_tag_db/logic.rs`. Implement the `AITagBatchAccumulator` struct for pure logic accumulator.
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/ai_tag_db/adapters.rs`. Implement `ClickHouseAITagWriter` adapter fulfilling `AITagClickHouseWriter` trait, issuing JSONEachRow POST requests.
  * *Note: ClickHouse `UPDATE` or `DELETE` mutation queries are strictly forbidden.*
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Task C.2:** Create `apps/src/ai_tag_db/actors.rs`. Implement the Decoupled Actor Tasks (Task A `run_tag_fetcher_task` and Task B `run_tag_processor_task` with Flush Subroutine).
  * *Note: Consume strictly from the `ai-tags-stream` Redpanda topic.*
  * *Note: Implement Kafka Backpressure Paradigm here per Invariant I. Structurally decouple the consumer into two Tokio tasks connected by a bounded `mpsc` channel. Do NOT poll `consumer.recv()` inside the exponential backoff retry loop.*
  * *Note: You MUST explicitly mandate tokio::time::sleep alongside the cancellation token in the exponential backoff retry loops to prevent 100% CPU spinning.*
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
  * *Note: Increment logger_events_processed_total OUTSIDE of the infinite retry loops. Count the message, not the retry attempt.*
  * *Note: Telemetry metrics (e.g., logger_events_processed_total) MUST be incremented strictly AFTER the async I/O call (.await) successfully resolves, never before.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role ai-tag-projection`), instantiate rdkafka `StreamConsumer` targeting `ai-tags-stream`, reqwest client, `ClickHouseAITagWriter`, create bounded `mpsc` channel, spawn fetcher/processor tasks with `CancellationToken`, and register `logger_events_processed_total` metric.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
