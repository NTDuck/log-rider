use crate::db_writer::logic::BatchAccumulator;
use crate::db_writer::traits::ClickHouseWriter;
use crate::normalization::models::NormalizedLog;
use prometheus::IntCounterVec;
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::Message;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{interval, sleep};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct DbWriterMetrics {
    pub events_processed_total: IntCounterVec,
}

#[::tracing::instrument(skip_all)]
pub async fn run_fetcher_task(
    consumer: Arc<StreamConsumer>,
    tx: mpsc::Sender<NormalizedLog>,
    metrics: DbWriterMetrics,
    cancel_token: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            res = consumer.recv() => {
                match res {
                    Ok(msg) => {
                        let Some(payload) = msg.payload() else {
                            continue;
                        };
                        match serde_json::from_slice::<NormalizedLog>(payload) {
                            Ok(log) => {
                                if tx.send(log).await.is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                ::tracing::error!(
                                    partition = msg.partition(),
                                    offset = msg.offset(),
                                    error = %e,
                                    "Deserialization failure on a consumed message"
                                );
                                metrics.events_processed_total.with_label_values(&["db_writer", "error"]).inc();
                            }
                        }
                    }
                    Err(e) => {
                        ::tracing::error!(error = %e, "Kafka consumer error");
                        continue;
                    }
                }
            }
        }
    }
}

#[::tracing::instrument(skip_all)]
pub async fn run_processor_task(
    consumer: Arc<StreamConsumer>,
    writer: impl ClickHouseWriter,
    metrics: DbWriterMetrics,
    mut rx: mpsc::Receiver<NormalizedLog>,
    cancel_token: CancellationToken,
) {
    let mut accumulator = BatchAccumulator::new(1000, Duration::from_secs(5));
    let mut tick_interval = interval(Duration::from_secs(5));

    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                if let Some(batch) = accumulator.try_flush_all() {
                    flush_subroutine(&consumer, &writer, &metrics, batch, &cancel_token, &mut accumulator).await;
                }
                break;
            }
            _ = tick_interval.tick() => {
                if let Some(batch) = accumulator.try_flush_by_timer() {
                    flush_subroutine(&consumer, &writer, &metrics, batch, &cancel_token, &mut accumulator).await;
                }
            }
            msg_opt = rx.recv() => {
                match msg_opt {
                    Some(log) => {
                        if let Some(batch) = accumulator.push(log) {
                            flush_subroutine(&consumer, &writer, &metrics, batch, &cancel_token, &mut accumulator).await;
                        }
                    }
                    None => {
                        if let Some(batch) = accumulator.try_flush_all() {
                            flush_subroutine(&consumer, &writer, &metrics, batch, &cancel_token, &mut accumulator).await;
                        }
                        break;
                    }
                }
            }
        }
    }
}

#[::tracing::instrument(skip_all)]
async fn flush_subroutine(
    consumer: &Arc<StreamConsumer>,
    writer: &impl ClickHouseWriter,
    metrics: &DbWriterMetrics,
    batch: Vec<NormalizedLog>,
    cancel_token: &CancellationToken,
    accumulator: &mut BatchAccumulator,
) {
    let mut attempt = 0;
    loop {
        match writer.write_batch(&batch).await {
            Ok(_) => {
                metrics
                    .events_processed_total
                    .with_label_values(&["db_writer", "success"])
                    .inc_by(batch.len() as u64);
                let _ = consumer.commit_consumer_state(CommitMode::Async);
                accumulator.reset_timer();
                ::tracing::info!("Successfully flushed batch to ClickHouse");
                return;
            }
            Err(e) => {
                attempt += 1;
                let delay = std::cmp::min(1000 * (2u64.pow(attempt)), 60000);
                ::tracing::error!(error = %e, delay_ms = delay, "ClickHouse write failed, entering backoff");

                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        return;
                    }
                    _ = sleep(Duration::from_millis(delay)) => {
                        continue;
                    }
                }
            }
        }
    }
}
