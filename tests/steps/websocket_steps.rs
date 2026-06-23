use cucumber::{given, then, when, World};
// use logger::ws::models::BroadcastMessage;

#[derive(Debug, Default, World)]
pub struct WSWorld {
    pub client_grants: Vec<String>,
    // pub broadcast_tx: Option<tokio::sync::broadcast::Sender<BroadcastMessage>>,
    pub received_logs: Vec<String>,
    pub connection_result: Option<Result<(), u16>>, // e.g. status code on fail
}

#[given(
    regex = r#"^a client requests a WebSocket upgrade passing a cryptographically valid JWT in the handshake query parameter containing app_grants: \["(.*)", "(.*)"\]\.$"#
)]
async fn a_client_requests_a_websocket_upgrade_passing_a_cryptographically_valid_jwt_in_the_handshake_query_parameter_containing_app_grants(
    _w: &mut WSWorld,
    _app1: String,
    _app2: String,
) {
    panic!("pending");
}

#[given(
    regex = r#"^the ingestion loop is consuming logs from "logs-normalized" for applications "(.*)", "(.*)", and "(.*)"\.$"#
)]
async fn the_ingestion_loop_is_consuming_logs_from_logs_normalized_for_applications(
    _w: &mut WSWorld,
    _app1: String,
    _app2: String,
    _app3: String,
) {
    panic!("pending");
}

#[when(expr = "logs flow through the broadcast channel.")]
async fn logs_flow_through_the_broadcast_channel(_w: &mut WSWorld) {
    panic!("pending");
}

#[then(regex = r#"^the client MUST receive logs only for "(.*)" and "(.*)"\.$"#)]
async fn the_client_must_receive_logs_only_for_app_and_app(
    _w: &mut WSWorld,
    _app1: String,
    _app2: String,
) {
    panic!("pending");
}

#[then(regex = r#"^the client MUST NOT receive any logs for "(.*)"\.$"#)]
async fn the_client_must_not_receive_any_logs_for_app(_w: &mut WSWorld, _app: String) {
    panic!("pending");
}

#[given(regex = r#"^an admin client connects with a JWT containing app_grants: \["\*"\]\.$"#)]
async fn an_admin_client_connects_with_a_jwt_containing_app_grants_star(_w: &mut WSWorld) {
    panic!("pending");
}

#[when(expr = "logs for any application flow through the broadcast channel.")]
async fn logs_for_any_application_flow_through_the_broadcast_channel(_w: &mut WSWorld) {
    panic!("pending");
}

#[then(expr = "the client MUST receive all logs regardless of app_name.")]
async fn the_client_must_receive_all_logs_regardless_of_app_name(_w: &mut WSWorld) {
    panic!("pending");
}

#[given(
    expr = "a client requests a WebSocket upgrade with an expired or cryptographically invalid JWT."
)]
async fn a_client_requests_a_websocket_upgrade_with_an_expired_or_cryptographically_invalid_jwt(
    _w: &mut WSWorld,
) {
    panic!("pending");
}

#[when(expr = "the handshake is attempted.")]
async fn the_handshake_is_attempted(_w: &mut WSWorld) {
    panic!("pending");
}

#[then(expr = "the server MUST reject the upgrade with HTTP 401 Unauthorized.")]
async fn the_server_must_reject_the_upgrade_with_http_401_unauthorized(_w: &mut WSWorld) {
    panic!("pending");
}

#[then(expr = "no WebSocket session MUST be spawned.")]
async fn no_websocket_session_must_be_spawned(_w: &mut WSWorld) {
    panic!("pending");
}

#[given(expr = "a connected client stops reading messages.")]
async fn a_connected_client_stops_reading_messages(_w: &mut WSWorld) {
    panic!("pending");
}

#[when(expr = "the broadcast channel reports a Lagged error for that client's receiver.")]
async fn the_broadcast_channel_reports_a_lagged_error_for_that_client_s_receiver(_w: &mut WSWorld) {
    panic!("pending");
}

#[then(expr = "the server MUST close the WebSocket connection for that client.")]
async fn the_server_must_close_the_websocket_connection_for_that_client(_w: &mut WSWorld) {
    panic!("pending");
}

#[given(expr = "a connected client's egress channel fills up because the client is slow.")]
async fn a_connected_client_s_egress_channel_fills_up_because_the_client_is_slow(_w: &mut WSWorld) {
    panic!("pending");
}

#[when(expr = "the server attempts to enqueue a message into the egress channel.")]
async fn the_server_attempts_to_enqueue_a_message_into_the_egress_channel(_w: &mut WSWorld) {
    panic!("pending");
}

#[then(expr = "the server MUST drop the egress sender.")]
async fn the_server_must_drop_the_egress_sender(_w: &mut WSWorld) {
    panic!("pending");
}
