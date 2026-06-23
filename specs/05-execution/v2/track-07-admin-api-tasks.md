# Execution Tasks: Track 7: Admin API

## Phase A: TDD Scaffolding

* [ ] **Task A.1:** Create `tests/features/admin_api.feature`. Copy the Gherkin scenarios from the v10 spec exactly.
* [ ] **Task A.2:** Create `tests/steps/admin_steps.rs`. Scaffold the `cucumber::World` (`AdminWorld`) and empty failing step definitions.
* [ ] **Verification:** Run `cargo nextest run`. Ensure tests fail.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase B: Domain & Logic

* [ ] **Task B.1:** Create `apps/src/admin/models.rs`. Define `AdminConfigPayload`, `AlertConfig` (with `bon` builder), and `AdminError` (with `axiom::Erratum`). Define `ConfigWriter` trait.
* [ ] **Task B.2:** Create `apps/src/admin/logic.rs`. Implement pure functions: admin JWT claim validation, payload validation, and `AlertConfig` construction.
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase C: Infrastructure & Actor Loops

* [ ] **Task C.1:** Create `apps/src/admin/adapters.rs`. Implement ClickHouse Config Appender (HTTP POST JSONEachRow) and Redis Config Publisher (Pub/Sub) fulfilling `ConfigWriter` trait.
  * *Note: ClickHouse `UPDATE` or `DELETE` mutation queries are strictly forbidden.*
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Task C.2:** Create `apps/src/admin/actors.rs`. Implement Axum POST Handler.
  * *Note: Implement Telemetry & State Consistency here per Invariant IV. Metric `logger_events_processed_total` MUST be incremented strictly OUTSIDE of any retry loops. Count the HTTP request, not the individual I/O retry attempts.*
  * *Note: All fallible I/O or parsing operations MUST chain `.tap_err()` for tracing before using the `?` early-return operator.*
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Phase D: Monolith Wiring

* [ ] **Task D.1:** Update `apps/src/main.rs`. Wire the CLI role flag (`--role admin-api`), initialize `reqwest::Client` and `redis::aio::MultiplexedConnection`, construct `AdminConfigWriter`, retrieve metric handle, build Axum Router, and bind TCP listener with `.with_graceful_shutdown()`.
* [ ] **Commit:** Pause, run `cargo fmt --all`, and commit changes.

## Exit Gate

* [ ] Run `cargo fmt --all`
* [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`
* [ ] Run `cargo nextest run`
