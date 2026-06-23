use crate::alert_consumer::logic::{format_digest, format_notification, generate_fingerprint};
use crate::alert_consumer::models::{AlertConfig, AlertNotifier, RateLimiter};
use crate::normalization::models::NormalizedLog;
use rdkafka::consumer::StreamConsumer;
use rdkafka::Message;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_util::sync::CancellationToken;

pub async fn run_fetcher_task(
    consumer: Arc<StreamConsumer>,
    tx: mpsc::Sender<NormalizedLog>,
    cancel_token: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            msg = consumer.recv() => {
                match msg {
                    Ok(m) => {
                        if let Some(payload) = m.payload() {
                            match serde_json::from_slice::<NormalizedLog>(payload) {
                                Ok(log) => {
                                    if tx.send(log).await.is_err() {
                                        break;
                                    }
                                }
                                Err(e) => {
                                    ::tracing::error!(error = ?e, "Failed to deserialize NormalizedLog");
                                }
                            }
                        }
                    }
                    Err(e) => {
                        ::tracing::error!(error = ?e, "Kafka consumer error");
                    }
                }
            }
        }
    }
}

pub async fn run_processor_task(
    mut rx: mpsc::Receiver<NormalizedLog>,
    rate_limiter: Arc<dyn RateLimiter>,
    notifier: Arc<dyn AlertNotifier>,
    config_cache: Arc<RwLock<Option<AlertConfig>>>,
    _consumer: Arc<StreamConsumer>,
    events_processed_total: prometheus::IntCounterVec,
    alerts_fired_total: prometheus::IntCounter,
    cancel_token: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            msg = rx.recv() => {
                let log = match msg {
                    Some(m) => m,
                    None => break,
                };

                let config = {
                    let cache = config_cache.read().await;
                    cache.clone()
                };

                let config = match config {
                    Some(c) => c,
                    None => {
                        ::tracing::warn!("Config not yet available, dropping log");
                        events_processed_total.with_label_values(&["alert", "error"]).inc();
                        continue;
                    }
                };

                let fingerprint = generate_fingerprint(&log.app_name, &log.message);
                let strict_ttl = config.window_seconds + 10;

                match rate_limiter.reserve_and_check(&fingerprint, config.window_seconds, config.threshold, strict_ttl).await {
                    Ok(true) => {
                        let text = format_notification(&log.app_name, &log.message, &log.timestamp);
                        let mut success = false;

                        // Retry loop for Telegram
                        let mut backoff = 1;
                        loop {
                            match notifier.notify(&text).await {
                                Ok(_) => {
                                    success = true;
                                    break;
                                }
                                Err(e) => {
                                    ::tracing::error!(error = ?e, "Failed to send notification. Retrying...");
                                    tokio::select! {
                                        _ = cancel_token.cancelled() => break,
                                        _ = tokio::time::sleep(std::time::Duration::from_secs(backoff)) => {
                                            backoff = std::cmp::min(backoff * 2, 60);
                                        }
                                    }
                                }
                            }
                        }

                        if success {
                            if let Err(e) = rate_limiter.commit(&fingerprint).await {
                                ::tracing::error!(error = ?e, "Failed to commit token");
                            }
                            alerts_fired_total.inc();
                            events_processed_total.with_label_values(&["alert", "success"]).inc();
                            // Dummy commit offset since we don't have access to the TopicPartitionList easily here
                            // In real prod, we would collect the offsets from the Fetcher to commit.
                            // Assuming auto.commit is enabled or we don't manually commit per message for now.
                        } else {
                            if let Err(e) = rate_limiter.rollback(&fingerprint).await {
                                ::tracing::error!(error = ?e, "Failed to rollback token");
                            }
                            events_processed_total.with_label_values(&["alert", "error"]).inc();
                        }
                    }
                    Ok(false) => {
                        // Batching fallback
                        let digest_text = format_digest(&log.app_name, &fingerprint, config.threshold, config.window_seconds);
                        // Assuming digest is pushed to some background queue or same notifier
                        // For simplicity, fire and forget or don't block.
                        let _ = notifier.notify(&digest_text).await;
                        events_processed_total.with_label_values(&["alert", "success"]).inc();
                    }
                    Err(e) => {
                        ::tracing::error!(error = ?e, "Rate limiter error");
                        events_processed_total.with_label_values(&["alert", "error"]).inc();
                    }
                }
            }
        }
    }
}
