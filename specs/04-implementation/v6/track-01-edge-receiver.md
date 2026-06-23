# Track 1: Edge Receiver

## Phase 1: The Domain & Contracts
- **Trigger & Topology:** Activated via the CLI role flag "--role edge". It takes upstream HTTP POST requests on the path "/v1/logs" (authenticated via stateless JWT Bearer tokens). It produces validated, flattened log payloads to the Redpanda topic "logs-raw".
- **Data Schemas:**
  - IngestedLog Model:
    - timestamp: String (ISO 8601 formatted date-time string)
    - level: String (Allowed values: DEBUG, INFO, WARN, ERROR, CRITICAL)
    - message: String (Max length 32768)
    - app_name: String (Max length 255)
    - error_code: Option string (Deterministic string for alert bucketing, max length 255)
    - attributes: Vector of KeyValue objects (Raw nested array, max items 250)
  - KeyValue Helper Model:
    - key: String (Max length 255)
    - value: String (Flattened dot-notation value)
  - EdgeError Variants:
    - Unauthorized: Client JWT is missing or invalid.
    - Forbidden: Application name in payload is not present in JWT app grants list.
    - BadRequest: Payloads containing malformed JSON or nested depth exceeding 5 levels.
    - PayloadTooLarge: Payload size exceeds 256KB uncompressed.
    - KafkaProduceError: Internal failure when writing to Redpanda topic.
  - LogProducer Boundary Trait:
    - Method: produce(log: IngestedLog) -> Fallible Result containing success or a vector of EdgeError.
- **Physical Constraints:**
  - Must drop connections directly at the socket level if the body size exceeds 256KB.
  - Must validate JSON nesting depth iteratively without using recursive parser logic to protect against stack-overflow DoS vectors.
  - Depth limit is 5 levels.

## Phase 2: The Behavioral Specification
- **The Gherkin Feature (Edge Receiver Ingestion):**
  - Scenario 1: Valid log payload is accepted.
    - Given a valid OTLP JSON payload with nested key-value arrays.
    - And the payload size is under 256KB.
    - And the nesting depth is under 5 levels.
    - And a JWT with app_grants containing the payload's app_name.
    - When it hits the Edge Receiver.
    - Then it MUST be authenticated, iteratively parsed, flattened, and proxied to logs-raw.
  - Scenario 2: Payload exceeds depth limit.
    - Given a log payload containing dynamic attributes with a nesting depth of 6.
    - When the Edge Receiver encounters the depth breach during iterative parsing.
    - Then it MUST fail-fast immediately with HTTP 400.
  - Scenario 3: Request payload exceeds maximum size limit.
    - Given a log payload with size exceeding 256KB.
    - When it is sent to the Edge Receiver.
    - Then it MUST be rejected with HTTP 413 Payload Too Large.
- **Crucial Directive:** Do not write application code until the step definitions for these scenarios are scaffolded and failing.

## Phase 3: The Execution DAG (The Core Engine)
- **Step 1: Scaffolding & Tests:** Define the data models using bon builders. Implement the cucumber World and step definitions for the Edge Receiver features.
- **Step 2: Pure Logic:** Implement an iterative JSON validator checking payload depth (no recursion, max depth 5). Implement a stateless JWT validator checking app grants against app name.
- **Step 3: Infrastructure Adapters:** Implement the LogProducer boundary trait natively via rdkafka FutureProducer. Suffix the produce method with a tap error call that logs the failure and increments the metric logger_edge_errors_total to prevent early returns from bypassing telemetry.
- **Step 4: The Actor Loop:** Implement the Axum POST web handler.
  - Physical Socket Limits: Enforce a default body limit of 256 * 1024 bytes (axum::extract::DefaultBodyLimit::max) directly at the Axum router level to drop large stream payloads before they enter the parser.
  - Telemetry Bypass Prevention: The Axum handler must increment logger_edge_requests_total on success, and must use an explicit tap error or exhaustive match block to log server errors and increment logger_edge_errors_total on failure before any early-returns.

## Phase 4: Monolith Integration
- **Wiring Directives:**
  - Instantiate KafkaLogProducer with the brokers configuration.
  - Configure the Axum Router mapping POST "/v1/logs" to the edge handler.
  - Apply the body limit layer to the route.
  - Register logger_edge_requests_total and logger_edge_errors_total to the Prometheus registry.
  - Check if role is edge, then spawn Axum server on port 8080.
