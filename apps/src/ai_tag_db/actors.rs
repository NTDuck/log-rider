use crate::ai_tag_db::logic::AITagBatchAccumulator;
use crate::ai_tag_db::models::{AITagClickHouseWriter, AITagMessage};
use prometheus::IntCounterVec;
use rdkafka::{consumer::StreamConsumer, Message as KafkaMessage};
use std::sync::Arc;
use std::time::Duration;
use tap::TapFallible;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[::tracing::instrument(skip_all)]
pub async fn run_tag_fetcher_task(
    consumer: Arc<StreamConsumer>,
    tx: mpsc::Sender<rdkafka::message::OwnedMessage>,
    cancel_token: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                ::tracing::info!("Fetcher task cancelled");
                break;
            }
            msg_res = consumer.recv() => {
                match msg_res {
                    Ok(msg) => {
                        let owned_msg = msg.detach();
                        if tx.send(owned_msg).await.is_err() {
                            ::tracing::warn!("Channel closed, fetcher exiting");
                            break;
                        }
                    }
                    Err(e) => {
                        ::tracing::error!(error = %e, "Kafka consume error");
                    }
                }
            }
        }
    }
}

#[::tracing::instrument(skip_all)]
pub async fn run_tag_processor_task(
    mut rx: mpsc::Receiver<rdkafka::message::OwnedMessage>,
    writer: Arc<dyn AITagClickHouseWriter>,
    events_processed_total: IntCounterVec,
    cancel_token: CancellationToken,
) {
    let mut accumulator = AITagBatchAccumulator::new(1000);
    let mut flush_interval = tokio::time::interval(Duration::from_secs(5));

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                ::tracing::info!("Processor task cancelled, flushing remaining");
                if let Some(batch) = accumulator.flush_remaining() {
                    let _ = flush_subroutine(batch, &writer, &events_processed_total, cancel_token.clone()).await;
                }
                break;
            }
            _ = flush_interval.tick() => {
                if let Some(batch) = accumulator.flush_remaining() {
                    if !flush_subroutine(batch, &writer, &events_processed_total, cancel_token.clone()).await {
                        break;
                    }
                }
            }
            msg_opt = rx.recv() => {
                match msg_opt {
                    Some(msg) => {
                        if let Some(payload) = msg.payload() {
                            match serde_json::from_slice::<AITagMessage>(payload)
                                .tap_err(|e| ::tracing::error!(error = %e, "Failed to deserialize AITagMessage"))
                            {
                                Ok(tag) => {
                                    if let Some(batch) = accumulator.push(tag) {
                                        if !flush_subroutine(batch, &writer, &events_processed_total, cancel_token.clone()).await {
                                            break;
                                        }
                                        flush_interval.reset();
                                    }
                                }
                                Err(_) => {
                                    events_processed_total.with_label_values(&["ai-tag-db", "error"]).inc();
                                }
                            }
                        }
                    }
                    None => {
                        ::tracing::info!("Channel closed, processor exiting");
                        if let Some(batch) = accumulator.flush_remaining() {
                            let _ = flush_subroutine(batch, &writer, &events_processed_total, cancel_token.clone()).await;
                        }
                        break;
                    }
                }
            }
        }
    }
}

async fn flush_subroutine(
    batch: Vec<AITagMessage>,
    writer: &Arc<dyn AITagClickHouseWriter>,
    events_processed_total: &IntCounterVec,
    cancel_token: CancellationToken,
) -> bool {
    let batch_len = batch.len() as u64;
    let mut backoff = Duration::from_millis(100);
    let max_backoff = Duration::from_secs(10);

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                ::tracing::warn!("Cancellation requested during AI tag flush, aborting flush");
                return false;
            }
            _ = tokio::time::sleep(Duration::from_millis(0)) => {
                // Ensure we yield before the actual call
            }
        }

        match writer
            .write_batch(batch.clone())
            .await
            .tap_err(|e| ::tracing::error!(error = %e, "AI tag flush failed, retrying..."))
        {
            Ok(_) => {
                events_processed_total
                    .with_label_values(&["ai-tag-db", "success"])
                    .inc_by(batch_len);
                return true;
            }
            Err(_) => {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        return false;
                    }
                    _ = tokio::time::sleep(backoff) => {
                        backoff = std::cmp::min(backoff * 2, max_backoff);
                    }
                }
            }
        }
    }
}
