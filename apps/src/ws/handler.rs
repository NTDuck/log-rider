use crate::ws::auth::parse_ws_claims;
use crate::ws::filter::should_deliver;
use crate::ws::models::{BroadcastMessage, WsClientConfig};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::DecodingKey;
use prometheus::{IntCounterVec, IntGauge};
use serde::Deserialize;
use std::sync::Arc;
use tap::TapFallible;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AppState {
    pub broadcast_tx: broadcast::Sender<BroadcastMessage>,
    pub decoding_key: Arc<DecodingKey>,
    pub active_connections: IntGauge,
    pub events_processed_total: IntCounterVec,
    pub cancel_token: CancellationToken,
}

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: String,
}

#[::tracing::instrument(skip_all)]
pub async fn ws_upgrade_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Response {
    let config = match parse_ws_claims(&query.token, &state.decoding_key) {
        Ok(c) => c,
        Err(e) => {
            let status = match e {
                crate::ws::models::WSError::InvalidToken => axum::http::StatusCode::UNAUTHORIZED,
                crate::ws::models::WSError::Forbidden => axum::http::StatusCode::FORBIDDEN,
                _ => axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            };
            return (status, e.to_string()).into_response();
        }
    };

    ws.on_upgrade(move |socket| session_loop(socket, config, state))
}

#[::tracing::instrument(skip_all)]
async fn session_loop(socket: WebSocket, config: WsClientConfig, state: AppState) {
    state.active_connections.inc();
    ::tracing::debug!(
        app_count = config.allowed_apps.len(),
        is_admin = config.is_admin,
        "WebSocket session established"
    );

    let (mut sink, mut stream) = socket.split();
    let (egress_tx, mut egress_rx) = mpsc::channel::<String>(256);
    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let cancel_token = state.cancel_token.clone();

    // Task A: Ingress Fetcher
    let ingress_cancel = cancel_token.clone();
    let ingress_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = ingress_cancel.cancelled() => break,
                msg = stream.next() => {
                    match msg {
                        Some(Ok(Message::Close(_))) | None => {
                            ingress_cancel.cancel();
                            break;
                        }
                        Some(Err(e)) => {
                            ::tracing::error!(error = %e, "WebSocket stream error");
                            ingress_cancel.cancel();
                            break;
                        }
                        Some(Ok(_)) => {
                            // Ignore other messages (Ping/Pong handled automatically by axum)
                        }
                    }
                }
            }
        }
    });

    // Task C: Egress Sink
    let events_processed = state.events_processed_total.clone();
    let egress_cancel = cancel_token.clone();
    let egress_task = tokio::spawn(async move {
        while let Some(payload) = egress_rx.recv().await {
            if egress_cancel.is_cancelled() {
                break;
            }
            match sink
                .send(Message::Text(payload.into()))
                .await
                .tap_err(|e| ::tracing::error!(error = %e, "WebSocket send failure"))
            {
                Ok(_) => {
                    events_processed
                        .with_label_values(&["ws_egress", "success"])
                        .inc();
                    ::tracing::debug!("Successful message delivery");
                }
                Err(_) => {
                    events_processed
                        .with_label_values(&["ws_egress", "error"])
                        .inc();
                    egress_cancel.cancel();
                    break;
                }
            }
        }
    });

    // Task B: Processor
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => break,
            msg = broadcast_rx.recv() => {
                match msg {
                    Ok(bmsg) => {
                        if should_deliver(&config, &bmsg) {
                            if let Err(mpsc::error::TrySendError::Full(_)) = egress_tx.try_send(bmsg.payload) {
                                ::tracing::error!("Egress channel full. Client is too slow.");
                                cancel_token.cancel();
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        ::tracing::error!(lag = n, "Client lagged behind broadcast channel");
                        cancel_token.cancel();
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        }
    }

    // Teardown
    drop(egress_tx);
    let _ = tokio::join!(ingress_task, egress_task);

    state.active_connections.dec();
    ::tracing::debug!("WebSocket session terminated");
}
