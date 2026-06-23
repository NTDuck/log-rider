# Execution Tasks: Track 4: AI Consumer

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/ai_consumer.feature`. Copy the Gherkin scenarios from the v10 spec exactly.
* [ ] **Task A.2:** Create `tests/steps/ai_consumer_steps.rs`. Scaffold the `cucumber::World` (`AIWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "test: scaffold ai consumer BDD tests"`).

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/ai_consumer/models.rs`. Define `AITag` model using `bon` builders and `AIError` enum with `axiom::Erratum`. Define `AIClassifier` and `TagStreamPublisher` traits.
* [ ] **Task B.2:** Create `apps/src/ai_consumer/logic.rs`. Implement pure functions `extract_message_body` and `build_ai_tag`.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement ai consumer domain models and logic"`).

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/ai_consumer/adapters.rs`. Implement `OnnxClassifier` adapter wrapping `ort::Session` and `KafkaTagPublisher` adapter wrapping `rdkafka::producer::FutureProducer`.
* [ ] **Task C.2:** Create `apps/src/ai_consumer/actors.rs`. Implement the Actor Loop `run_classification_loop` splitting into Task A (Fetcher) and Task B (Processor).
  * *Note: Implement Kafka Backpressure Paradigm here per Invariant I. The Fetcher and Processor MUST be separated by a bounded `mpsc` channel. Do NOT poll `consumer.recv()` or `consumer.pause()` during `StreamPublishError` in-place retry loops.*
  * *Note: Implement Telemetry & State Consistency here per Invariant IV. Metric `logger_events_processed_total` MUST be incremented OUTSIDE of infinite retry loops. Count the message, not the retry attempt.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement ai consumer adapters and actor loops"`).

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role ai-consumer`), initialize `rdkafka::StreamConsumer`, `OnnxClassifier`, `KafkaTagPublisher`, acquire `CancellationToken` and metric handles, and invoke `run_classification_loop`.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: wire ai consumer into monolith main"`).

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
