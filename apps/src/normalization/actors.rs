use crate::edge::models::DomainLog;
use crate::normalization::adapters::{LogConsumer, NormalizedProducer};
use crate::normalization::logic::{flatten_to_parallel_arrays, is_poison_pill, redact_pii};
use crate::normalization::models::{DLQEnvelope, NormalizedLog};
use prometheus::{IntCounter, IntCounterVec};
use rdkafka::message::OwnedMessage;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

#[::tracing::instrument(skip_all)]
pub async fn run_fetcher_task(
    consumer: Arc<dyn LogConsumer>,
    sender: mpsc::Sender<(Vec<u8>, OwnedMessage)>,
    cancel_token: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            res = consumer.consume() => {
                match res {
                    Ok(msg) => {
                        if sender.send(msg).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        continue;
                    }
                }
            }
        }
    }
}

#[::tracing::instrument(skip_all)]
pub async fn run_processor_task(
    producer: Arc<dyn NormalizedProducer>,
    consumer: Arc<dyn LogConsumer>,
    mut receiver: mpsc::Receiver<(Vec<u8>, OwnedMessage)>,
    events_processed_total: IntCounterVec,
    dlq_routed_total: IntCounter,
    pii_redactions_total: IntCounter,
    cancel_token: CancellationToken,
) {
    let worker_id = "worker-1".to_string();

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            msg_opt = receiver.recv() => {
                let Some((raw_bytes, metadata)) = msg_opt else {
                    break;
                };

                let now = chrono::Utc::now().to_rfc3339();

                // 1. Poison Pill Gate
                if is_poison_pill(&raw_bytes) {
                    let envelope = DLQEnvelope::builder()
                        .failed_at(now)
                        .error_reason("Size violation: exceeds 64KB".to_string())
                        .worker_id(worker_id.clone())
                        .raw_payload(&raw_bytes)
                        .build();

                    let mut attempt = 0;
                    loop {
                        tokio::select! {
                            _ = cancel_token.cancelled() => return,
                            res = producer.produce_dlq(&envelope) => {
                                match res {
                                    Ok(_) => break,
                                    Err(_) => {
                                        attempt += 1;
                                        let delay = std::cmp::min(100 * (2u64.pow(attempt)), 5000);
                                        tokio::select! {
                                            _ = cancel_token.cancelled() => return,
                                            _ = sleep(Duration::from_millis(delay)) => continue,
                                        }
                                    }
                                }
                            }
                        }
                    }

                    dlq_routed_total.inc();
                    events_processed_total.with_label_values(&["normalization", "error"]).inc();
                    let _ = consumer.commit_offset(&metadata);
                    continue;
                }

                // 2. Deserialize
                let domain_log: DomainLog = match serde_json::from_slice(&raw_bytes) {
                    Ok(l) => l,
                    Err(e) => {
                        let envelope = DLQEnvelope::builder()
                            .failed_at(now)
                            .error_reason(format!("Deserialization failed: {}", e))
                            .worker_id(worker_id.clone())
                            .raw_payload(&raw_bytes)
                            .build();

                        let mut attempt = 0;
                        loop {
                            tokio::select! {
                                _ = cancel_token.cancelled() => return,
                                res = producer.produce_dlq(&envelope) => {
                                    match res {
                                        Ok(_) => break,
                                        Err(_) => {
                                            attempt += 1;
                                            let delay = std::cmp::min(100 * (2u64.pow(attempt)), 5000);
                                            tokio::select! {
                                                _ = cancel_token.cancelled() => return,
                                                _ = sleep(Duration::from_millis(delay)) => continue,
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        dlq_routed_total.inc();
                        events_processed_total.with_label_values(&["normalization", "error"]).inc();
                        let _ = consumer.commit_offset(&metadata);
                        continue;
                    }
                };

                // 3. PII Redaction
                let (redacted_message, pii_count) = redact_pii(&domain_log.message);
                if pii_count > 0 {
                    pii_redactions_total.inc_by(pii_count);
                }

                // 4. Build NormalizedLog
                let (keys, vals) = flatten_to_parallel_arrays(
                    domain_log.attribute_keys,
                    domain_log.attribute_values_string,
                );

                let log_id = uuid::Uuid::new_v4();

                let normalized_log = NormalizedLog::builder()
                    .log_id(log_id)
                    .timestamp(domain_log.timestamp)
                    .level(domain_log.level.clone())
                    .message(redacted_message)
                    .app_name(domain_log.app_name)
                    .maybe_error_code(domain_log.error_code)
                    .attribute_keys(keys)
                    .attribute_values_string(vals)
                    .build();

                // 5. Produce Normalized
                let mut attempt = 0;
                loop {
                    tokio::select! {
                        _ = cancel_token.cancelled() => return,
                        res = producer.produce_normalized(&normalized_log) => {
                            match res {
                                Ok(_) => break,
                                Err(_) => {
                                    attempt += 1;
                                    let delay = std::cmp::min(100 * (2u64.pow(attempt)), 5000);
                                    tokio::select! {
                                        _ = cancel_token.cancelled() => return,
                                        _ = sleep(Duration::from_millis(delay)) => continue,
                                    }
                                }
                            }
                        }
                    }
                }

                // 6. Alert Duplication Gate
                if normalized_log.level == "ERROR" || normalized_log.level == "CRITICAL" {
                    let mut attempt = 0;
                    loop {
                        tokio::select! {
                            _ = cancel_token.cancelled() => return,
                            res = producer.produce_alert(&normalized_log) => {
                                match res {
                                    Ok(_) => break,
                                    Err(_) => {
                                        attempt += 1;
                                        let delay = std::cmp::min(100 * (2u64.pow(attempt)), 5000);
                                        tokio::select! {
                                            _ = cancel_token.cancelled() => return,
                                            _ = sleep(Duration::from_millis(delay)) => continue,
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // 7. Telemetry Isolation
                events_processed_total.with_label_values(&["normalization", "success"]).inc();

                // 8. Commit
                let _ = consumer.commit_offset(&metadata);
            }
        }
    }
}
