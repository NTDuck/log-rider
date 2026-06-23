# Execution Tasks: Track 5: Alert Consumer

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/alert_consumer.feature`. Copy the Gherkin scenarios from the v10 spec exactly.
* [ ] **Task A.2:** Create `tests/steps/alert_consumer_steps.rs`. Scaffold the `cucumber::World` (`AlertWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "test: scaffold alert consumer BDD tests"`).

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/alert_consumer/models.rs`. Define `AlertConfig`, `AlertError` using `axiom::Erratum`, and boundary traits (`RateLimiter`, `AlertNotifier`, `ConfigSubscriber`).
* [ ] **Task B.2:** Create `apps/src/alert_consumer/logic.rs`. Implement pure functions: fingerprint generator (sha2), notification message formatter, and batching digest formatter.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement alert consumer domain models and logic"`).

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/alert_consumer/adapters.rs`. Implement `RedisRateLimiter` (Transactional Commit), `TelegramNotifier`, and `ConfigSubscriber` adapters.
* [ ] **Task C.2:** Create `apps/src/alert_consumer/config_loop.rs`. Implement the Config Listener Task with State Reconciliation (synchronous initial fetch).
* [ ] **Task C.3:** Create `apps/src/alert_consumer/run_loop.rs`. Implement the Decoupled Consumer Pattern (Task A Fetcher and Task B Processor) connected via a bounded `mpsc` channel.
  * *Note: Implement Kafka Backpressure Paradigm here per Invariant I. Structurally decouple Fetcher and Processor. Do NOT poll `consumer.recv()` in the Processor's Telegram retry loop.*
  * *Note: Implement Telemetry & State Consistency here per Invariant IV. Increment `logger_events_processed_total` exactly ONCE at the end of the message's processing pipeline, OUTSIDE the Telegram retry loop.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement alert consumer adapters and actor loops"`).

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role alert-consumer`), instantiate adapters, create `config_cache` as `Arc<tokio::sync::RwLock>`, register metrics, spawn Config Listener Task, and spawn Fetcher and Processor Tasks with `CancellationToken`.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: wire alert consumer into monolith main"`).

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
