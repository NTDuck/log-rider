use async_trait::async_trait;
use cucumber::{given, then, when, World};
use logger::edge::models::DomainLog;
use logger::normalization::actors::run_processor_task;
use logger::normalization::adapters::{LogConsumer, NormalizedProducer};
use logger::normalization::models::{DLQEnvelope, NormalizationError, NormalizedLog};
use parking_lot::Mutex;
use prometheus::{IntCounter, IntCounterVec};
use rdkafka::message::{OwnedMessage, Timestamp};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Default)]
struct MockConsumer {
    commits: Mutex<usize>,
}

#[async_trait]
impl LogConsumer for MockConsumer {
    async fn consume(&self) -> Result<(Vec<u8>, OwnedMessage), NormalizationError> {
        unreachable!()
    }
    fn commit_offset(&self, _message: &OwnedMessage) -> Result<(), NormalizationError> {
        *self.commits.lock() += 1;
        Ok(())
    }
}

#[derive(Debug, Default)]
struct MockProducer {
    normalized: Mutex<Vec<NormalizedLog>>,
    alerts: Mutex<Vec<NormalizedLog>>,
    dlq: Mutex<Vec<DLQEnvelope>>,
}

#[async_trait]
impl NormalizedProducer for MockProducer {
    async fn produce_normalized(&self, log: &NormalizedLog) -> Result<(), NormalizationError> {
        self.normalized.lock().push(log.clone());
        Ok(())
    }
    async fn produce_alert(&self, log: &NormalizedLog) -> Result<(), NormalizationError> {
        self.alerts.lock().push(log.clone());
        Ok(())
    }
    async fn produce_dlq(&self, envelope: &DLQEnvelope) -> Result<(), NormalizationError> {
        self.dlq.lock().push(envelope.clone());
        Ok(())
    }
}

#[derive(Debug, World)]
pub struct NormalizationWorld {
    consumer: Arc<MockConsumer>,
    producer: Arc<MockProducer>,
    events_processed_total: IntCounterVec,
    dlq_routed_total: IntCounter,
    pii_redactions_total: IntCounter,
    raw_payload: Vec<u8>,
}

impl Default for NormalizationWorld {
    fn default() -> Self {
        Self {
            consumer: Arc::new(MockConsumer::default()),
            producer: Arc::new(MockProducer::default()),
            events_processed_total: IntCounterVec::new(
                prometheus::Opts::new("test_events", "events"),
                &["stage", "status"],
            )
            .unwrap(),
            dlq_routed_total: IntCounter::new("test_dlq", "dlq").unwrap(),
            pii_redactions_total: IntCounter::new("test_pii", "pii").unwrap(),
            raw_payload: vec![],
        }
    }
}

#[given("a log message in logs-raw containing PII patterns (e.g., email addresses, credit card numbers)")]
async fn given_log_with_pii(world: &mut NormalizationWorld) {
    let log = DomainLog::builder()
        .timestamp("2026-01-01T00:00:00Z".into())
        .level("INFO".into())
        .message("User test@example.com paid with 1234-5678-1234-5678.".into())
        .app_name("test-app".into())
        .attribute_keys(vec![])
        .attribute_values_string(vec![])
        .build();
    world.raw_payload = serde_json::to_vec(&log).unwrap();
}

#[when("the Normalization Worker consumes and processes it")]
async fn when_consumes_and_processes(world: &mut NormalizationWorld) {
    let (tx, rx) = mpsc::channel(1);
    let msg = OwnedMessage::new(
        Some(world.raw_payload.clone()),
        None,
        "logs-raw".into(),
        Timestamp::NotAvailable,
        0,
        0,
        None,
    );
    tx.send((world.raw_payload.clone(), msg)).await.unwrap();
    drop(tx);

    let cancel = CancellationToken::new();
    run_processor_task(
        world.producer.clone(),
        world.consumer.clone(),
        rx,
        world.events_processed_total.clone(),
        world.dlq_routed_total.clone(),
        world.pii_redactions_total.clone(),
        cancel,
    )
    .await;
}

#[then("the worker MUST apply all compiled PII regex patterns to the message field")]
async fn then_apply_pii_regex(world: &mut NormalizationWorld) {
    let logs = world.producer.normalized.lock();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].message, "User [REDACTED] paid with [REDACTED].");
}

#[then("increment logger_pii_redactions_total for each regex hit")]
async fn then_increment_pii_redactions(world: &mut NormalizationWorld) {
    assert_eq!(world.pii_redactions_total.get(), 2);
}

#[then("publish the redacted NormalizedLog to logs-normalized")]
async fn then_publish_redacted_normalized_log(world: &mut NormalizationWorld) {
    assert_eq!(world.producer.normalized.lock().len(), 1);
}

#[then("increment logger_events_processed_total with labels stage=\"normalization\" and status=\"success\" exactly once")]
async fn then_increment_processed_success(world: &mut NormalizationWorld) {
    assert_eq!(
        world
            .events_processed_total
            .with_label_values(&["normalization", "success"])
            .get(),
        1
    );
}

#[then("commit the consumer offset only after the produce to logs-normalized returns success")]
async fn then_commit_after_produce(world: &mut NormalizationWorld) {
    assert_eq!(*world.consumer.commits.lock(), 1);
}

#[given("a log message in logs-raw with level ERROR")]
async fn given_log_level_error(world: &mut NormalizationWorld) {
    let log = DomainLog::builder()
        .timestamp("2026-01-01T00:00:00Z".into())
        .level("ERROR".into())
        .message("test error".into())
        .app_name("test-app".into())
        .attribute_keys(vec![])
        .attribute_values_string(vec![])
        .build();
    world.raw_payload = serde_json::to_vec(&log).unwrap();
}

#[when("the Normalization Worker consumes, PII-redacts, and normalizes it")]
async fn when_consumes_redacts_normalizes(world: &mut NormalizationWorld) {
    when_consumes_and_processes(world).await;
}

#[then("the worker MUST publish the redacted NormalizedLog to logs-normalized")]
async fn then_worker_publish_redacted(world: &mut NormalizationWorld) {
    assert_eq!(world.producer.normalized.lock().len(), 1);
}

#[then("MUST publish the same redacted NormalizedLog to alerts-priority-stream")]
async fn then_publish_to_alerts_stream(world: &mut NormalizationWorld) {
    assert_eq!(world.producer.alerts.lock().len(), 1);
}

#[then("commit the consumer offset only after both produces return success")]
async fn then_commit_after_both_produces(world: &mut NormalizationWorld) {
    assert_eq!(*world.consumer.commits.lock(), 1);
}

#[given("a log message in logs-raw with level CRITICAL")]
async fn given_log_level_critical(world: &mut NormalizationWorld) {
    let log = DomainLog::builder()
        .timestamp("2026-01-01T00:00:00Z".into())
        .level("CRITICAL".into())
        .message("test critical".into())
        .app_name("test-app".into())
        .attribute_keys(vec![])
        .attribute_values_string(vec![])
        .build();
    world.raw_payload = serde_json::to_vec(&log).unwrap();
}

#[given("a raw payload in logs-raw whose compressed size exceeds 64KB")]
async fn given_payload_exceeds_64kb(world: &mut NormalizationWorld) {
    world.raw_payload = vec![0; 65537];
}

#[when("the Normalization Worker detects the size violation")]
async fn when_detects_size_violation(world: &mut NormalizationWorld) {
    when_consumes_and_processes(world).await;
}

#[then("it MUST construct a DLQEnvelope with truncated payload, hash, reason, worker_id, and timestamp")]
async fn then_construct_dlq_envelope_with_details(world: &mut NormalizationWorld) {
    let dlq = world.producer.dlq.lock();
    assert_eq!(dlq.len(), 1);
    let env = &dlq[0];
    assert!(env.error_reason.contains("Size violation"));
    assert_eq!(env.original_payload_truncated.len(), 2048);
}

#[then("publish the DLQEnvelope to logs-dlq")]
async fn then_publish_dlq(world: &mut NormalizationWorld) {
    assert_eq!(world.producer.dlq.lock().len(), 1);
}

#[then("increment logger_dlq_routed_total")]
async fn then_increment_dlq_routed(world: &mut NormalizationWorld) {
    assert_eq!(world.dlq_routed_total.get(), 1);
}

#[then("increment logger_events_processed_total with labels stage=\"normalization\" and status=\"error\" exactly once")]
async fn then_increment_processed_error(world: &mut NormalizationWorld) {
    assert_eq!(
        world
            .events_processed_total
            .with_label_values(&["normalization", "error"])
            .get(),
        1
    );
}

#[then("commit the consumer offset after the DLQ produce returns success")]
async fn then_commit_after_dlq_produce(world: &mut NormalizationWorld) {
    assert_eq!(*world.consumer.commits.lock(), 1);
}

#[given("a raw payload in logs-raw that is valid in size but fails JSON deserialization")]
async fn given_invalid_json_payload(world: &mut NormalizationWorld) {
    world.raw_payload = b"{ invalid json }".to_vec();
}

#[when("the Normalization Worker attempts to parse it")]
async fn when_attempts_to_parse(world: &mut NormalizationWorld) {
    when_consumes_and_processes(world).await;
}

#[then("it MUST construct a DLQEnvelope with the truncated payload and hash")]
async fn then_construct_dlq_envelope_truncated(world: &mut NormalizationWorld) {
    let dlq = world.producer.dlq.lock();
    assert_eq!(dlq.len(), 1);
    assert!(dlq[0].error_reason.contains("Deserialization"));
}

#[then("publish to logs-dlq")]
async fn then_publish_to_logs_dlq(world: &mut NormalizationWorld) {
    assert_eq!(world.producer.dlq.lock().len(), 1);
}
