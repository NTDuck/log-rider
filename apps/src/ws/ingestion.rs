use crate::normalization::models::NormalizedLog;
use crate::ws::models::BroadcastMessage;
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::Message;
use std::sync::Arc;
use tap::TapFallible;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

#[::tracing::instrument(skip_all)]
pub async fn ingestion_loop(
    consumer: Arc<StreamConsumer>,
    broadcast_tx: broadcast::Sender<BroadcastMessage>,
    cancel_token: CancellationToken,
) -> Result<(), crate::ws::models::WSError> {
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            msg = consumer.recv() => {
                match msg.tap_err(|e| ::tracing::error!(error = %e, "Kafka consumer stream error in WS ingestion loop")) {
                    Ok(m) => {
                        if let Some(payload_bytes) = m.payload() {
                            match serde_json::from_slice::<NormalizedLog>(payload_bytes) {
                                Ok(log) => {
                                    let raw_payload = String::from_utf8_lossy(payload_bytes).into_owned();
                                    let bmsg = BroadcastMessage::builder()
                                        .app_name(log.app_name)
                                        .payload(raw_payload)
                                        .build();

                                    if let Err(_) = broadcast_tx.send(bmsg) {
                                        ::tracing::debug!("Broadcast send skipped, no active receivers");
                                    }
                                }
                                Err(e) => {
                                    let _ = Err::<(), _>(e).tap_err(|e| ::tracing::error!(error = %e, "Failed to deserialize normalized log for broadcast"));
                                }
                            }
                        }

                        let _ = consumer.commit_message(&m, rdkafka::consumer::CommitMode::Async)
                            .tap_err(|e| ::tracing::error!(error = %e, "Kafka offset commit failed"));
                    }
                    Err(e) => {
                        return Err(crate::ws::models::WSError::ConsumerError(e.to_string()));
                    }
                }
            }
        }
    }
    Ok(())
}
