# Track 6: WebSocket Server

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role ws-server`
- **Upstream Input Source**: Redpanda Topic `logs-normalized`
- **Downstream Destination**: WebSocket Clients (Viewer Dashboard)
- **Performance Constraints**:
  - MUST use the Broadcast Consumer Pattern to fan out messages in-memory.
  - MUST enforce stateless RBAC (JWT validation) directly without DB lookup.
  - MUST enforce internal backpressure via bounded channels.

## Section 2: Interface Contracts & Data Models

### Domain Models
- **WsClientConfig**:
  - `allowed_apps`: Array of Strings (extracted directly from JWT)
  - `is_admin`: Boolean

### Error Variants
- `InvalidToken`: The provided JWT is missing, expired, or cryptographically invalid.
- `ConnectionDropped`: The client closed the connection.
- `LaggingClient`: The client is consuming too slowly, forcing the server to drop the connection to preserve memory.

## Section 3: Behavior-Driven Specification (BDD)

```gherkin
Feature: WebSocket Viewer
  Scenario: Client receives authorized logs
    Given a client requests a WebSocket connection passing a cryptographically valid JWT containing app_grants: ["payment-api"]
    When logs flow through logs-normalized
    Then the client MUST receive logs only for payment-api

  Scenario: Admin client receives all logs
    Given an admin client connects with app_grants: ["*"]
    Then the client MUST receive all logs
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement the stateless JWT RBAC extractor that directly constructs the `WsClientConfig`. Implement the memory-filtering logic that compares log boundaries against the client's grants.
2. **Infrastructure Adapters**: Implement the HTTP-to-WebSocket upgrade protocol handler.
3. **The Event Loops**: 
   - **Task A (Broker Ingestion)**: Fetch logs from the message broker and push them into an internal bounded memory channel (strict backpressure).
   - **Task B (Client Sessions)**: Per-client asynchronous loops that read from the bounded channel, execute the filter logic, and push to the active socket.
   - **Telemetry**: Sessions MUST emit `tracing::debug` upon client connection/disconnection, and `tracing::error` upon handshake failures or lagging drops. Prometheus counters `logger_ws_connections_active`, `logger_ws_fanout_success_total`, and `logger_ws_dropped_total` MUST be incremented.

## Section 5: Wiring & Registration
**Registration Directives:**
1. Upon matching the `--role ws-server` argument, initialize the internal bounded broadcast channel.
2. Instantiate the message broker consumer and attach it to the ingestion loop.
3. Initialize the global Prometheus connection and fan-out metrics.
4. Bind the web server engine to the designated port (e.g., `8081`), mapping the WebSocket upgrade handler.
5. Spawn the application loops.

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()`.
- [ ] Explicit unbounded queue ban adherence (internal channel strictly bounded to a fixed size).
- [ ] Stateless filter verified (no DB or external cache calls for RBAC).
- [ ] Explicit tracing spans and dual-channel Prometheus metrics included in the execution loops.
- [ ] NO raw Rust syntax blocks inside this blueprint specification document.
