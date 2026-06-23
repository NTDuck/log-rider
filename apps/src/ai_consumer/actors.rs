use crate::ai_consumer::logic::extract_message_body;
use crate::ai_consumer::models::{AIClassifier, TagStreamPublisher};
use crate::normalization::models::NormalizedLog;
use prometheus::IntCounterVec;
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::Message;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info};

pub async fn run_classification_loop(
    consumer: Arc<StreamConsumer>,
    classifier: Arc<dyn AIClassifier>,
    publisher: Arc<dyn TagStreamPublisher>,
    metrics: IntCounterVec,
    cancellation_token: CancellationToken,
) {
    let (tx, mut rx) = mpsc::channel::<rdkafka::message::OwnedMessage>(100);

    let fetcher_token = cancellation_token.clone();
    let consumer_clone = consumer.clone();

    let fetcher_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = fetcher_token.cancelled() => {
                    info!("Fetcher task cancelled");
                    break;
                }
                msg_result = consumer_clone.recv() => {
                    match msg_result {
                        Ok(msg) => {
                            if tx.send(msg.detach()).await.is_err() {
                                break; // Receiver dropped
                            }
                        }
                        Err(e) => {
                            error!(error = %e, "Kafka consumer error");
                        }
                    }
                }
            }
        }
    });

    let processor_token = cancellation_token.clone();
    let processor_task = tokio::spawn(async move {
        let mut buffer = Vec::with_capacity(100);
        loop {
            buffer.clear();
            let count = tokio::select! {
                _ = processor_token.cancelled() => {
                    info!("Processor task cancelled");
                    break;
                }
                c = rx.recv_many(&mut buffer, 100) => c,
            };

            if count == 0 {
                break;
            }

            let mut success_count = 0;
            let mut highest_offsets = std::collections::HashMap::new();

            for msg in &buffer {
                highest_offsets.insert(msg.partition(), msg.offset());

                let payload = match msg.payload() {
                    Some(p) => p,
                    None => continue,
                };

                let log: NormalizedLog = match serde_json::from_slice(payload) {
                    Ok(l) => l,
                    Err(e) => {
                        error!(error = %e, topic = msg.topic(), partition = msg.partition(), offset = msg.offset(), "Deserialization error");
                        metrics.with_label_values(&["ai_consumer", "error"]).inc();
                        continue;
                    }
                };

                let body = extract_message_body(&log);
                let tag = match classifier.classify(log.log_id, &body).await {
                    Ok(t) => t,
                    Err(e) => {
                        error!(error = ?e, "Inference error");
                        metrics.with_label_values(&["ai_consumer", "error"]).inc();
                        continue;
                    }
                };

                let mut backoff = 1;
                loop {
                    tokio::select! {
                        _ = processor_token.cancelled() => {
                            return;
                        }
                        res = publisher.publish_patch(&tag) => {
                            match res {
                                Ok(_) => {
                                    success_count += 1;
                                    break;
                                }
                                Err(e) => {
                                    error!(error = ?e, "Failed to publish tag, retrying");
                                    let sleep_duration = tokio::time::Duration::from_secs(backoff);
                                    backoff = std::cmp::min(backoff * 2, 60);
                                    tokio::select! {
                                        _ = processor_token.cancelled() => { return; }
                                        _ = tokio::time::sleep(sleep_duration) => {}
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if !highest_offsets.is_empty() {
                let mut tpl = rdkafka::TopicPartitionList::new();
                for (partition, offset) in highest_offsets {
                    // +1 to commit the NEXT message offset, per librdkafka semantics
                    tpl.add_partition_offset(
                        buffer[0].topic(),
                        partition,
                        rdkafka::Offset::Offset(offset + 1),
                    )
                    .unwrap();
                }
                let _ = consumer.commit(&tpl, CommitMode::Async);
            }

            if success_count > 0 {
                metrics
                    .with_label_values(&["ai_consumer", "success"])
                    .inc_by(success_count as u64);
                debug!("Published {} tags", success_count);
            }
        }
    });

    let _ = tokio::join!(fetcher_task, processor_task);
}
