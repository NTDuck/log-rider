use crate::admin::logic::{build_alert_config, validate_admin_claims, validate_payload};
use crate::admin::models::{AdminConfigPayload, ConfigWriter};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::DecodingKey;
use prometheus::IntCounterVec;
use std::sync::Arc;
use tap::TapFallible;

#[derive(Clone)]
pub struct AdminAppState {
    pub writer: Arc<dyn ConfigWriter>,
    pub events_processed_total: IntCounterVec,
    pub decoding_key: Arc<DecodingKey>,
}

#[::tracing::instrument(skip_all)]
pub async fn admin_config_handler(
    State(state): State<AdminAppState>,
    headers: HeaderMap,
    Json(payload): Json<AdminConfigPayload>,
) -> Response {
    let auth_header = headers.get("Authorization").and_then(|h| h.to_str().ok());
    let token = if let Some(h) = auth_header {
        h.strip_prefix("Bearer ").unwrap_or(h)
    } else {
        ""
    };

    if validate_admin_claims(token, &state.decoding_key).is_err() {
        state
            .events_processed_total
            .with_label_values(&["admin", "error"])
            .inc();
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let payload = match validate_payload(payload) {
        Ok(p) => p,
        Err(_) => {
            state
                .events_processed_total
                .with_label_values(&["admin", "error"])
                .inc();
            return (StatusCode::BAD_REQUEST, "Invalid Payload").into_response();
        }
    };

    let config = build_alert_config(payload);

    if let Err(e) = state
        .writer
        .append_config(config.clone())
        .await
        .tap_err(|e| ::tracing::error!(error = %e, "Admin handler: append_config failed"))
    {
        state
            .events_processed_total
            .with_label_values(&["admin", "error"])
            .inc();
        return (StatusCode::BAD_GATEWAY, e.to_string()).into_response();
    }

    if state
        .writer
        .publish_update_event(config.clone())
        .await
        .tap_err(|e| ::tracing::error!(error = %e, "Admin handler: publish_update_event failed"))
        .is_err()
    {
        // Redis publish failure does not block the response
        ::tracing::warn!("Redis publish failed but ClickHouse write succeeded");
    }

    state
        .events_processed_total
        .with_label_values(&["admin", "success"])
        .inc();

    ::tracing::debug!(config_id = %config.config_id, "Admin config update completed successfully");

    (
        StatusCode::CREATED,
        axum::Json(serde_json::json!({ "config_id": config.config_id })),
    )
        .into_response()
}
