# Execution Tasks: Track 1: Edge Receiver

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/edge_receiver.feature`. Copy the Gherkin scenarios from the v10 spec exactly.
* [ ] **Task A.2:** Create `tests/steps/edge_receiver_steps.rs`. Scaffold the `cucumber::World` (`EdgeWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/edge/models.rs`. Define `DomainLog` struct using `bon` builders, `EdgeError` enum with `axiom::Erratum`, and `JwtClaims`. 
  * *Note: Do NOT implement an intermediate `WireLog` or use `serde_json::Value`.*
* [ ] **Task B.2:** Create `apps/src/edge/logic.rs`. Implement the true token-stream JSON depth validator and flattener, stateless JWT validator, and app_name grant checker.
  * *Note: Implement Socket-Level Memory Defense here per Invariant II. Use a low-level token pull-parser (e.g., `struson`) to iteratively evaluate the raw byte stream and abort if nesting depth exceeds 5 BEFORE AST construction.*
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/edge/adapters.rs`. Implement `KafkaLogProducer` struct wrapping `rdkafka::producer::FutureProducer` and its async `produce` method.
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Task C.2:** Create `apps/src/edge/actors.rs`. Implement the Axum handler function for POST `/v1/logs`.
  * *Note: Implement Socket-Level Memory Defense here per Invariant II. Apply a strict `tower::timeout::TimeoutLayer` directly at the socket stream-reading phase to sever connections exceeding time-to-first-byte limits (Slowloris defense).*
  * *Note: Implement Telemetry & State Consistency here per Invariant IV. Metric `logger_events_processed_total` MUST be counted EXACTLY ONCE outside of all retry loops when a message reaches its final resolution.*
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
  * *Note: You MUST explicitly mandate tokio::time::sleep alongside the cancellation token in any I/O retry loops to prevent 100% CPU spinning.*
  * *Note: Telemetry metrics (e.g., logger_events_processed_total) MUST be incremented strictly AFTER the async I/O call (.await) successfully resolves, never before.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role edge`), instantiate `KafkaLogProducer`, load JWT public key, register metrics. Build Axum router with state, explicitly requiring wiring `axum::extract::DefaultBodyLimit::max(256 * 1024)` directly into the Axum router, and start the loops with `CancellationToken` for idempotent shutdown. bind TCP listener to 0.0.0.0:8080 with .with_graceful_shutdown() to serve HTTP traffic.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
