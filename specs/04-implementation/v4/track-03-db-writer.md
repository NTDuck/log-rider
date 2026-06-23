# Track 3: DB Writer

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role db-writer`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destination**: ClickHouse Database Table `logs`
- **Performance Constraints**: MUST write logs in batches. MUST NOT execute UPDATE/DELETE.

## Section 2: Interface Contracts & Data Models
```rust
// Uses NormalizedLog from Track 2

#[derive(::axiom::Erratum, Debug)]
pub enum DbWriterError {
    #[error("ClickHouse connection dropped")]
    ConnectionDropped,
    #[error("Batch write timeout")]
    BatchTimeout,
    #[error("Kafka consumer error")]
    ConsumerError,
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
1. **Pure Logic**: Batch accumulator buffer triggering on fixed row count or time elapsed.
2. **Infrastructure Adapters**: `reqwest::Client` mapped to `ClickHouseWriter` executing native HTTP JSONEachRow INSERTs.
3. **The Event Loop**: 
   - Consumer reads messages -> appends to `Vec`.
   - If threshold met -> `write_batch`.
   - **Resilience**: Wrap `write_batch` in a `tokio-retry` loop with exponential backoff on `DbWriterError`.
   - Commit offset ONLY after backoff loop succeeds.
   - **Telemetry**: `::tracing::debug!` for inserts, `::tracing::error!` for backoffs. Increment `logger_ch_writes_success_total` and `logger_ch_writes_error_total`.

## Section 5: Wiring & Registration
```rust
if cli.role == "db-writer" {
    let consumer = crate::adapters::KafkaLogConsumer::new(&config.kafka_brokers, "logs-normalized").await?;
    let ch_writer = crate::adapters::ClickHouseNativeWriter::new(&config.ch_url)?;

    let registry = ::prometheus::default_registry();
    registry.register(::std::boxed::Box::new(logger_ch_writes_success_total.clone())).unwrap_or_default();
    registry.register(::std::boxed::Box::new(logger_ch_writes_error_total.clone())).unwrap_or_default();

    ::tokio::spawn(async move {
        match crate::db_writer::run_loop(consumer, ch_writer).await {
            Ok(_) => {},
            Err(e) => ::tracing::error!("DB Writer loop exited: {:?}", e),
        }
    });
}
```

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] NO `.unwrap()` or mock data interfaces.
- [ ] Exponential backoff integrated directly into DB call.
- [ ] Offsets explicitly committed ONLY after successful DB write.
- [ ] Explicit tracing spans and Prometheus error/success metrics.
