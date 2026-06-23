# Track 7: Admin API

## Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role admin-api". It receives POST updates on "/v1/admin/config" (JWT authorization required). It appends config updates to ClickHouse table "alert_configs" and publishes notifications via Redis Pub/Sub.
- **Data Schemas:**
  - Input payload: AlertConfig model (config_id, threshold, window_seconds, created_at).
  - AdminError Variants:
    - Unauthorized: Missing admin claim in JWT token.
    - WriteFailed: ClickHouse analytical write failures.
    - BroadcastFailed: Redis Pub/Sub publishing failures.
  - ConfigWriter Boundary Trait:
    - Method: append_config(config: AlertConfig) -> Fallible Result containing success or AdminError.
    - Method: publish_update_event(config: AlertConfig) -> Fallible Result.
- **Physical Constraints:**
  - ReplacingMergeTree or mutable updates inside ClickHouse analytical store are forbidden. The config table must be strictly append-only MergeTree.

## Phase 2: The Behavioral Specification
- **The Gherkin Feature (Admin API Configurations):**
  - Scenario 1: Admin updates threshold configuration.
    - Given an Admin user authenticated with JWT.
    - When they submit a new alert configuration.
    - Then the system MUST append the config to the MergeTree table.
    - And publish an update event via Redis Pub/Sub.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

## Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup AdminWorld cucumber features.
- **Step 2: Pure Logic:** Implement admin JWT claim checking.
- **Step 3: Infrastructure Adapters:** Connect reqwest HTTP client to execute ClickHouse config writes. Build Redis client for PubSub.
- **Step 4: The Actor Loop:** Implement the Axum POST handler orchestrating config updates.
  - Telemetry Bypass Prevention: Suffix append_config and publish_update_event calls with tap error hooks logging errors and incrementing logger_admin_config_errors_total to prevent silent failure returns. Suffix success with logger_admin_config_writes_total increments.

## Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate AdminConfigWriter client.
  - Setup Axum Router on "/v1/admin/config" pointing to handler.
  - Register metrics logger_admin_config_writes_total and logger_admin_config_errors_total.
  - Spawn Admin API server task when role is admin-api.
