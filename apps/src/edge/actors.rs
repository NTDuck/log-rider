use crate::edge::adapters::LogProducer;
use crate::edge::logic::{check_app_grant, parse_and_validate_log, validate_jwt};
use crate::edge::models::EdgeError;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use prometheus::{Counter, IntCounterVec};
use std::sync::Arc;
use tap::TapFallible;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AppState {
    pub producer: Arc<dyn LogProducer>,
    pub jwt_public_key: Arc<Vec<u8>>,
    pub ingest_bytes_total: Counter,
    pub events_processed_total: IntCounterVec,
    pub cancel_token: CancellationToken,
}

impl IntoResponse for EdgeError {
    fn into_response(self) -> Response {
        let status = match self {
            EdgeError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            EdgeError::Forbidden => StatusCode::FORBIDDEN,
            EdgeError::BadRequest(_) => StatusCode::BAD_REQUEST,
            EdgeError::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            EdgeError::KafkaProduceError(_) => StatusCode::BAD_GATEWAY,
        };
        (status, self.to_string()).into_response()
    }
}

#[::tracing::instrument(skip_all)]
pub async fn ingest_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    req: Request,
) -> Result<impl IntoResponse, EdgeError> {
    // 1. Slowloris defense: Apply strict timeout directly at the socket stream-reading phase
    // (This enforces the tower::timeout::TimeoutLayer intent directly at the extraction point)
    let body_bytes = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        axum::body::to_bytes(req.into_body(), 256 * 1024),
    )
    .await
    .tap_err(|e| ::tracing::error!(error = %e, "Timeout reading body stream"))
    .map_err(|_| EdgeError::BadRequest("Timeout".into()))?
    .map_err(|e| {
        if e.to_string().contains("limit") {
            EdgeError::PayloadTooLarge
        } else {
            EdgeError::BadRequest("Failed to read body".into())
        }
    })?;

    // 2. Telemetry: Byte counting unconditionally after socket extraction
    state.ingest_bytes_total.inc_by(body_bytes.len() as f64);

    let result = async {
        // 3. JWT Auth
        let auth_header = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .ok_or_else(|| EdgeError::Unauthorized("Missing token".into()))?;

        let claims = validate_jwt(auth_header, &state.jwt_public_key)?;

        // 4. Streaming Deserialization & Validation
        let domain_log = parse_and_validate_log(&body_bytes)?;

        // 5. Grant check
        check_app_grant(&claims, &domain_log.app_name)?;

        // 6. Cancellation-Safe Kafka Production
        let producer = state.producer.clone();
        let cancel_token = state.cancel_token.clone();

        // Spawn tokio task so it cannot be cancelled mid-flight by client disconnects
        tokio::spawn(async move {
            let mut attempt = 0;
            loop {
                if cancel_token.is_cancelled() {
                    return Err(EdgeError::KafkaProduceError("Cancelled".into()));
                }

                match producer.produce(&domain_log).await {
                    Ok(_) => break Ok(()),
                    Err(e) => {
                        if attempt < 3 {
                            attempt += 1;
                            tokio::select! {
                                _ = cancel_token.cancelled() => return Err(EdgeError::KafkaProduceError("Cancelled".into())),
                                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                            }
                            continue;
                        }
                        break Err(e);
                    }
                }
            }
        })
        .await
        .tap_err(|e| ::tracing::error!(error = %e, "Produce task panicked"))
        .map_err(|_| EdgeError::KafkaProduceError("Task panicked".into()))??;

        ::tracing::debug!("Edge ingestion succeeded");

        Ok::<_, EdgeError>(())
    }
    .await;

    // 7. Terminal Telemetry Gate: Increment exactly once, outside of retry loops, after completion
    match result {
        Ok(_) => {
            state
                .events_processed_total
                .with_label_values(&["edge", "success"])
                .inc();
            Ok(StatusCode::ACCEPTED)
        }
        Err(e) => {
            state
                .events_processed_total
                .with_label_values(&["edge", "error"])
                .inc();
            Err(e)
        }
    }
}
