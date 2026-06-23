# Execution Tasks: Track 1: Edge Receiver

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/edge_receiver.feature`. Copy the Gherkin scenarios from the v10 spec exactly.
* [ ] **Task A.2:** Create `tests/steps/edge_receiver_steps.rs`. Scaffold the `cucumber::World` (`EdgeWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "test: scaffold edge receiver BDD tests"`).

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/edge/models.rs`. Define `DomainLog` struct using `bon` builders, `EdgeError` enum with `axiom::Erratum`, and `JwtClaims`.
* [ ] **Task B.2:** Create `apps/src/edge/logic.rs`. Implement the true token-stream JSON depth validator and flattener, stateless JWT validator, and app_name grant checker.
  * *Note: Implement Socket-Level Memory Defense here per Invariant II. Use a low-level token pull-parser (e.g., `struson`) to iteratively evaluate the raw byte stream and abort if nesting depth exceeds 5 BEFORE AST construction.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement edge domain models and pure logic"`).

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/edge/adapters.rs`. Implement `KafkaLogProducer` struct wrapping `rdkafka::producer::FutureProducer` and its async `produce` method.
* [ ] **Task C.2:** Create `apps/src/edge/actors.rs`. Implement the Axum handler function for POST `/v1/logs`.
  * *Note: Implement Socket-Level Memory Defense here per Invariant II. Apply a strict `tower::timeout::TimeoutLayer` directly at the socket stream-reading phase to sever connections exceeding time-to-first-byte limits (Slowloris defense).*
  * *Note: Implement Telemetry & State Consistency here per Invariant IV. Metric `logger_events_processed_total` MUST be counted EXACTLY ONCE outside of all retry loops when a message reaches its final resolution.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement edge adapters and actor loops"`).

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role edge`), instantiate `KafkaLogProducer`, load JWT public key, register metrics (`logger_ingest_bytes_total`, `logger_events_processed_total`), build Axum router with state, and start the loops with `CancellationToken` for idempotent shutdown.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: wire edge receiver into monolith main"`).

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
