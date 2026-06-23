# Track 7: Admin API

## Phase 1: The Domain & Contracts

- **Trigger & Topology:** Activated via CLI role flag "--role admin-api". It receives authenticated HTTP POST requests on the path "/v1/admin/config" (JWT authorization required — the token MUST contain an admin role claim). It appends alert configuration records to the ClickHouse "alert_configs" table and publishes configuration-change notifications to a Redis Pub/Sub channel ("admin:config_updates") so that downstream Alert Consumer instances can hot-reload thresholds without restart.

- **Data Schemas:**
  - AlertConfig Model (built with bon builder):
    - config_id: UUID (server-generated via uuid::now_v7)
    - threshold: U64 (number of errors that trigger an alert)
    - window_seconds: U64 (tumbling window duration in seconds)
    - created_at: String (ISO 8601 UTC timestamp, set server-side at insertion time)
  - AdminConfigPayload Model (the inbound JSON body — deserialized by Axum):
    - threshold: U64 (required)
    - window_seconds: U64 (required)
  - AdminError Variants (axiom Erratum enum):
    - Unauthorized: JWT is missing, expired, or does not contain the required admin role claim.
    - InvalidPayload: Request body fails deserialization or contains out-of-range values.
    - WriteFailed: ClickHouse HTTP INSERT to append-only table returned a non-success status.
    - BroadcastFailed: Redis PUBLISH command to the Pub/Sub channel failed.
  - ConfigWriter Boundary Trait (async, Send + Sync):
    - Method: append_config(config: AlertConfig) -> Fallible Result containing success or AdminError.
    - Method: publish_update_event(config: AlertConfig) -> Fallible Result containing success or AdminError.

- **Physical Constraints:**
  - The ClickHouse "alert_configs" table MUST be a plain MergeTree engine. ReplacingMergeTree is strictly forbidden.
  - No UPDATE or DELETE mutations are permitted against this table. Every configuration change is a new appended row. Consumers resolve the active configuration by reading the row with the latest created_at timestamp.
  - The Redis Pub/Sub channel is fire-and-forget. If no Alert Consumer is subscribed at publish time, the notification is lost. This is acceptable because consumers will also read the latest config from ClickHouse on startup.

- **ClickHouse Table Contract (alert_configs):**
  - Engine: MergeTree()
  - Columns: config_id UUID, threshold UInt64, window_seconds UInt64, created_at DateTime64(3, 'UTC')
  - ORDER BY: (created_at)
  - No TTL (configurations are retained indefinitely).

- **Telemetry Contract (Closed-World):**
  - This track may ONLY reference the metric: logger_events_processed_total
  - Labels used: stage="admin", status="success" or status="error"
  - No other metric names are permitted. No invention of logger_admin_config_writes_total, logger_admin_config_errors_total, or any other counter.

## Phase 2: The Behavioral Specification

- **The Gherkin Feature (Admin API Configurations):**

  - Feature: Admin API Alert Configuration Management

  - Scenario 1: Admin successfully updates threshold configuration.
    - Given an Admin user authenticated with a valid JWT containing the admin role claim.
    - And they have prepared a configuration payload with threshold 100 and window_seconds 60.
    - When they submit a POST request to "/v1/admin/config" with the configuration payload.
    - Then the system MUST generate a new config_id and created_at timestamp.
    - And the system MUST append the AlertConfig row to the ClickHouse "alert_configs" MergeTree table.
    - And the system MUST publish the serialized AlertConfig to the Redis Pub/Sub channel "admin:config_updates".
    - And the system MUST respond with HTTP 201 Created.
    - And the metric logger_events_processed_total with labels stage="admin" and status="success" MUST be incremented by 1.

  - Scenario 2: Unauthenticated request is rejected.
    - Given a request with no JWT token or an invalid JWT token.
    - When the request is sent to POST "/v1/admin/config".
    - Then the system MUST respond with HTTP 401 Unauthorized.
    - And the metric logger_events_processed_total with labels stage="admin" and status="error" MUST be incremented by 1.

  - Scenario 3: Request with missing admin claim is rejected.
    - Given a valid JWT that does NOT contain the admin role claim.
    - When the request is sent to POST "/v1/admin/config".
    - Then the system MUST respond with HTTP 401 Unauthorized.
    - And the metric logger_events_processed_total with labels stage="admin" and status="error" MUST be incremented by 1.

  - Scenario 4: ClickHouse write failure is handled gracefully.
    - Given a valid admin JWT and a valid configuration payload.
    - When the ClickHouse INSERT fails (network error, timeout, non-200 response).
    - Then the system MUST respond with HTTP 502 Bad Gateway.
    - And the metric logger_events_processed_total with labels stage="admin" and status="error" MUST be incremented by 1.

  - Scenario 5: Redis publish failure does not block the response.
    - Given a valid admin JWT and a valid configuration payload.
    - And the ClickHouse INSERT succeeds.
    - When the Redis PUBLISH fails.
    - Then the system MUST still respond with HTTP 201 Created (the config is persisted; notification is best-effort).
    - And the metric logger_events_processed_total with labels stage="admin" and status="success" MUST be incremented by 1.
    - And a tracing error span MUST be emitted for the Redis failure.

- **Crucial Directive:** Do not write application code until the step definitions for all five scenarios are scaffolded and failing. The cucumber World struct (AdminWorld) must track: the HTTP response status code, whether append_config was called, whether publish_update_event was called, and whether each succeeded or failed.

## Phase 3: The Execution DAG (The Core Engine)

- **Step 1: Scaffolding & Tests**
  - Define the AdminConfigPayload, AlertConfig, and AdminError models in src/models using bon builders for AlertConfig.
  - Define the ConfigWriter boundary trait in src/admin/mod.rs.
  - Create the cucumber feature file at tests/features/admin_api.feature containing all five scenarios from Phase 2.
  - Scaffold AdminWorld in tests/steps/admin_steps.rs implementing cucumber::World. Fields: response_status (Option U16), config_appended (bool), event_published (bool), last_error (Option String).
  - Write step definitions for all Given/When/Then steps. Steps that invoke the handler MUST use a real Axum test client (axum::Router into tower::ServiceExt) — no mocked HTTP.
  - Run cargo nextest run and confirm all scenarios fail (red).

- **Step 2: Pure Logic**
  - Implement admin JWT claim validation as a standalone function: extract the claims from the JWT, check for the presence of the admin role claim, return Ok(claims) or Err(AdminError::Unauthorized).
  - Implement payload validation: deserialize AdminConfigPayload from the JSON body, validate threshold > 0 and window_seconds > 0, return Ok(payload) or Err(AdminError::InvalidPayload).
  - Implement AlertConfig construction: accept a validated AdminConfigPayload, generate config_id via uuid::now_v7(), set created_at to the current UTC timestamp, return the built AlertConfig.

- **Step 3: Infrastructure Adapters**
  - ClickHouse Config Appender (implements ConfigWriter::append_config):
    - Use the reqwest::Client to send an HTTP POST to the ClickHouse HTTP interface.
    - The SQL statement is a parameterized INSERT INTO alert_configs (config_id, threshold, window_seconds, created_at) VALUES.
    - The append_config method MUST be annotated with #[::tracing::instrument(skip_all)].
    - The reqwest send call MUST use .tap_err(|e| ::tracing::error!(error = %e, "ClickHouse append_config INSERT failed")) BEFORE the ? operator.
    - On success, emit ::tracing::debug!(config_id = %config.config_id, "Config row appended to ClickHouse alert_configs table").
    - On a non-2xx HTTP status from ClickHouse, return Err containing AdminError::WriteFailed.
  - Redis Config Publisher (implements ConfigWriter::publish_update_event):
    - Use the redis::aio::MultiplexedConnection to PUBLISH the JSON-serialized AlertConfig to the channel "admin:config_updates".
    - The publish_update_event method MUST be annotated with #[::tracing::instrument(skip_all)].
    - The Redis PUBLISH call MUST use .tap_err(|e| ::tracing::error!(error = %e, "Redis PUBLISH to admin:config_updates failed")) BEFORE the ? operator.
    - On success, emit ::tracing::debug!(config_id = %config.config_id, channel = "admin:config_updates", "Config update event published to Redis Pub/Sub").

- **Step 4: The Actor Loop (Axum POST Handler)**
  - The handler function MUST be annotated with #[::tracing::instrument(skip_all)].
  - Handler signature accepts: Axum State containing the ConfigWriter implementation and a Prometheus IntCounterVec reference (for logger_events_processed_total), the JWT claims extractor, and axum::Json containing AdminConfigPayload.
  - Execution sequence:
    1. Validate admin JWT claims. On failure, increment logger_events_processed_total with labels stage="admin", status="error", and return HTTP 401.
    2. Validate the AdminConfigPayload fields. On failure, increment logger_events_processed_total with labels stage="admin", status="error", and return HTTP 400.
    3. Construct the AlertConfig from the validated payload.
    4. Call append_config on the ConfigWriter. This call MUST use .tap_err(|e| ::tracing::error!(error = %e, "Admin handler: append_config failed")) BEFORE the ? operator. On failure, increment logger_events_processed_total with labels stage="admin", status="error", and return HTTP 502.
    5. Call publish_update_event on the ConfigWriter. This call MUST use .tap_err(|e| ::tracing::error!(error = %e, "Admin handler: publish_update_event failed")). On failure, log the error but do NOT fail the request — the ClickHouse write already succeeded.
    6. On overall success, increment logger_events_processed_total with labels stage="admin", status="success".
    7. Emit ::tracing::debug!(config_id = %config.config_id, "Admin config update completed successfully").
    8. Return HTTP 201 Created with the config_id in the JSON response body.
  - The handler MUST NOT use .unwrap(), .expect(), panic!(), or todo!() anywhere.
  - All error paths MUST increment the metric and emit a tracing error span BEFORE returning.

## Phase 4: Monolith Integration

- **Wiring Directives (in apps/src/main.rs or the role dispatch block):**
  - When the CLI role flag equals "admin-api":
    1. Initialize the reqwest::Client for ClickHouse HTTP interface using the configured ClickHouse URL.
    2. Initialize the redis::aio::MultiplexedConnection using the configured Redis URL.
    3. Construct the concrete AdminConfigWriter struct that holds both clients and implements the ConfigWriter trait.
    4. Obtain a reference to the already-registered logger_events_processed_total IntCounterVec from the global Prometheus registry (this metric is shared across all tracks — do NOT re-register it; use the existing registration).
    5. Build the Axum Router:
       - Route: POST "/v1/admin/config" -> the admin handler function.
       - State: AdminAppState containing the AdminConfigWriter and the IntCounterVec reference.
    6. Bind the Axum server to "0.0.0.0:8082" using tokio::net::TcpListener.
    7. Spawn the Axum server task. The serve future MUST use .tap_err(|e| ::tracing::error!(error = %e, "Admin API server failed to start")) to capture bind or serve errors.
    8. The spawned task participates in the graceful shutdown mechanism (tokio::select! with the shutdown signal).

- **Metric Registration (Global — NOT track-local):**
  - This track does NOT register any new metrics.
  - It uses the globally registered logger_events_processed_total IntCounterVec (already registered by the monolith bootstrap before role dispatch).
  - The only label combination this track touches: stage="admin", status="success" and stage="admin", status="error".

- **Exit Gate (Track Acceptance Criteria):**
  - cargo fmt --check passes with zero warnings.
  - cargo clippy -- -D warnings passes with zero warnings.
  - cargo nextest run passes — all five admin_api.feature scenarios are green.
  - Zero occurrences of .unwrap(), .expect(), panic!(), todo!(), or unimplemented!() in src/admin/.
  - Zero occurrences of any metric name other than logger_events_processed_total in src/admin/.
  - The ClickHouse alert_configs table DDL uses MergeTree() — NOT ReplacingMergeTree.
  - No UPDATE or DELETE SQL statements appear anywhere in src/admin/.
  - Every async function and the Axum handler carry #[::tracing::instrument(skip_all)].
  - Every fallible I/O call has a .tap_err() with ::tracing::error!() before the ? operator.
  - Every successful I/O completion has a ::tracing::debug!() confirmation.
