# Track 3: DB Writer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role db-writer`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destination**: ClickHouse Database Table `logs`
- **Performance Constraints**:
  - MUST write logs in batches.
  - MUST NEVER perform `UPDATE` or `DELETE` mutation queries (Table-level TTL handles retention).

## Section 2: Interface Contracts & Data Models

### Domain Models
- (Reuses the `NormalizedLog` schema defined in Track 2).

### Error Variants
- `ConnectionDropped`: The ClickHouse endpoint is unreachable or connection reset.
- `BatchTimeout`: The database failed to acknowledge the batch write within the allocated window.

### Component Contracts
- **ClickHouseWriter Interface**: A thread-safe abstraction that exposes an asynchronous `write_batch` operation, accepting an array of `NormalizedLog` entities.

## Section 3: Behavior-Driven Specification (BDD)

```gherkin
Feature: Database Writer
  Scenario: Batch of normalized logs is written to ClickHouse
    Given a batch of messages consumed from logs-normalized
    When the DB Writer processes the batch
    Then it MUST format an INSERT payload
    And write it to the ClickHouse logs table
    And commit Redpanda offsets only after successful DB write

  Scenario: ClickHouse is offline
    Given ClickHouse is unreachable
    When the DB Writer attempts to write a batch
    Then it MUST implement exponential backoff
    And MUST NOT commit Redpanda offsets
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement the batch accumulator buffer (triggering on explicit time windows or maximum row count).
2. **Infrastructure Adapters**: Implement the `ClickHouseWriter` contract using a native HTTP ClickHouse client to perform standard `INSERT` operations.
3. **The Event Loop**: Implement a background worker fetching from the message broker, batching messages, executing the write adapter, and *then* committing broker offsets.
   - **Resilience**: Explicitly implement exponential backoff upon detecting `DbWriterError` to prevent worker panics during database maintenance.
   - **Telemetry**: The loop MUST emit `tracing::debug` for batch insertions and `tracing::error` for database timeouts/backoff triggers. Prometheus counters `logger_ch_writes_success_total` and `logger_ch_writes_error_total` MUST be explicitly incremented.

## Section 5: Wiring & Registration
**Registration Directives:**
1. Capture the `--role db-writer` argument from the CLI startup hook.
2. Instantiate the message broker consumer and the native ClickHouse HTTP writer using environment variables.
3. Initialize the database-specific Prometheus counters (`logger_ch_writes_success_total`, `logger_ch_writes_error_total`) in the global metrics registry.
4. Inject the dependencies into the DB Writer service context.
5. Spawn the background polling task.

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Code guaranteed to contain NO stubbed/mock data interfaces.
- [ ] Explicit fallback/backoff implemented for ClickHouse downtime.
- [ ] Offsets are explicitly committed *after* the database write.
- [ ] Explicit tracing spans and dual-channel (success/error) Prometheus metric tracking included.
- [ ] NO raw Rust syntax blocks inside this blueprint specification document.
