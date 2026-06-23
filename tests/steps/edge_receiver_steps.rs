use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use cucumber::{given, then, when, World};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use logger::edge::{
    actors::{ingest_logs, AppState},
    adapters::LogProducer,
    models::{DomainLog, EdgeError},
};
use prometheus::{Counter, IntCounterVec};
use serde::Serialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[derive(Serialize)]
struct JwtClaimsTest {
    sub: String,
    app_grants: Vec<String>,
    exp: u64,
}

#[derive(Clone)]
pub struct MockLogProducer {
    pub log_storage: Arc<Mutex<Option<DomainLog>>>,
}

#[async_trait]
impl LogProducer for MockLogProducer {
    async fn produce(&self, domain_log: &DomainLog) -> Result<(), EdgeError> {
        let mut storage = self.log_storage.lock().await;
        *storage = Some(domain_log.clone());
        Ok(())
    }
}

#[derive(Debug, Default, World)]

pub struct EdgeWorld {
    pub raw_payload: Option<Vec<u8>>,
    pub jwt_token: Option<String>,
    pub response_status: Option<u16>,
    pub produced_domain_log: Option<DomainLog>,
}

const PRIV_KEY: &str = include_str!("../private_key.pem");
const PUB_KEY: &str = include_str!("../public_key.pem");

fn generate_jwt(app_grants: Vec<String>, expired: bool) -> String {
    let exp = if expired {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 3600
    } else {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600
    };

    let claims = JwtClaimsTest {
        sub: "test-user".to_string(),
        app_grants,
        exp,
    };

    let key = EncodingKey::from_rsa_pem(PRIV_KEY.as_bytes()).unwrap();
    encode(&Header::new(Algorithm::RS256), &claims, &key).unwrap()
}

#[given("a valid OTLP JSON payload with nested key-value attributes at depth 3")]
async fn given_valid_payload_depth_3(world: &mut EdgeWorld) {
    let payload = r#"{
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "INFO",
        "message": "Test message",
        "app_name": "test-app",
        "attributes": {
            "depth1": {
                "depth2": {
                    "depth3": "value"
                }
            }
        }
    }"#;
    world.raw_payload = Some(payload.as_bytes().to_vec());
}

#[given("the payload size is under 256KB")]
async fn given_payload_under_256kb(_world: &mut EdgeWorld) {}

#[given("a JWT with app_grants containing the payload's app_name")]
async fn given_jwt_with_app_grants(world: &mut EdgeWorld) {
    world.jwt_token = Some(generate_jwt(vec!["test-app".to_string()], false));
}

#[when("it is POSTed to \"/v1/logs\"")]
async fn when_posted_to_v1_logs(world: &mut EdgeWorld) {
    let payload = world.raw_payload.clone().unwrap_or_default();

    let mock_producer = MockLogProducer {
        log_storage: Arc::new(Mutex::new(None)),
    };

    let ingest_bytes_total = Counter::new("logger_ingest_bytes_total", "Total").unwrap();
    let events_processed_total = IntCounterVec::new(
        prometheus::Opts::new("logger_events_processed_total", "Events"),
        &["stage", "status"],
    )
    .unwrap();

    let state = AppState {
        producer: Arc::new(mock_producer.clone()),
        jwt_public_key: Arc::new(PUB_KEY.as_bytes().to_vec()),
        ingest_bytes_total,
        events_processed_total,
        cancel_token: CancellationToken::new(),
    };

    let router = axum::Router::new()
        .route("/v1/logs", axum::routing::post(ingest_logs))
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
        .with_state(state);

    let mut request_builder = Request::builder().method("POST").uri("/v1/logs");

    if let Some(token) = &world.jwt_token {
        request_builder = request_builder.header("authorization", format!("Bearer {}", token));
    }

    let request = request_builder.body(Body::from(payload)).unwrap();

    let response = router.oneshot(request).await.unwrap();
    world.response_status = Some(response.status().as_u16());

    let stored = mock_producer.log_storage.lock().await.clone();
    world.produced_domain_log = stored;
}

#[then("the Edge Receiver MUST respond with HTTP 202")]
async fn then_respond_202(world: &mut EdgeWorld) {
    assert_eq!(world.response_status, Some(StatusCode::ACCEPTED.as_u16()));
}

#[then(
    "the payload MUST be iteratively parsed, flattened to dot-notation parallel arrays, and produced to \"logs-raw\" as a DomainLog"
)]
async fn then_payload_produced(world: &mut EdgeWorld) {
    let log = world.produced_domain_log.as_ref().unwrap();
    assert_eq!(log.app_name, "test-app");
    assert!(log
        .attribute_keys
        .contains(&"depth1.depth2.depth3".to_string()));
    let idx = log
        .attribute_keys
        .iter()
        .position(|k| k == "depth1.depth2.depth3")
        .unwrap();
    assert_eq!(log.attribute_values_string[idx], "value");
}

#[given("a log payload containing attributes with a nesting depth of 6")]
async fn given_payload_depth_6(world: &mut EdgeWorld) {
    let payload = r#"{
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "INFO",
        "message": "Test message",
        "app_name": "test-app",
        "attributes": { "d1": { "d2": { "d3": { "d4": { "d5": { "d6": "too_deep" } } } } } }
    }"#;
    world.raw_payload = Some(payload.as_bytes().to_vec());
}

#[given("a valid JWT")]
async fn given_valid_jwt(world: &mut EdgeWorld) {
    world.jwt_token = Some(generate_jwt(vec!["test-app".to_string()], false));
}

#[then("the Edge Receiver MUST fail-fast immediately with HTTP 400")]
async fn then_fail_fast_400(world: &mut EdgeWorld) {
    assert_eq!(
        world.response_status,
        Some(StatusCode::BAD_REQUEST.as_u16())
    );
}

#[then("no message MUST be produced to \"logs-raw\"")]
async fn then_no_message_produced(world: &mut EdgeWorld) {
    assert!(world.produced_domain_log.is_none());
}

#[given("a log payload with size exceeding 256KB")]
async fn given_payload_exceeding_256kb(world: &mut EdgeWorld) {
    world.jwt_token = Some(generate_jwt(vec!["test-app".to_string()], false));
    let large_string = "a".repeat(300 * 1024);
    let payload = format!(
        r#"{{"timestamp": "2024-01-01T00:00:00Z", "level": "INFO", "message": "{}", "app_name": "test-app"}}"#,
        large_string
    );
    world.raw_payload = Some(payload.into_bytes());
}

#[when("it is sent to the Edge Receiver")]
async fn when_sent_to_edge_receiver(world: &mut EdgeWorld) {
    when_posted_to_v1_logs(world).await;
}

#[then("it MUST be rejected with HTTP 413 Payload Too Large")]
async fn then_rejected_413(world: &mut EdgeWorld) {
    assert_eq!(
        world.response_status,
        Some(StatusCode::PAYLOAD_TOO_LARGE.as_u16())
    );
}

#[given("a request with no Authorization header (or an expired/malformed JWT)")]
async fn given_no_auth_header(world: &mut EdgeWorld) {
    world.jwt_token = None;
    let payload = r#"{
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "INFO",
        "message": "Test message",
        "app_name": "test-app"
    }"#;
    world.raw_payload = Some(payload.as_bytes().to_vec());
}

#[then("the Edge Receiver MUST respond with HTTP 401 Unauthorized")]
async fn then_respond_401(world: &mut EdgeWorld) {
    assert_eq!(
        world.response_status,
        Some(StatusCode::UNAUTHORIZED.as_u16())
    );
}

#[given("a valid JWT with app_grants containing only \"payment-api\"")]
async fn given_jwt_payment_api(world: &mut EdgeWorld) {
    world.jwt_token = Some(generate_jwt(vec!["payment-api".to_string()], false));
}

#[given("a payload with app_name \"auth-service\"")]
async fn given_payload_auth_service(world: &mut EdgeWorld) {
    let payload = r#"{
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "INFO",
        "message": "Test message",
        "app_name": "auth-service"
    }"#;
    world.raw_payload = Some(payload.as_bytes().to_vec());
}

#[then("the Edge Receiver MUST respond with HTTP 403 Forbidden")]
async fn then_respond_403(world: &mut EdgeWorld) {
    assert_eq!(world.response_status, Some(StatusCode::FORBIDDEN.as_u16()));
}

#[given(
    "a payload with attributes containing nested objects like key \"request\" with value containing key \"headers\" with value containing key \"host\" with leaf value \"example.com\""
)]
async fn given_payload_nested_objects(world: &mut EdgeWorld) {
    world.jwt_token = Some(generate_jwt(vec!["test-app".to_string()], false));
    let payload = r#"{
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "INFO",
        "message": "Test message",
        "app_name": "test-app",
        "attributes": {
            "request": {
                "headers": {
                    "host": "example.com"
                }
            }
        }
    }"#;
    world.raw_payload = Some(payload.as_bytes().to_vec());
}

#[when("it is accepted by the Edge Receiver")]
async fn when_accepted_by_edge_receiver(world: &mut EdgeWorld) {
    when_posted_to_v1_logs(world).await;
}

#[then(
    "the produced DomainLog MUST contain attribute_keys including \"request.headers.host\" and the corresponding attribute_values_string entry MUST be \"example.com\""
)]
async fn then_produced_domainlog_contains_attributes(world: &mut EdgeWorld) {
    let log = world.produced_domain_log.as_ref().unwrap();
    let idx = log
        .attribute_keys
        .iter()
        .position(|k| k == "request.headers.host")
        .unwrap();
    assert_eq!(log.attribute_values_string[idx], "example.com");
}

#[given("a valid JWT with app_grants containing \"*\"")]
async fn given_jwt_wildcard(world: &mut EdgeWorld) {
    world.jwt_token = Some(generate_jwt(vec!["*".to_string()], false));
}

#[given("a payload with any arbitrary app_name")]
async fn given_payload_arbitrary_app_name(world: &mut EdgeWorld) {
    let payload = r#"{
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "INFO",
        "message": "Test message",
        "app_name": "arbitrary-app"
    }"#;
    world.raw_payload = Some(payload.as_bytes().to_vec());
}

#[given(
    "a log payload containing an attribute object with 51 properties, or an array with 251 items, or a key exceeding 255 characters"
)]
async fn given_payload_exceeding_memory_limits(world: &mut EdgeWorld) {
    world.jwt_token = Some(generate_jwt(vec!["test-app".to_string()], false));
    let mut large_object = String::new();
    for i in 0..51 {
        large_object.push_str(&format!("\"k{}\": \"v\"", i));
        if i < 50 {
            large_object.push_str(", ");
        }
    }

    let payload = format!(
        r#"{{
        "timestamp": "2024-01-01T00:00:00Z",
        "level": "INFO",
        "message": "Test message",
        "app_name": "test-app",
        "attributes": {{ {} }}
    }}"#,
        large_object
    );
    world.raw_payload = Some(payload.as_bytes().to_vec());
}
