# Track 6: WebSocket Server

## Phase 1: The Domain & Contracts

- **Trigger & Topology:** Activated via CLI role flag "--role ws-server". It consumes from the Redpanda topic "logs-normalized" and broadcasts normalized log messages to connected WebSocket viewer clients in real-time. It does NOT query any database. All filtering happens purely in-memory against JWT claims.
- **Data Schemas:**
  - WsClientConfig Model (built with bon builder):
    - allowed_apps: Vector of strings. Extracted from JWT "app_grants" claim.
    - is_admin: Boolean. Set to true if and only if the "app_grants" array contains the single string "*".
  - BroadcastMessage Model (built with bon builder):
    - app_name: String. The application name from the normalized log.
    - payload: String. The serialized normalized log JSON to forward to the client.
  - WSError Variants (derives axiom Erratum):
    - InvalidToken: JWT signature verification failed or claims are malformed. Maps to HTTP 401 on handshake.
    - Forbidden: JWT is valid but contains no app_grants. Maps to HTTP 403 on handshake.
    - ConnectionDropped: The client TCP connection was reset or closed unexpectedly.
    - LaggingClient: The client's broadcast receiver fell behind the bounded channel capacity, causing a tokio broadcast RecvError Lagged event.
    - SendFailure: An individual WebSocket frame send returned an error from the underlying tungstenite transport.
    - SendTimeout: A WebSocket frame send exceeded the 5-second timeout, indicating a slow client blocking the broadcast channel.
    - ConsumerError: The rdkafka StreamConsumer returned an error during message polling.
  - LogConsumer Boundary Trait:
    - Method: stream() -> Fallible async stream of normalized log messages, or a vector of WSError.
- **Physical Constraints:**
  - Broadcast Consumer Pattern: A single ingestion task consumes from "logs-normalized" and pushes into a shared bounded tokio sync broadcast channel. Client session tasks subscribe to this channel. No client session ever touches Kafka directly.
  - Bounded memory channel capacity MUST be exactly 1024: tokio sync broadcast channel with capacity 1024.
  - Zero database queries: No ClickHouse or Redis calls at any point during the WebSocket lifecycle (handshake, streaming, or teardown).
  - Stateless RBAC: JWT tokens are validated entirely in-memory using shared public keys. No database or network call is permitted for authorization.

## Phase 2: The Behavioral Specification

- **The Gherkin Feature (WebSocket Viewer):**

  - Feature: WebSocket Real-Time Log Streaming with RBAC

  - Scenario 1: Authorized client receives only permitted application logs.
    - Given a client requests a WebSocket upgrade passing a cryptographically valid JWT in the handshake query parameter containing app_grants: ["payment-api", "user-service"].
    - And the ingestion loop is consuming logs from "logs-normalized" for applications "payment-api", "auth-service", and "user-service".
    - When logs flow through the broadcast channel.
    - Then the client MUST receive logs only for "payment-api" and "user-service".
    - And the client MUST NOT receive any logs for "auth-service".

  - Scenario 2: Admin wildcard client receives all logs.
    - Given an admin client connects with a JWT containing app_grants: ["*"].
    - When logs for any application flow through the broadcast channel.
    - Then the client MUST receive all logs regardless of app_name.

  - Scenario 3: Invalid token is rejected at handshake.
    - Given a client requests a WebSocket upgrade with an expired or cryptographically invalid JWT.
    - When the handshake is attempted.
    - Then the server MUST reject the upgrade with HTTP 401 Unauthorized.
    - And no WebSocket session MUST be spawned.

  - Scenario 4: Lagging client is disconnected gracefully.
    - Given a connected client stops reading messages.
    - When the broadcast channel reports a Lagged error for that client's receiver.
    - Then the server MUST close the WebSocket connection for that client.

  - Scenario 5: Slow client (Head-of-Line blocker) is disconnected gracefully.
    - Given a connected client's TCP buffer is full and a frame send blocks for more than 5 seconds.
    - When the server attempts to send a message.
    - Then the server MUST timeout the send operation.
    - And MUST close the WebSocket connection for that client.

- **Crucial Directive:** Do not write application code until the step definitions for all five scenarios above are scaffolded in tests/features/websocket.feature and the corresponding step definitions in tests/steps/websocket_steps.rs are compiling and failing.

- **BDD World Struct:**
  - WSWorld:
    - client_grants: Vector of strings. The app_grants extracted from the test JWT.
    - broadcast_tx: Option of tokio sync broadcast Sender of BroadcastMessage. Injected during test setup.
    - received_logs: Vector of strings. Accumulated payloads received during the test scenario.
    - connection_result: Option of Result. Captures handshake outcome for assertion.

## Phase 3: The Execution DAG (The Core Engine)

- **Step 1: Scaffolding & Tests**
  - Create the file tests/features/websocket.feature containing all five Gherkin scenarios from Phase 2.
  - Create the file tests/steps/websocket_steps.rs implementing WSWorld with cucumber World derive and Default derive. Scaffold all Given/When/Then step functions as empty bodies that compile but fail assertions.
  - Create src/ws/mod.rs exporting the submodules: models, auth, filter, handler, ingestion.
  - Create src/ws/models.rs defining the WsClientConfig, BroadcastMessage, and WSError types using bon Builder and axiom Erratum as described in Phase 1. No raw Rust code blocks — these are logical instructions for the implementer.
  - Run "cargo nextest run" and verify all five scenarios fail (red phase).

- **Step 2: Pure Logic (Zero I/O)**
  - Create src/ws/auth.rs:
    - Implement a function "parse_ws_claims" that accepts a raw JWT string and a shared public key reference, and returns a Fallible Result of WsClientConfig or WSError.
    - The function MUST decode the JWT using the jsonwebtoken crate, extracting the "app_grants" claim as a Vector of strings.
    - If "app_grants" contains exactly one element equal to "*", set is_admin to true and set allowed_apps to an empty vector.
    - If the token is expired or the signature is invalid, return WSError InvalidToken.
    - If "app_grants" is empty or missing, return WSError Forbidden.
    - This function performs zero I/O — it is a pure in-memory computation.

  - Create src/ws/filter.rs:
    - Implement a function "should_deliver" that accepts a reference to WsClientConfig and a reference to a BroadcastMessage, returning a boolean.
    - If is_admin is true, return true unconditionally.
    - Otherwise, return true if and only if the BroadcastMessage app_name is contained in the WsClientConfig allowed_apps vector.
    - This function performs zero I/O — it is a pure predicate.

- **Step 3: Infrastructure Adapters**
  - Create src/ws/handler.rs containing the Axum WebSocket upgrade handler:
    - The handler function MUST accept an Axum WebSocketUpgrade extractor, an Axum State extractor carrying the shared application state (broadcast sender, JWT public key, Prometheus metrics, and a tokio_util::sync::CancellationToken), and an Axum Query extractor to read the "token" query parameter.
    - Before upgrading, call parse_ws_claims on the token. If it returns an error, return the corresponding HTTP status code (401 for InvalidToken, 403 for Forbidden) immediately WITHOUT upgrading the WebSocket. Use tap_err to trace the rejection before returning.
    - On successful validation, call ws.on_upgrade() passing a closure that invokes the session_loop.
    - The handler function MUST be annotated with #[::tracing::instrument(skip_all)].

  - The session_loop function (also in src/ws/handler.rs):
    - MUST accept the WebSocket stream, client config, broadcast Receiver, and a CancellationToken.
    - MUST be annotated with #[::tracing::instrument(skip_all)].
    - On entry, increment logger_active_connections gauge by 1. Emit ::tracing::debug!(app_count = config.allowed_apps.len(), is_admin = config.is_admin, "WebSocket session established").
    - Enter a `tokio::select!` loop with three branches:
      - Branch 1 — Cancellation: `cancel_token.cancelled()`. On trigger, send a close frame to the client and break the loop.
      - Branch 2 — Broadcast Receive: Await the next message from the broadcast Receiver.
        - On Ok(msg): Call should_deliver with the client config and the message. If true, serialize the payload and send it over the WebSocket sink. This `ws.send().await` call MUST be wrapped in `tokio::time::timeout(std::time::Duration::from_secs(5), ...)`. If the timeout triggers, emit `::tracing::error!("WebSocket send timed out")`, the server MUST sever the WebSocket connection (break the loop) to prevent Head-of-Line blocking on the broadcast receiver. On successful send, emit ::tracing::debug!(app_name = %msg.app_name, "Message delivered to client"). On send failure (not timeout), call .tap_err(|e| ::tracing::error!(error = %e, "WebSocket send failed")) BEFORE propagating the error, then break the loop.
        - On Err(Lagged(n)): Emit ::tracing::error!(skipped = n, "Client lagging behind broadcast channel"). Send a close frame to the client. Break the loop.
        - On Err(Closed): The broadcast channel has been dropped. Break the loop cleanly.
      - Branch 3 — Client Message / Close Detection: Await the next incoming WebSocket message from the client. If the client sends a Close frame or the stream returns None (connection dropped), break the loop.
    - Do NOT increment `logger_events_processed_total` inside the session loop. Telemetry must be decoupled from the fan-out multiplier.
    - On exit (after the loop), decrement logger_active_connections gauge by 1. Emit ::tracing::debug!("WebSocket session terminated").

- **Step 4: The Ingestion Loop**
  - Create src/ws/ingestion.rs:
    - Implement the function "ingestion_loop" that accepts a KafkaLogConsumer (the concrete rdkafka StreamConsumer adapter from src/adapters), a clone of the broadcast Sender, and a `tokio_util::sync::CancellationToken`.
    - This function MUST be annotated with #[::tracing::instrument(skip_all)].
    - Enter an infinite `tokio::select!` loop:
      - Branch 1 — Cancellation: `cancel_token.cancelled()`. On trigger, break the loop and return gracefully.
      - Branch 2 — Consumer Stream: Consume messages from "logs-normalized" via the StreamConsumer message stream.
        - For each consumed message:
          - Deserialize the Kafka message payload bytes into a BroadcastMessage (extracting app_name and keeping the raw JSON payload as a string).
          - If deserialization fails, call .tap_err(|e| ::tracing::error!(error = %e, "Failed to deserialize normalized log for broadcast")), increment `logger_events_processed_total` with status "error", and skip (continue the loop). Do NOT route to DLQ from this consumer.
          - Call broadcast_tx.send(msg). If the send returns an error (meaning zero active receivers), this is not a failure — call ::tracing::debug!("Broadcast send skipped, no active receivers").
          - Increment `logger_events_processed_total` with stage "ws" and status "success" EXACTLY ONCE per consumed message (not per connected client), OUTSIDE of any fan-out loops. Count the message consumed, not the delivery attempts.
          - Commit the consumer offset only AFTER processing. Use .tap_err(|e| ::tracing::error!(error = %e, "Kafka offset commit failed")) on the commit call before any ? operator.
        - If the Kafka consumer stream itself yields a fatal error, call .tap_err(|e| ::tracing::error!(error = %e, "Kafka consumer stream error in WS ingestion loop")) and return the error to the caller.

  - **Telemetry Completeness Checklist (Closed-World Enforcement):**
    - logger_active_connections: Incremented by 1 on session start, decremented by 1 on session end. This is a Gauge.
    - logger_events_processed_total: Incremented exactly once per consumed message in the ingestion loop, NOT per WebSocket delivery. Status "success" on valid deserialization/broadcast, status "error" on deserialization failure.
    - NO other metrics are permitted. Do NOT invent logger_ws_connections_active, logger_ws_dropped_total, logger_ws_messages_total, or any other metric name.

  - **Observability Completeness Checklist (Boundary Enforcement):**
    - #[::tracing::instrument(skip_all)] on: handler function, session_loop function, ingestion_loop function.
    - .tap_err(|e| ::tracing::error!(...)) BEFORE ? on: WebSocket send, Kafka offset commit, Kafka consumer stream error, JWT parse failure during handshake.
    - ::tracing::debug!(...) on: successful handshake (session established), successful message delivery, broadcast send with no receivers, session termination.

## Phase 4: Monolith Integration

- **Wiring Directives (in apps/src/main.rs, inside the "--role ws-server" branch):**
  1. Create the bounded broadcast channel: Call tokio sync broadcast channel with capacity 1024, yielding (broadcast_tx, _rx). The _rx is immediately dropped; each session creates its own receiver via subscribe().
  2. Instantiate the KafkaLogConsumer adapter from src/adapters with the configured Kafka brokers, subscribing to topic "logs-normalized". To prevent Topology Paralysis and ensure all WS pods receive all messages, generate a unique consumer group per process (e.g., `format!("ws-server-cg-{}", uuid::Uuid::new_v4())`).
  3. Register metrics to the Prometheus default registry:
     - Register an IntGauge named "logger_active_connections" with help text "Number of active WebSocket connections".
     - Register an IntCounterVec named "logger_events_processed_total" with label names ["stage", "status"] and help text "Total events processed". (This counter is shared across tracks; register only if not already registered. Use register or silent fallback on AlreadyReg error.)
  4. Build the shared application state struct containing: broadcast_tx clone, JWT public key, logger_active_connections gauge clone, logger_events_processed_total counter vec clone, and a `tokio_util::sync::CancellationToken`.
  5. Build the Axum Router:
     - Route GET "/v1/ws" to the WebSocket upgrade handler from src/ws/handler.
     - Route GET "/metrics" to the Prometheus text encoder handler (shared exposition endpoint).
     - Attach the shared application state via .with_state().
  6. Spawn the ingestion loop as a background tokio task: tokio spawn the ingestion_loop function, passing the KafkaLogConsumer, the broadcast_tx clone, and the `CancellationToken`. Wrap the spawn in a match/tap_err to log fatal ingestion loop exits via ::tracing::error!(error = %e, "WS ingestion loop terminated").
  7. Bind and serve the Axum listener:
     - Use tokio net TcpListener bind on the configured address (default "0.0.0.0:8081").
     - Call axum serve with the TcpListener and the router, using .with_graceful_shutdown() wired to a tokio signal ctrl_c handler.
     - Use .tap_err(|e| ::tracing::error!(error = %e, "WS Axum server bind failed")) before any error propagation.

- **Graceful Shutdown Mechanics:**
  - On SIGINT/ctrl_c, the Axum server's `.with_graceful_shutdown()` stops accepting new connections.
  - Additionally, trigger the `CancellationToken` to cancel all running tasks gracefully.
  - The `session_loop` instances select on the cancellation token, sending close frames to clients and returning.
  - The `ingestion_loop` selects on the cancellation token and returns cleanly.
  - Drop the broadcast_tx sender.
  - All spawned tasks drain naturally.

- **Track Exit Gate (Acceptance Criteria):**
  - "cargo fmt --check" passes with zero formatting violations.
  - "cargo clippy -- -D warnings" passes with zero warnings.
  - "cargo nextest run" passes all five WebSocket BDD scenarios.
  - Zero occurrences of .unwrap(), .expect(), unreachable!(), panic!(), todo!(), or unimplemented!() in any file under src/ws/.
  - Zero occurrences of std sync Mutex in any file under src/ws/.
  - The broadcast channel capacity is verified to be exactly 1024 (grep for "broadcast::channel(1024)").
  - No database client imports or calls exist in any file under src/ws/.
  - The only metric names referenced are logger_active_connections and logger_events_processed_total. Grep for "logger_" in src/ws/ confirms zero hallucinated metric names.
  - Every async function in src/ws/ is annotated with #[::tracing::instrument(skip_all)].
  - Every fallible I/O call in src/ws/ has a .tap_err() call preceding the ? operator.
  - The `ws.send().await` call is strictly wrapped in `tokio::time::timeout(std::time::Duration::from_secs(5), ...)`.
  - Telemetry is mathematically decoupled from the WebSocket fan-out loop.
