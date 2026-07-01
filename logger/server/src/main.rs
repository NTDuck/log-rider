use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Request, State, Query,
    },
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use clap::{Parser, ValueEnum};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use uuid::Uuid;
use futures::{sink::SinkExt, stream::StreamExt};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(short, long, default_value = "all")]
    role: Role,
}

#[derive(ValueEnum, Clone, Debug, PartialEq)]
enum Role {
    Edge,
    WsServer,
    All,
}

#[derive(Clone)]
struct AppState {
    logs_raw_tx: broadcast::Sender<DomainLog>,
    logs_norm_tx: broadcast::Sender<NormalizedLog>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DomainLog {
    log_id: String,
    timestamp: String,
    level: String,
    message: String,
    app_name: String,
    error_code: Option<String>,
    flat_attributes: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NormalizedLog {
    log_id: String,
    timestamp: String,
    level: String,
    message: String,
    app_name: String,
    error_code: Option<String>,
    attribute_keys: Vec<String>,
    attribute_values_string: Vec<String>,
}

async fn auth_middleware(
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Result<impl IntoResponse, StatusCode> {
    let auth_header = headers.get("Authorization").and_then(|h| h.to_str().ok());
    if let Some(auth) = auth_header {
        if auth.starts_with("Bearer ") {
            let token = &auth[7..];
            if let Ok(claims) = serde_json::from_str::<Value>(token) {
                if let Some(grants) = claims.get("app_grants").and_then(|g| g.as_array()) {
                    let mut valid_apps = Vec::new();
                    for g in grants {
                        if let Some(s) = g.as_str() {
                            valid_apps.push(s.to_string());
                        }
                    }
                    request.extensions_mut().insert(valid_apps);
                    return Ok(next.run(request).await);
                }
            }
        }
    }
    Err(StatusCode::UNAUTHORIZED)
}

fn flatten_iterative(val: Value) -> Result<HashMap<String, String>, StatusCode> {
    let mut result = HashMap::new();
    let mut stack = vec![(String::new(), val, 0)];

    while let Some((prefix, current, depth)) = stack.pop() {
        if depth > 5 {
            return Err(StatusCode::BAD_REQUEST);
        }

        match current {
            Value::Object(map) => {
                for (k, v) in map {
                    let new_key = if prefix.is_empty() { k } else { format!("{}.{}", prefix, k) };
                    stack.push((new_key, v, depth + 1));
                }
            }
            Value::Array(arr) => {
                for (i, v) in arr.into_iter().enumerate() {
                    let new_key = format!("{}[{}]", prefix, i);
                    stack.push((new_key, v, depth + 1));
                }
            }
            Value::String(s) => {
                result.insert(prefix, s);
            }
            Value::Number(n) => {
                result.insert(prefix, n.to_string());
            }
            Value::Bool(b) => {
                result.insert(prefix, b.to_string());
            }
            Value::Null => {
                result.insert(prefix, "null".to_string());
            }
        }
    }
    Ok(result)
}

async fn ingest_logs(
    State(state): State<AppState>,
    extensions: axum::extract::Extension<Vec<String>>,
    payload_str: String,
) -> Result<StatusCode, StatusCode> {
    let payload: Value = serde_json::from_str(&payload_str).map_err(|_| StatusCode::BAD_REQUEST)?;

    let app_name = payload.get("app_name").and_then(|a| a.as_str()).ok_or(StatusCode::BAD_REQUEST)?;
    let grants = extensions.0;
    if !grants.contains(&"*".to_string()) && !grants.contains(&app_name.to_string()) {
        return Err(StatusCode::FORBIDDEN);
    }

    let timestamp = payload.get("timestamp").and_then(|a| a.as_str()).unwrap_or("").to_string();
    let level = payload.get("level").and_then(|a| a.as_str()).unwrap_or("").to_string();
    let message = payload.get("message").and_then(|a| a.as_str()).unwrap_or("").to_string();
    let error_code = payload.get("error_code").and_then(|a| a.as_str()).map(|s| s.to_string());

    let mut flat_attrs = HashMap::new();
    if let Some(attributes) = payload.get("attributes").and_then(|a| a.as_array()) {
        for attr in attributes {
            let key = attr.get("key").and_then(|k| k.as_str()).unwrap_or("");
            let val = attr.get("value").unwrap_or(&Value::Null).clone();
            let flattened = flatten_iterative(val)?;
            for (fk, fv) in flattened {
                let final_key = if fk.is_empty() { key.to_string() } else { format!("{}.{}", key, fk) };
                flat_attrs.insert(final_key, fv);
            }
        }
    }

    let domain_log = DomainLog {
        log_id: Uuid::now_v7().to_string(),
        timestamp,
        level,
        message,
        app_name: app_name.to_string(),
        error_code,
        flat_attributes: flat_attrs,
    };

    let _ = state.logs_raw_tx.send(domain_log);

    Ok(StatusCode::ACCEPTED)
}

async fn normalization_worker(mut raw_rx: broadcast::Receiver<DomainLog>, norm_tx: broadcast::Sender<NormalizedLog>) {
    let pii_regex = Regex::new(r"\b\d{4}-\d{4}-\d{4}-\d{4}\b").unwrap();

    while let Ok(domain_log) = raw_rx.recv().await {
        let redacted_msg = pii_regex.replace_all(&domain_log.message, "[REDACTED]").to_string();
        
        let mut attr_keys = Vec::new();
        let mut attr_vals = Vec::new();
        
        for (k, v) in domain_log.flat_attributes {
            attr_keys.push(k);
            let redacted_val = pii_regex.replace_all(&v, "[REDACTED]").to_string();
            attr_vals.push(redacted_val);
        }

        let norm_log = NormalizedLog {
            log_id: domain_log.log_id,
            timestamp: domain_log.timestamp,
            level: domain_log.level,
            message: redacted_msg,
            app_name: domain_log.app_name,
            error_code: domain_log.error_code,
            attribute_keys: attr_keys,
            attribute_values_string: attr_vals,
        };

        let _ = norm_tx.send(norm_log);
    }
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    let mut grants = Vec::new();
    if let Ok(claims) = serde_json::from_str::<Value>(&query.token) {
        if let Some(arr) = claims.get("app_grants").and_then(|g| g.as_array()) {
            for g in arr {
                if let Some(s) = g.as_str() {
                    grants.push(s.to_string());
                }
            }
        }
    }

    if grants.is_empty() {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let rx = state.logs_norm_tx.subscribe();
    ws.on_upgrade(move |socket| handle_socket(socket, rx, grants))
}

async fn handle_socket(socket: WebSocket, mut rx: broadcast::Receiver<NormalizedLog>, grants: Vec<String>) {
    let (mut sender, mut _receiver) = socket.split();
    
    while let Ok(log) = rx.recv().await {
        if grants.contains(&"*".to_string()) || grants.contains(&log.app_name) {
            if let Ok(msg) = serde_json::to_string(&log) {
                if sender.send(WsMessage::Text(msg)).await.is_err() {
                    break;
                }
            }
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    let (logs_raw_tx, _) = broadcast::channel(1000);
    let (logs_norm_tx, _) = broadcast::channel(1000);

    let state = AppState {
        logs_raw_tx: logs_raw_tx.clone(),
        logs_norm_tx: logs_norm_tx.clone(),
    };

    if args.role == Role::Edge || args.role == Role::All {
        let app = Router::new()
            .route("/v1/logs", post(ingest_logs))
            .layer(middleware::from_fn(auth_middleware))
            .with_state(state.clone());
        
        tokio::spawn(normalization_worker(logs_raw_tx.subscribe(), logs_norm_tx.clone()));
        
        let listener = TcpListener::bind("0.0.0.0:3000").await.unwrap();
        println!("Edge Receiver listening on port 3000");
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
    }

    if args.role == Role::WsServer || args.role == Role::All {
        let app = Router::new()
            .route("/v1/stream", get(ws_handler))
            .with_state(state.clone());
            
        let listener = TcpListener::bind("0.0.0.0:3001").await.unwrap();
        println!("WebSocket Viewer listening on port 3001");
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
    }

    // Keep main thread alive
    tokio::signal::ctrl_c().await.unwrap();
}
