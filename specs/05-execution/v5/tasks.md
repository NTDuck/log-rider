# Phase 5: v3 Execution Tasks (Code Generation)

## Phase 1: Setup

**Purpose**: Establish the LLM Code Generation Strategy based on the Playbook.

- [x] T001 Verify `cargo nextest` is installed and the `tests/features/` directory is prepared.

---

## Phase 2: Track 1 - Edge Receiver (Priority: P1)

**Goal**: Implement Edge Receiver tasks using TDD Gatekeeper strategy.
**Independent Test**: Run `cargo nextest run` to verify BDD tests.

### Tests for Track 1 ⚠️
> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**
- [x] T002 [US1] Feed `specs/05-execution/v3/track-01-edge-receiver-tasks.md` (Phase A) to coding agent and run `cargo nextest run` to confirm tests fail.

### Implementation for Track 1
- [x] T003 [US1] Feed `specs/05-execution/v3/track-01-edge-receiver-tasks.md` (Phase B, C, D) to coding agent. Verify `serde_json::Value` and `WireLog` are NOT used, and `.tap_err()` is applied. (depends on T002)

**Checkpoint**: Track 1 should be fully functional and testable independently

---

## Phase 3: Track 2 - Normalization Worker (Priority: P2)

**Goal**: Implement Normalization Worker tasks using TDD Gatekeeper strategy.
**Independent Test**: Run `cargo nextest run` to verify BDD tests.

### Tests for Track 2 ⚠️
- [x] T004 [US2] Feed `specs/05-execution/v3/track-02-normalization-worker-tasks.md` (Phase A) to coding agent and run tests to fail.

### Implementation for Track 2
- [x] T005 [US2] Feed `specs/05-execution/v3/track-02-normalization-worker-tasks.md` (Phase B, C, D) to coding agent. Verify `.tap_err()` is applied. (depends on T004)

**Checkpoint**: Track 2 should be fully functional and testable independently

---

## Phase 4: Track 3 - DB Writer (Priority: P3)

**Goal**: Implement DB Writer tasks using TDD Gatekeeper strategy.
**Independent Test**: Run `cargo nextest run` to verify BDD tests.

### Tests for Track 3 ⚠️
- [x] T006 [US3] Feed `specs/05-execution/v3/track-03-db-writer-tasks.md` (Phase A) to coding agent and run tests to fail.

### Implementation for Track 3
- [x] T007 [US3] Feed `specs/05-execution/v3/track-03-db-writer-tasks.md` (Phase B, C, D) to coding agent. Verify ClickHouse `UPDATE/DELETE` queries are strictly forbidden. Verify `.tap_err()` is applied. (depends on T006)

**Checkpoint**: Track 3 should be fully functional and testable independently

---

## Phase 5: Track 4 - AI Consumer (Priority: P4)

**Goal**: Implement AI Consumer tasks using TDD Gatekeeper strategy.
**Independent Test**: Run `cargo nextest run` to verify BDD tests.

### Tests for Track 4 ⚠️
- [x] T008 [US4] Feed `specs/05-execution/v3/track-04-ai-consumer-tasks.md` (Phase A) to coding agent and run tests to fail.

### Implementation for Track 4
- [x] T009 [US4] Feed `specs/05-execution/v3/track-04-ai-consumer-tasks.md` (Phase B, C, D) to coding agent. Verify `.tap_err()` is applied. (depends on T008)

**Checkpoint**: Track 4 should be fully functional and testable independently

---

## Phase 6: Track 5 - Alert Consumer (Priority: P5)

**Goal**: Implement Alert Consumer tasks using TDD Gatekeeper strategy.
**Independent Test**: Run `cargo nextest run` to verify BDD tests.

### Tests for Track 5 ⚠️
- [x] T010 [US5] Feed `specs/05-execution/v3/track-05-alert-consumer-tasks.md` (Phase A) to coding agent and run tests to fail.

### Implementation for Track 5
- [x] T011 [US5] Feed `specs/05-execution/v3/track-05-alert-consumer-tasks.md` (Phase B, C, D) to coding agent. Verify Redis `window_seconds + 10` TTL and `tokio::time::sleep` retry loops are implemented. Verify `.tap_err()` is applied. (depends on T010)

**Checkpoint**: Track 5 should be fully functional and testable independently

---

## Phase 7: Track 6 - WebSocket Server (Priority: P6)

**Goal**: Implement WebSocket Server tasks using TDD Gatekeeper strategy.
**Independent Test**: Run `cargo nextest run` to verify BDD tests.

### Tests for Track 6 ⚠️
- [x] T012 [US6] Feed `specs/05-execution/v3/track-06-websocket-server-tasks.md` (Phase A) to coding agent and run tests to fail.

### Implementation for Track 6
- [x] T013 [US6] Feed `specs/05-execution/v3/track-06-websocket-server-tasks.md` (Phase B, C, D) to coding agent. Verify `.tap_err()` is applied. (depends on T012)

**Checkpoint**: Track 6 should be fully functional and testable independently

---

## Phase 8: Track 7 - Admin API (Priority: P7)

**Goal**: Implement Admin API tasks using TDD Gatekeeper strategy.
**Independent Test**: Run `cargo nextest run` to verify BDD tests.

### Tests for Track 7 ⚠️
- [x] T014 [US7] Feed `specs/05-execution/v3/track-07-admin-api-tasks.md` (Phase A) to coding agent and run tests to fail.

### Implementation for Track 7
- [x] T015 [US7] Feed `specs/05-execution/v3/track-07-admin-api-tasks.md` (Phase B, C, D) to coding agent. Verify ClickHouse `UPDATE/DELETE` queries are strictly forbidden. Verify `.tap_err()` is applied. (depends on T014)

**Checkpoint**: Track 7 should be fully functional and testable independently

---

## Phase 9: Track 8 - AI Tag DB Projection (Priority: P8)

**Goal**: Implement AI Tag Projection tasks using TDD Gatekeeper strategy.
**Independent Test**: Run `cargo nextest run` to verify BDD tests.

### Tests for Track 8 ⚠️
- [x] T016 [US8] Feed `specs/05-execution/v3/track-08-ai-tag-projection-tasks.md` (Phase A) to coding agent and run tests to fail.

### Implementation for Track 8
- [x] T017 [US8] Feed `specs/05-execution/v3/track-08-ai-tag-projection-tasks.md` (Phase B, C, D) to coding agent. Verify `logger_events_processed_total` metric is incremented explicitly outside retry loops. Verify ClickHouse `UPDATE/DELETE` queries are strictly forbidden. Verify `.tap_err()` is applied. (depends on T016)

**Checkpoint**: Track 8 should be fully functional and testable independently

---

## Execution Wave DAG

- **Wave 1:** `T001` (Setup)
- **Wave 2:** `T002`, `T004`, `T006`, `T008`, `T010`, `T012`, `T014`, `T016` (All Phase A TDD scaffolds can be run in parallel by the coding agent across different terminals)
- **Wave 3:** `T003`, `T005`, `T007`, `T009`, `T011`, `T013`, `T015`, `T017` (Implementations, each dependent on their respective Phase A)

## Implementation Strategy

### The "TDD Gatekeeper" Strategy
Do not let the coding agent claim it successfully wrote the logic. Force it to run `cargo nextest run`, and rely strictly on the compiler and the BDD test output to verify if the LLM actually followed the dense architectural notes embedded in the `v3` files.
