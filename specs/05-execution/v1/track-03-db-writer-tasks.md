# Execution Tasks: Track 3: DB Writer

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/db_writer.feature`. Copy the Gherkin scenarios from the v10 spec exactly.
* [ ] **Task A.2:** Create `tests/steps/db_writer_steps.rs`. Scaffold the `cucumber::World` (`DbWriterWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "test: scaffold db writer BDD tests"`).

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/db_writer/error.rs` and `apps/src/db_writer/traits.rs`. Define `DbWriterError` enum with `axiom::Erratum` and `ClickHouseWriter` boundary trait.
* [ ] **Task B.2:** Create `apps/src/db_writer/logic.rs`. Implement the `BatchAccumulator` struct for pure logic accumulator.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement db writer domain models and logic"`).

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/db_writer/adapters.rs`. Implement `ClickHouseHttpWriter` adapter fulfilling `ClickHouseWriter` trait, issuing JSONEachRow POST requests.
* [ ] **Task C.2:** Create `apps/src/db_writer/actors.rs`. Implement the Decoupled Actor Tasks (Task A `run_fetcher_task` and Task B `run_processor_task` with Flush Subroutine).
  * *Note: Implement Kafka Backpressure Paradigm here per Invariant I. Structurally decouple the consumer into two Tokio tasks connected by a bounded `mpsc` channel. Do NOT poll `consumer.recv()` inside the exponential backoff retry loop.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement db writer adapters and actor loops"`).

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role db-writer`), instantiate rdkafka `StreamConsumer`, reqwest client, `ClickHouseHttpWriter`, register `logger_events_processed_total`, create bounded `mpsc` channel, and spawn fetcher/processor tasks with `CancellationToken`.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: wire db writer into monolith main"`).

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
