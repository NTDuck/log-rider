# Track 7: Admin API Actor

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role admin-api`
- **Upstream Input Source**: HTTP POST `/v1/admin/config` (JWT Admin Auth required)
- **Downstream Destinations**: ClickHouse append-only `MergeTree` table, Redis Pub/Sub
- **Performance Constraints**:
  - MUST NOT use `ReplacingMergeTree` or mutable updates in ClickHouse.

## Section 2: Interface Contracts & Data Models

### Domain Models
- **AlertConfig**:
  - `config_id`: UUID
  - `threshold`: Integer (64-bit)
  - `window_seconds`: Integer (64-bit)
  - `created_at`: String (Timestamp)

### Error Variants
- `Unauthorized`: The admin JWT is invalid or lacks proper grants.
- `WriteFailed`: The database rejected the append operation.
- `BroadcastFailed`: The cache server refused the Pub/Sub event.

### Component Contracts
- **ConfigWriter Interface**: A thread-safe boundary exposing dual operations:
  - `append_config`: Writes the immutable record to the database.
  - `publish_update_event`: Broadcasts the update notification via the cache stream.

## Section 3: Behavior-Driven Specification (BDD)

```gherkin
Feature: Admin API Configurations
  Scenario: Admin updates threshold configuration
    Given an Admin user authenticated with JWT
    When they submit a new alert configuration
    Then the system MUST append the config to the MergeTree table
    And publish an update event via Redis Pub/Sub
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement the Admin JWT validator and HTTP payload mapper.
2. **Infrastructure Adapters**: Implement the `ConfigWriter` interface by coupling a ClickHouse native HTTP client (for the insert) and a Redis client (for the publish).
3. **The Event Loop**: Implement the web server handler orchestrating the logic blocks.
   - **Telemetry**: MUST include `tracing::debug` upon successful configuration append, and `tracing::error` for DB/Redis failures. Prometheus counters `logger_admin_config_writes_total` and `logger_admin_config_errors_total` MUST be explicitly incremented.

## Section 5: Wiring & Registration
**Registration Directives:**
1. When triggered via `--role admin-api`, initialize the Database Writer and Cache Publisher adapters using environment variables.
2. Register the global Prometheus metrics for admin API success and failure events.
3. Bind the application router, inject the adapter boundaries as state, and start the HTTP engine on port `8082`.

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] ClickHouse updates verified strictly as append-only.
- [ ] Explicit tracing spans and dual-channel Prometheus metrics included in the HTTP handler.
- [ ] NO raw Rust syntax blocks inside this blueprint specification document.
