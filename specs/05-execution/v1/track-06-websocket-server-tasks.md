# Execution Tasks: Track 6: WebSocket Server

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/websocket.feature`. Copy the Gherkin scenarios from the v10 spec exactly.
* [ ] **Task A.2:** Create `tests/steps/websocket_steps.rs`. Scaffold the `cucumber::World` (`WSWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "test: scaffold websocket BDD tests"`).

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/ws/models.rs`. Define `WsClientConfig`, `BroadcastMessage` (with `bon` Builder), and `WSError` (with `axiom::Erratum`).
* [ ] **Task B.2:** Create `apps/src/ws/auth.rs`. Implement `parse_ws_claims` pure function.
* [ ] **Task B.3:** Create `apps/src/ws/filter.rs`. Implement `should_deliver` pure predicate.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement websocket domain models and pure logic"`).

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/ws/handler.rs`. Implement Axum WebSocket upgrade handler and `session_loop`.
  * *Note: Implement Egress Decoupling & TCP Blocking per Invariant III. Physically decouple every WebSocket session into a 3-Task Ingress/Processor/Egress separation using local bounded `mpsc` channels. The Processor executes `.try_send()`; the Egress Task executes `sink.send().await`.*
  * *Note: Telemetry (`logger_events_processed_total`) MUST be incremented EXACTLY ONCE per client delivery attempt, occurring strictly inside Task C (Egress Sink) after `sink.send().await` resolves.*
* [ ] **Task C.2:** Create `apps/src/ws/ingestion.rs`. Implement `ingestion_loop` consuming from Kafka and pushing to the global broadcast channel.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: implement websocket handler, session loop, and ingestion loop"`).

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role ws-server`), create bounded `tokio::sync::broadcast` channel (capacity 1024), instantiate `KafkaLogConsumer`, register metrics (`logger_active_connections`, `logger_events_processed_total`), build Axum router, spawn ingestion loop, and bind TCP listener with `.with_graceful_shutdown()`.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes (e.g., `git commit -m "feat: wire websocket server into monolith main"`).

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
