# Track 3: DB Writer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role db-writer`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destination**: ClickHouse Database Table `logs`
- **Performance Constraints**:
  - MUST write logs in batches.
  - MUST NEVER perform `UPDATE` or `DELETE` mutation queries (Table-level TTL handles retention).

## Section 2: Interface Contracts & Data Models
```rust
// Reuses NormalizedLog from Track 2

#[derive(::axiom::Erratum, Debug)]
pub enum DbWriterError {
    #[error("ClickHouse connection dropped")]
    ConnectionDropped,
    #[error("Batch write timeout")]
    BatchTimeout,
}

#[async_trait::async_trait]
pub trait ClickHouseWriter: Send + Sync {
    async fn write_batch(&self, batch: &[crate::models::NormalizedLog]) -> ::axiom::result::Fallible<::core::result::Result<(), ::std::vec::Vec<DbWriterError>>>;
}
```

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
```rust
#[derive(cucumber::World, Debug, Default)]
pub struct DbWriterWorld {
    pub batch_size: usize,
    pub write_success: bool,
}
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement the batch accumulator (vector buffer). 
2. **Infrastructure Adapters**: Implement `ClickHouseWriter` using native HTTP ClickHouse client (`reqwest` or `clickhouse-rs`).
3. **The Event Loop**: Implement `tokio::spawn` loop fetching from Redpanda, batching messages by count or time interval, executing `write_batch`, and *then* committing Kafka offsets.

## Section 5: Wiring & Registration
```rust
if cli.role == "db-writer" {
    let consumer = KafkaLogConsumer::new(&config.kafka_brokers, "logs-normalized");
    let ch_writer = ClickHouseNativeWriter::new(&config.ch_url);

    ::tokio::spawn(async move {
        db_writer::run(consumer, ch_writer).await
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check` has been successfully run.
- [ ] `cargo clippy` has been successfully run with no warnings.
- [ ] `cargo nextest run` has been successfully run.
- [ ] Code has been manually checked to guarantee NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()` in application code.
- [ ] Code has been manually checked to guarantee NO stubbed/mock data interfaces.
- [ ] Explicit fallback/backoff implemented for ClickHouse downtime.
- [ ] Offsets are explicitly committed *after* the database write.
