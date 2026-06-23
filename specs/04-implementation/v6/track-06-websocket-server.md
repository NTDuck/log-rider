# Track 6: WebSocket Server

## Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via CLI role flag "--role ws-server". It consumes from the Redpanda topic "logs-normalized" and broadcasts logs to connected WebSocket viewer clients.
- **Data Schemas:**
  - WsClientConfig Model:
    - allowed_apps: Vector of strings
    - is_admin: Boolean (True if wildcard grant is found)
  - WSError Variants:
    - InvalidToken: Handshake JWT validation failures.
    - ConnectionDropped: Network disconnect from client side.
    - LaggingClient: WS client lagging behind broadcast channel.
    - ConsumerError: Kafka stream consumer failures.
- **Physical Constraints:**
  - Broadcast Consumer Pattern: Ingestion loop must produce logs to a shared bounded memory channel.
  - Client sessions must pull from memory channels. No database queries during streaming.
  - Bounded memory channel must use capacity limit (max 1024) to enforce backpressure.

## Phase 2: The Behavioral Specification
- **The Gherkin Feature (WebSocket Viewer):**
  - Scenario 1: Client receives authorized logs.
    - Given a client requests a WebSocket connection passing a cryptographically valid JWT containing app_grants: ["payment-api"].
    - When logs flow through logs-normalized.
    - Then the client MUST receive logs only for payment-api.
  - Scenario 2: Admin client receives all logs.
    - Given an admin client connects with app_grants: ["*"].
    - Then the client MUST receive all logs.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

## Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Setup WSWorld BDD testing.
- **Step 2: Pure Logic:** Implement JWT claim parser and app grant filter.
- **Step 3: Infrastructure Adapters:** Connect Axum WebSocket framework handler.
- **Step 4: The Event Loops:**
  - Ingestion Loop: Consumes from logs-normalized, pushing logs to a bounded broadcast channel: tokio::sync::broadcast::channel(1024).
  - Session Loops: Run one thread per socket client, subscribing to broadcast channel, matching against AllowedApps, and pushing over WebSocket.
  - Telemetry Bypass Prevention: Handshake and message loop failures must trigger logger_ws_dropped_total increments via tap error or exhaustive match statements. Suffix sessions with logger_ws_connections_active tracking.

## Phase 4: Monolith Integration
- **Wiring Directives:**
  - Create the bounded broadcast channel (size 1024).
  - Setup KafkaLogConsumer.
  - Register metrics logger_ws_connections_active and logger_ws_dropped_total.
  - Route WebSocket upgrades on "/v1/ws" with state.
  - Spawn WS server task on role ws-server.
