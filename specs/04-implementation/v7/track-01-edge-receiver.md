# Track 1: Edge Receiver

## Phase 1: The Domain & Contracts

- **Trigger & Topology:** Activated via the CLI role flag "--role edge". It takes upstream HTTP POST requests on the path "/v1/logs" (authenticated via stateless JWT Bearer tokens). It produces validated, flattened log payloads to the Redpanda topic "logs-raw".

- **Wire Model (WireLog) — The HTTP Boundary:**
  This model exists solely for Axum deserialization. It accepts the raw, unbounded JSON the client sends. Its purpose is to prevent Axum from emitting a premature 422 Unprocessable Entity by never coercing nested JSON into Rust strings at the deserialization boundary.
  - timestamp: String (ISO 8601 formatted date-time string)
  - level: String (Allowed values: DEBUG, INFO, WARN, ERROR, CRITICAL)
  - message: String (Max length 32768)
  - app_name: String (Max length 255)
  - error_code: Optional String (Deterministic string for alert bucketing, max length 255)
  - attributes: Optional serde_json::Value (Raw, unvalidated JSON — accepts any nested structure without type coercion)

  The attributes field MUST be typed as serde_json::Value (not a Vec of KeyValue, not a String). This is the critical decoupling point: the wire boundary accepts anything JSON-legal, deferring all structural validation to the iterative flattening step.

- **Domain Model (DomainLog) — The Kafka Boundary:**
  This model is what gets serialized and produced to the "logs-raw" topic. It contains the flattened, validated representation after iterative parsing.
  - log_id: UUID (Generated at the edge via uuid::Uuid::now_v7)
  - timestamp: String (ISO 8601 formatted date-time string, validated)
  - level: String (Validated against the enum set)
  - message: String (Validated max length 32768)
  - app_name: String (Validated max length 255)
  - error_code: Optional String (Max length 255)
  - attribute_keys: Vec of String (Dot-notation flattened keys, e.g. "request.headers.content_type")
  - attribute_values_string: Vec of String (Parallel array of stringified leaf values, positionally aligned with attribute_keys)

  The two parallel arrays (attribute_keys, attribute_values_string) MUST always have identical length. This mirrors the ClickHouse logs table schema exactly.

- **JWT Claims Model:**
  - sub: String (Subject identifier)
  - app_grants: Vec of String (List of application names the token holder is authorized to ingest for; the wildcard "*" grants universal access)
  - exp: u64 (Expiration timestamp, seconds since epoch)

- **EdgeError Variants:**
  - Unauthorized: Client JWT is missing, expired, or cryptographically invalid. Maps to HTTP 401.
  - Forbidden: The app_name in the payload is not present in the JWT app_grants list and no wildcard "*" grant exists. Maps to HTTP 403.
  - BadRequest: Payload contains malformed JSON, attributes nesting depth exceeds 5 levels, objects exceed 50 properties, arrays exceed 250 items, object keys exceed 255 characters, level is not in the allowed enum set, or any field exceeds its maxLength. Maps to HTTP 400.
  - PayloadTooLarge: Payload size exceeds 256KB uncompressed. Maps to HTTP 413.
  - KafkaProduceError: Internal failure when writing to Redpanda topic. Maps to HTTP 502.

- **Closed-World Telemetry Contract:**
  This track may ONLY reference the following two metrics from the global set of 6. No other metric names may be invented, registered, or incremented anywhere in this track.
  - logger_ingest_bytes_total (Counter): Incremented by the raw byte length of the HTTP request body on every request that passes the 256KB socket limit, regardless of whether the request ultimately succeeds or fails validation.
  - logger_events_processed_total (Counter, labels: stage="edge", status="success" or "error"): Incremented exactly once per request at the terminal outcome of the handler. Label status="success" on HTTP 202. Label status="error" on any 4xx or 5xx response.

- **Physical Constraints:**
  - MUST drop connections directly at the Axum socket level if the body size exceeds 256KB, before any JSON parsing occurs.
  - MUST validate JSON nesting depth iteratively using an explicit stack (Vec) — never recursion — to protect against stack-overflow DoS vectors.
  - Depth limit is 5 levels. A depth breach produces an immediate HTTP 400 without processing the remainder of the payload.

---

## Phase 2: The Behavioral Specification

- **The Gherkin Feature (Edge Receiver Ingestion):**

  - Scenario 1: Valid log payload is accepted and flattened.
    - Given a valid OTLP JSON payload with nested key-value attributes at depth 3.
    - And the payload size is under 256KB.
    - And a JWT with app_grants containing the payload's app_name.
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST respond with HTTP 202.
    - And the payload MUST be iteratively parsed, flattened to dot-notation parallel arrays, and produced to "logs-raw" as a DomainLog.

  - Scenario 2: Payload exceeds depth limit.
    - Given a log payload containing attributes with a nesting depth of 6.
    - And a valid JWT.
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST fail-fast immediately with HTTP 400.
    - And no message MUST be produced to "logs-raw".

  - Scenario 3: Request payload exceeds maximum size limit.
    - Given a log payload with size exceeding 256KB.
    - When it is sent to the Edge Receiver.
    - Then it MUST be rejected with HTTP 413 Payload Too Large.
    - And no message MUST be produced to "logs-raw".

  - Scenario 4: JWT is missing or invalid.
    - Given a request with no Authorization header (or an expired/malformed JWT).
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST respond with HTTP 401 Unauthorized.

  - Scenario 5: App name not in JWT grants.
    - Given a valid JWT with app_grants containing only "payment-api".
    - And a payload with app_name "auth-service".
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST respond with HTTP 403 Forbidden.

  - Scenario 6: Attributes are flattened to dot-notation.
    - Given a payload with attributes containing nested objects like key "request" with value containing key "headers" with value containing key "host" with leaf value "example.com".
    - When it is accepted by the Edge Receiver.
    - Then the produced DomainLog MUST contain attribute_keys including "request.headers.host" and the corresponding attribute_values_string entry MUST be "example.com".

  - Scenario 7: Wildcard JWT grant allows any app_name.
    - Given a valid JWT with app_grants containing "*".
    - And a payload with any arbitrary app_name.
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST respond with HTTP 202.

  - Scenario 8: Payload attributes exceed memory guardrail limits.
    - Given a log payload containing an attribute object with 51 properties, or an array with 251 items, or a key exceeding 255 characters.
    - When it is POSTed to "/v1/logs".
    - Then the Edge Receiver MUST fail-fast immediately with HTTP 400.
    - And no message MUST be produced to "logs-raw".

- **Cucumber World Struct:**
  - EdgeWorld fields:
    - raw_payload: Optional serde_json::Value
    - jwt_token: Optional String
    - response_status: Optional u16
    - produced_domain_log: Optional DomainLog (captures what was produced to Kafka for assertion)

- **Crucial Directive:** Do NOT write application code until the step definitions for all seven scenarios above are scaffolded and failing (red phase). The cucumber World must hold sufficient state to assert on both HTTP status codes and the shape of the DomainLog that would be produced.

---

## Phase 3: The Execution DAG (The Core Engine)

- **Step 1 — Scaffolding & Failing Tests:**
  1. Define the WireLog struct with serde::Deserialize. The attributes field MUST be typed as Option of serde_json::Value. Apply no custom deserializer — let serde accept any valid JSON structure.
  2. Define the DomainLog struct with serde::Serialize and bon::Builder. The attribute_keys and attribute_values_string fields are Vec of String. Generate a log_id via uuid::Uuid::now_v7 during construction.
  3. Define the EdgeError enum with axiom Erratum derive.
  4. Define the JwtClaims struct with sub, app_grants, and exp fields.
  5. Scaffold the cucumber EdgeWorld and write step definitions for all seven Gherkin scenarios from Phase 2. Run them. They MUST all fail (red).

- **Step 2 — Pure Logic (Iterative Flattener & JWT Validator):**
  1. Implement the iterative JSON depth validator and flattener as a single function:
     - Signature: Takes a reference to serde_json::Value (the raw attributes from WireLog), returns Result of (Vec of String, Vec of String) or EdgeError::BadRequest.
     - Mechanism: Allocate an explicit stack as a Vec of tuples (prefix: String, value: reference to serde_json::Value, depth: usize). Push the root value with empty prefix and depth 0. Enter a while-let loop popping from the stack.
     - For each popped item: if depth exceeds 5, return Err(EdgeError::BadRequest) immediately. If the value is a serde_json::Value::Object, verify it contains no more than 50 properties and no key exceeds 255 characters; if it violates this, return Err(EdgeError::BadRequest) immediately. Iterate its entries and push each child onto the stack with the key appended to the prefix using dot notation (e.g., parent_prefix + "." + child_key, trimming any leading dot) and depth + 1. If the value is a serde_json::Value::Array, verify it contains no more than 250 items; if it exceeds this, return Err(EdgeError::BadRequest) immediately. Iterate with index-based keys (e.g., "items.0", "items.1"). If the value is a leaf (String, Number, Bool, Null), stringify it and append the prefix to attribute_keys and the stringified value to attribute_values_string.
     - This function MUST NOT use recursion. It MUST NOT call itself.
  2. Implement the stateless JWT validator:
     - Signature: Takes the raw Authorization header value (String), returns Result of JwtClaims or EdgeError::Unauthorized.
     - Use jsonwebtoken::decode with the configured public key and validation parameters (require exp, validate exp against current time).
     - Apply .tap_err(|e| ::tracing::error!(error = %e, "JWT decode failed")) before the ? operator.
  3. Implement the app_name grant checker:
     - Signature: Takes a reference to JwtClaims and a reference to the app_name String, returns Result of () or EdgeError::Forbidden.
     - Check if app_grants contains "*" (wildcard — allows all). If not, check if app_grants contains the exact app_name. If neither, return Err(EdgeError::Forbidden).

- **Step 3 — Infrastructure Adapters (Kafka Producer):**
  1. Implement a concrete KafkaLogProducer struct wrapping rdkafka::producer::FutureProducer.
  2. Implement an async produce method:
     - Signature: Takes a reference to DomainLog, returns Fallible Result of () or EdgeError::KafkaProduceError.
     - Serialize the DomainLog to JSON bytes via serde_json::to_vec.
     - Call FutureProducer::send with the topic "logs-raw", using app_name as the Kafka message key for partition locality.
     - This method MUST be annotated with #[::tracing::instrument(skip_all)].
     - The send call MUST use .tap_err(|e| ::tracing::error!(error = %e, "Kafka produce to logs-raw failed")) BEFORE the ? operator.
     - On success, emit ::tracing::debug!(topic = "logs-raw", app_name = %domain_log.app_name, "Produced DomainLog to logs-raw").

- **Step 4 — The Axum Handler (The Actor Loop):**
  1. Define the handler function for POST "/v1/logs".
     - The handler MUST be annotated with #[::tracing::instrument(skip_all)].
     - Extract the raw body as axum::body::Bytes FIRST (not as Json of WireLog). This is critical: the raw bytes are needed to measure logger_ingest_bytes_total before any parsing.
  2. Telemetry — Byte Counting:
     - Immediately after extracting the Bytes, increment logger_ingest_bytes_total by the byte length of the body. This happens unconditionally for every request that passes the socket-level 256KB limit.
  3. JWT Authentication:
     - Extract the Authorization header from the request.
     - Call the stateless JWT validator from Step 2. On failure, increment logger_events_processed_total with labels stage="edge", status="error", and return the appropriate HTTP 401 response. Apply .tap_err(|e| ::tracing::error!(error = %e, "JWT authentication failed")) before the metric increment.
  4. Deserialization — Wire Model:
     - Deserialize the raw Bytes into the WireLog struct via serde_json::from_slice. On failure (malformed JSON), increment logger_events_processed_total with labels stage="edge", status="error", and return HTTP 400. Apply .tap_err(|e| ::tracing::error!(error = %e, "WireLog deserialization failed")).
  5. Field Validation:
     - Validate the level against the allowed enum set (DEBUG, INFO, WARN, ERROR, CRITICAL).
     - Validate message length does not exceed 32768.
     - Validate app_name length does not exceed 255.
     - Validate error_code length (if present) does not exceed 255.
     - On any violation, increment logger_events_processed_total with labels stage="edge", status="error", and return HTTP 400.
  6. Grant Check:
     - Call the app_name grant checker from Step 2 with the decoded JWT claims and the WireLog's app_name. On failure, increment logger_events_processed_total with labels stage="edge", status="error", and return HTTP 403.
  7. Iterative Flattening — Wire to Domain Transformation:
     - If WireLog.attributes is Some, call the iterative flattener from Step 2 with the raw serde_json::Value. On depth violation, increment logger_events_processed_total with labels stage="edge", status="error", and return HTTP 400. Apply .tap_err(|e| ::tracing::error!(error = %e, "Iterative flattening failed — depth exceeded")).
     - If WireLog.attributes is None, use empty vectors for both attribute_keys and attribute_values_string.
     - Construct the DomainLog using the bon builder, mapping all validated fields from WireLog plus the flattened parallel arrays. Generate log_id via uuid::Uuid::now_v7().
  8. Kafka Production:
     - Call the KafkaLogProducer.produce method with the DomainLog. On failure, increment logger_events_processed_total with labels stage="edge", status="error", and return HTTP 502.
  9. Success Terminal:
     - Increment logger_events_processed_total with labels stage="edge", status="success".
     - Emit ::tracing::debug!(log_id = %domain_log.log_id, app_name = %domain_log.app_name, "Edge ingestion succeeded").
     - Return HTTP 202 Accepted.
  10. Critical Handler Invariant:
      - Every control-flow exit path (steps 3 through 9) MUST increment logger_events_processed_total exactly once. There must be no path through the handler that exits without incrementing this metric. The metric is the terminal telemetry gate.

---

## Phase 4: Monolith Integration

- **Wiring Directives:**
  1. In the monolith entrypoint (apps/src/main.rs), check if the CLI role flag equals "edge".
  2. Instantiate the KafkaLogProducer using the rdkafka FutureProducer with the configured broker addresses from environment or config. The instantiation MUST use .tap_err(|e| ::tracing::error!(error = %e, "Failed to create Kafka producer")) before propagating the error.
  3. Load the JWT public key from the configured path or environment variable. Wrap it in an Arc for shared state.
  4. Register exactly two Prometheus metrics with the default registry:
     - logger_ingest_bytes_total as a Counter.
     - logger_events_processed_total as a CounterVec with label names ["stage", "status"].
     - No other metrics may be registered in this track. Attempting to register logger_edge_requests_total, logger_edge_errors_total, or any other invented metric name is a structural violation.
  5. Construct an AppState struct containing: the KafkaLogProducer (wrapped in Arc), the JWT public key (wrapped in Arc), and the two Prometheus metric handles.
  6. Build the Axum Router:
     - Map POST "/v1/logs" to the edge handler.
     - Apply axum::extract::DefaultBodyLimit::max(256 * 1024) as a layer. This enforces the 256KB limit at the socket level, causing Axum to drop oversized request streams BEFORE they are buffered into memory or reach the JSON parser. This is the physical enforcement of the HTTP 413 response.
     - Attach the AppState via .with_state().
  7. Bind the Axum server to the configured address (default "0.0.0.0:8080") using tokio::net::TcpListener::bind. The bind call MUST use .tap_err(|e| ::tracing::error!(error = %e, "TCP listener bind failed")).
  8. Serve with axum::serve(listener, app). Use graceful shutdown integration with a tokio::signal::ctrl_c handler.
  9. The entire edge server launch sequence MUST be wrapped in #[::tracing::instrument(skip_all)] or an equivalent named span (e.g., "edge_server").

- **Exit Gate — Track Acceptance Criteria:**
  - cargo fmt --check passes with zero formatting violations.
  - cargo clippy passes with zero warnings.
  - cargo nextest run passes with all seven cucumber scenarios green.
  - Zero occurrences of .unwrap(), .expect(), unreachable!(), panic!(), todo!(), or unimplemented!() in any source file touched by this track.
  - Zero occurrences of std::sync::Mutex anywhere in async code paths.
  - Zero mock data interfaces — the KafkaLogProducer uses a real rdkafka FutureProducer instance.
  - The ONLY Prometheus metric names present in the codebase for this track are logger_ingest_bytes_total and logger_events_processed_total. Any other metric name is a structural violation.
  - The WireLog.attributes field is typed as Option of serde_json::Value (not String, not Vec of KeyValue).
  - The DomainLog contains attribute_keys: Vec of String and attribute_values_string: Vec of String (not a single attributes field).
  - The iterative flattener explicitly returns EdgeError::BadRequest when encountering objects with >50 properties, arrays with >250 items, or keys >255 characters to neutralize unbounded map allocations.
  - Every fallible I/O call has an explicit .tap_err with ::tracing::error! before the ? operator.
  - Every successful I/O completion has a ::tracing::debug! confirmation.
  - The handler and all async I/O methods carry #[::tracing::instrument(skip_all)].
