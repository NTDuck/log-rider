# Execution Tasks: Track 2: Normalization Worker

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/normalization_worker.feature`. Copy the Gherkin scenarios from the v10 spec exactly.
* [ ] **Task A.2:** Create `tests/steps/normalization_worker_steps.rs`. Scaffold the `cucumber::World` (`NormalizationWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/normalization/models.rs`. Define `NormalizedLog` and `DLQEnvelope` structs using `bon` builders, and `NormalizationError` enum with `axiom::Erratum`.
* [ ] **Task B.2:** Create `apps/src/normalization/logic.rs`. Implement pure functions: PII Regex Engine (`redact_pii`), Parallel Array Flattener, DLQ Envelope Builder (hash and truncate), and Poison Pill Detection (`is_poison_pill`).
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/normalization/adapters.rs`. Implement `LogConsumer` trait and `NormalizedProducer` trait backed by `rdkafka` adapters.
  * *Note: Implement Telemetry & State Consistency here per Invariant IV. Dual-write pipelines MUST utilize the `log_id` as the Kafka Message Key to guarantee absolute idempotency on retry.*
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Task C.2:** Create `apps/src/normalization/actors.rs`. Implement the Decoupled Consumer Tasks (Task A Fetcher and Task B Processor) using a bounded `mpsc` channel.
  * *Note: Implement Kafka Backpressure Paradigm here per Invariant I. Structurally decouple into two Tokio tasks connected by a bounded `mpsc` channel. DO NOT poll `consumer.recv().await` in the Processor's retry loop.*
  * *Note: You MUST explicitly mandate tokio::time::sleep alongside the cancellation token in the exponential backoff retry loops to prevent 100% CPU spinning.*
  * *Note: Telemetry counters MUST be incremented OUTSIDE of infinite retry loops. Count the message, not the retry attempt.*
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
  * *Note: Telemetry metrics (e.g., logger_events_processed_total) MUST be incremented strictly AFTER the async I/O call (.await) successfully resolves, never before.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role normalization`), instantiate the rdkafka consumer and producer, wrap them in traits, register the 3 metrics, create bounded `mpsc` channel, spawn Fetcher and Processor tasks with `CancellationToken`.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
