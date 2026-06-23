# Track 1: Edge Receiver

## Section 1: Component Context & Immutable Boundaries
- **CLI Role Trigger**: `--role edge`
- **Upstream Input Source**: HTTP POST `/v1/logs` (Authenticated via stateless JWT)
- **Downstream Destination**: Redpanda Topic `logs-raw`
- **Performance Constraints**:
  - Max payload size: 256KB uncompressed (returns HTTP 413).
  - Max nested depth: 5 levels (evaluated by iterative JSON parser; returns HTTP 400).
  - MUST NOT use recursive parsing (stack-overflow DoS vector).

## Section 2: Interface Contracts & Data Models

### Domain Models
- **Raw Input Boundary**: A generic, unstructured JSON schema (e.g., `Map<String, Any>`) to safely accept arbitrary nested data without framework-level structural mapping failures.
- **KeyValue Structure**: 
  - `key`: String
  - `value`: String (Flattened dot-notation representation of the deeply nested value)
- **IngestedLog (Internal Domain Boundary)**:
  - `timestamp`: String
  - `level`: String
  - `message`: String
  - `app_name`: String
  - `error_code`: Optional String
  - `attributes`: Array of `KeyValue` objects

### Error Variants
- `Unauthorized`: JWT is missing, invalid, or expired.
- `Forbidden`: App Name in payload does not match the grants inside the JWT.
- `BadRequest`: Malformed JSON or JSON nesting depth strictly exceeds 5 levels.
- `PayloadTooLarge`: Raw byte size exceeds 256KB.

### Component Contracts
- **LogProducer Interface**: A stateless, thread-safe dependency boundary. Exposes an asynchronous `produce` method that takes an `IngestedLog` and returns a success unit or an array of internal system errors.

## Section 3: Behavior-Driven Specification (BDD)

```gherkin
Feature: Edge Receiver Ingestion
  Scenario: Valid log payload is accepted
    Given a valid OTLP JSON payload with nested key-value arrays
    And the payload size is under 256KB
    And the nesting depth is under 5 levels
    And a JWT with app_grants containing the payload's app_name
    When it hits the Edge Receiver
    Then it MUST be authenticated, iteratively parsed and flattened
    And proxied to logs-raw

  Scenario: Payload exceeds depth limit
    Given a log payload containing dynamic attributes with a nesting depth of 6
    When the Edge Receiver encounters the depth breach during iterative parsing
    Then it MUST fail-fast immediately with HTTP 400
```

## Section 4: Incremental Logic Implementation (The DAG)
1. **Pure Logic**: Implement the iterative (non-recursive) JSON parser against dynamic raw objects to dynamically walk the tree without structural deserialization failures. Implement depth and size validators. Implement the stateless JWT RBAC validator checking `app_grants` against `app_name`.
2. **Infrastructure Adapters**: Implement the `LogProducer` interface contract using the native `rdkafka` crate to produce to `logs-raw`.
3. **The Event Loop**: Implement the web server handler. The HTTP handler MUST accept raw bytes or generic JSON types (not a rigid struct) to allow the iterative validator to work. The loop MUST emit `tracing::debug` on ingestion, `tracing::error` on validation/Kafka failures, and MUST increment explicit Prometheus counters for success, HTTP 400, HTTP 403, and HTTP 413 channels independently.

## Section 5: Wiring & Registration
**Registration Directives:**
1. In the application entry point, capture the `--role edge` command line argument.
2. If triggered, instantiate the concrete Kafka Producer adapter using environment variables for the broker URLs.
3. Explicitly initialize and register the Prometheus metrics (`logger_ingest_bytes_total`, `logger_edge_requests_total`, `logger_edge_errors_total`) into the global registry.
4. Inject the initialized producer and metrics handles into the web server application state.
5. Bind the web server router to `0.0.0.0:8080` and spawn the blocking execution thread.

## Section 6: Track Acceptance Criteria (The Exit Gate)
- [ ] `cargo fmt --check`, `cargo clippy`, and `cargo nextest run` pass.
- [ ] Code guaranteed to contain NO `.unwrap()`, `.expect()`, `unreachable!()`, or `panic!()` in application logic.
- [ ] Code guaranteed to contain NO stubbed/mock data interfaces (using concrete `rdkafka` and HTTP clients).
- [ ] Handler explicitly accepts dynamically structured JSON to prevent framework HTTP 422 before iterative validation.
- [ ] Prometheus metrics incremented on BOTH success and error boundaries.
- [ ] Tracing spans are explicitly written in the HTTP handler loop.
- [ ] NO raw Rust syntax blocks inside this blueprint specification document.
