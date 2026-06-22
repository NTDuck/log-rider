# Feature Specification: Log Collection and Application Error Monitoring System (Final Hardened Design v6)

**Feature Branch**: `v6-hardened`

**Created**: 2026-06-22

**Status**: Ready / Frozen

**Input**: User description: "Create specs/03-hardened/v6/README.md... using base v5/README.md and the patch directive in specs/03-hardened/REMEDIATION_MATRIX.md. Ensure absolute compliance to specs/02-disambiguated/README.md... Spend every effort to make v6 final."

## Table of Contents
- [User Scenarios \& Testing](#user-scenarios--testing-mandatory)
  - [User Story 1 - Real-Time Log Streaming with RBAC](#user-story-1---real-time-log-streaming-with-rbac-priority-p1)
  - [User Story 2 - High-Speed Safe Ingestion and Schema Guarding](#user-story-2---high-speed-safe-ingestion-and-schema-guarding-priority-p1)
  - [User Story 3 - Asynchronous AI Classification and Sidecar Storage](#user-story-3---asynchronous-ai-classification-and-sidecar-storage-priority-p2)
  - [User Story 4 - Tumbling Window Alert Notification and Rate Limiting](#user-story-4---tumbling-window-alert-notification-and-rate-limiting-priority-p2)
  - [User Story 5 - Real-Time Application Health Analytics](#user-story-5---real-time-application-health-analytics-priority-p2)
  - [Edge Cases \& Absolute Boundaries](#edge-cases--absolute-boundaries)
- [Acknowledged Dealbreakers \& Systemic Compromises](#acknowledged-dealbreakers--systemic-compromises)
- [Requirements](#requirements-mandatory)
  - [Functional Requirements](#functional-requirements)
  - [Logical Data Models \& Schemas](#logical-data-models--schemas)
  - [The Topic Topology (Event Boundaries)](#the-topic-topology-event-boundaries)
  - [Database Table Contracts](#database-table-contracts)
  - [Error Routing \& DLQ Contracts](#error-routing--dlq-contracts)
  - [Authorization Contracts](#authorization-contracts)
  - [Telemetry \& Metric Contracts](#telemetry--metric-contracts)
  - [Key Entities](#key-entities)
- [Governance \& Security Evidence](#governance--security-evidence-mandatory)
  - [Agent Parity Governance](#agent-parity-governance)
  - [Architecture Governance](#architecture-governance)
  - [Security Governance](#security-governance)
- [Success Criteria](#success-criteria-mandatory)
  - [Measurable Outcomes](#measurable-outcomes)
  - [Assumptions](#assumptions)

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Real-Time Log Streaming with RBAC (Priority: P1)

Authorized engineers MUST be able to open the Viewer dashboard and view a real-time stream of incoming normalized log records filtered by their permitted applications, without introducing database query load.

* **Why this priority**: Real-time observability is the primary mechanism for engineers to diagnose active issues in production. Securing log streams statelessly is critical to protect privacy and prevent scaling bottlenecks.
* **Independent Test**: Connect a mock WebSocket client with a JWT containing `app_grants: ["payment-api"]`. Ingest logs for both `payment-api` and `auth-service` into the pipeline. Verify that the WebSocket client receives only `payment-api` logs, and that the database receives zero read queries during this test. Test the wildcard `*` claim to ensure it allows streaming of all applications.
* **Acceptance Scenarios**:
  1. **Given** a client requests a WebSocket connection passing a cryptographically valid JWT in the handshake containing `app_grants: ["payment-api", "user-service"]`, **When** logs flow through `logs-normalized`, **Then** the client MUST receive logs only for permitted apps.
  2. **Given** an admin client connects with `app_grants: ["*"]`, **Then** the client MUST receive all logs.
  3. **Given** a client requests a connection with an invalid token, **Then** the server MUST reject with HTTP `401 Unauthorized`.

---

### User Story 2 - High-Speed Safe Ingestion and Schema Guarding (Priority: P1)

The system MUST ingest log payloads at high-speed from external applications and perform OTLP flattening safely at the edge using an iterative parser to prevent stack exhaustion DoS.

* **Why this priority**: Database protection is vital to prevent denial-of-service under malformed telemetry input. Flattening OTLP attributes ensures that query processing speeds remain high while complying with ADR-0016.
* **Acceptance Scenarios**:
  1. **Given** a valid OTLP JSON payload with nested key-value arrays, **When** it hits the Edge Receiver, **Then** it MUST be authenticated, iteratively parsed and flattened (converting nested structures to dot-notation), and proxied to `logs-raw`.
  2. **Given** a log payload containing dynamic attributes with a nesting depth of 6 or higher, **When** the Edge Receiver encounters the depth breach during iterative parsing, **Then** it MUST fail-fast immediately (HTTP 400) without recursive stack allocation.

---

### User Story 3 - Asynchronous AI Classification and Sidecar Storage (Priority: P2)

The system MUST asynchronously classify incoming normalized logs using machine learning models without blocking the primary ingestion pipeline, and store tags in a decoupled sidecar table resolved via Dictionaries.

* **Acceptance Scenarios**:
  1. **Given** a log payload is successfully published to `logs-normalized`, **When** the AI Consumer is running, **Then** the consumer MUST extract the message body, run its ONNX model, write the output tag to `log_ai_tags`, and publish a patch to `ai-tags-stream`.

---

### User Story 4 - Tumbling Window Alert Notification and Rate Limiting (Priority: P2)

The system MUST aggregate high-priority errors in a tumbling window and notify administrators via Telegram, employing a Lua Token Bucket to prevent API bans.

* **Acceptance Scenarios**:
  1. **Given** a threshold configuration of 100 errors per 60 seconds, **When** 150 errors with matching fingerprints are consumed from `alerts-priority-stream`, **Then** the Alert Consumer MUST deduplicate them in O(1) space, apply a Lua Token Bucket rate limit, and fire exactly 1 notification to Telegram.

---

### User Story 5 - Real-Time Application Health Analytics (Priority: P2)

The system MUST continuously aggregate incoming error rates and log volumes to power application health dashboards, shielded from the raw logs table.

* **Acceptance Scenarios**:
  1. **Given** thousands of logs streaming into the database, **Then** ClickHouse MUST automatically materialize aggregations into an `AggregatingMergeTree` table, ensuring dashboard queries return in milliseconds without scanning the primary `logs` table (ADR-0011).

---

### Edge Cases & Absolute Boundaries

- **Iterative Edge Flattening**: The Edge Receiver MUST flatten payloads using an *iterative* JSON parser. Recursive parsing is strictly banned to eliminate stack-overflow DoS vectors. 
- **Fail-Fast Depth Limit**: The iterative parser must fail immediately (HTTP 400) if the nesting depth exceeds 5 levels.
- **OpenAPI Memory Guardrails**: The OpenAPI schema MUST strictly enforce `maxProperties` and `maxLength` on dynamic objects to prevent in-memory map bloat during code generation.
- **Alert Routing PII Safety**: The Normalization Worker MUST perform PII regex redaction *before* duplicating high-priority logs to the `alerts-priority-stream`.
- **DLQ Containment Envelope**: Payloads sent to the Dead Letter Queue MUST be truncated. The `DLQEnvelope` MUST store only the first 2KB of the `original_payload` alongside its `sha256_hash`. The `logs-dlq` topic MUST enforce a strict 24-hour TTL.
- **No Sidecar UUID Joins**: Relational `JOIN` operations on UUIDs and `IN (UUID)` filtering on the main `logs` table are strictly forbidden. Sidecar correlations MUST rely entirely on ClickHouse **Dictionaries**.

---

## Acknowledged Dealbreakers & Systemic Compromises

1. **Redis Crash "State Amnesia" Dealbreaker**: 
   - *Compromise*: If Redis crashes, the Alert Consumer will permanently lose the active 60-second tumbling window occurrence counts and token buckets. 
   - *Rationale*: We explicitly accept this ephemeral state loss. Synchronous DB queries in the consumer loop to reconstruct state from ClickHouse are absolutely forbidden to ensure non-blocking message ingestion.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Edge Receiver MUST authenticate incoming HTTP POST log payloads using a stateless JWT Authorization header (`app_name` must exist in `app_grants`). It MUST iteratively parse and flatten the payload (ADR-0016) enforcing a max depth of 5, dropping connections (HTTP 413) if the request exceeds 256KB, and proxy the flattened payload to `logs-raw`.
- **FR-002**: Client SDKs MUST strip PII before transmission. To mitigate unredacted client failure, `logs-raw` MUST be configured at the Redpanda topic level with strict short retention (`retention.ms=86400000`, 24 hours). 
- **FR-003**: The Normalization Worker MUST consume `logs-raw`, execute statically compiled regex-based PII redaction, transform the flattened JSON into parallel arrays (`attribute_keys`, `attribute_values_string`), and publish to `logs-normalized`.
- **FR-004**: *After* PII regex redaction is complete, the Normalization Worker MUST duplicate logs with level `ERROR` or `CRITICAL` to the `alerts-priority-stream` topic.
- **FR-005**: If processing encounters a Poison Pill (> 64KB compressed, etc.), the worker MUST wrap the error in the `DLQEnvelope` (truncating the original payload to 2KB) and publish to `logs-dlq`.
- **FR-006**: The DB Writer MUST read from `logs-normalized` and write logs in batches to the ClickHouse `logs` table.
- **FR-007**: The AI Consumer MUST asynchronously consume `logs-normalized`, perform ONNX classification, and write to the ClickHouse sidecar `log_ai_tags` table.
- **FR-008**: The WebSocket Server MUST use the Broadcast Consumer Pattern to fan out messages from `logs-normalized` in-memory. It MUST support the `*` wildcard claim for administrators.
- **FR-009**: The Alert Consumer MUST consume from `alerts-priority-stream`, execute O(1) Redis deduplication, enforce a Lua Token Bucket rate limit to protect Telegram (ADR-0022), and dispatch notifications.
- **FR-010**: ClickHouse MUST enforce log retention via native Table-level `TTL ... DELETE WHERE` rules. No `UPDATE` or `DELETE` mutation queries are permitted. An Admin API Actor MUST write alert configurations to an append-only `MergeTree` table, publishing updates via Redis Pub/Sub to bypass `ReplacingMergeTree` mutation traps.

---

### Logical Data Models & Schemas

#### Attributes Constraints Map (Edge-Evaluated)

| Metric | Constraint | Consequence of Violation |
| :--- | :--- | :--- |
| **Max Depth** | 5 levels (evaluated by the Edge Receiver during iterative parsing) | HTTP 400 Bad Request |
| **Payload Size** | 256KB uncompressed | HTTP 413 Payload Too Large |
| **Homogeneous Arrays** | *DELETED*. This constraint is logically absurd as ClickHouse casts all attribute values to strings (`Array(String)`). | N/A |

#### OpenAPI Spec: Edge Receiver API

```yaml
openapi: 3.0.0
info:
  title: Edge Receiver Ingestion API
  version: 1.0.0
  description: Lightweight authenticated ingestion entry point.
paths:
  /v1/logs:
    post:
      summary: Send logs to pipeline
      operationId: ingestLogs
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/IngestedLog'
      responses:
        '202':
          description: Ingestion payload accepted.
        '400':
          description: Malformed JSON or Depth > 5.
        '401':
          description: Unauthorized JWT.
        '403':
          description: App Name does not match JWT Grants.
        '413':
          description: Payload exceeds 256KB limit.
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
  schemas:
    IngestedLog:
      type: object
      required:
        - timestamp
        - level
        - message
        - app_name
      properties:
        timestamp:
          type: string
          format: date-time
        level:
          type: string
          enum: [DEBUG, INFO, WARN, ERROR, CRITICAL]
        message:
          type: string
          maxLength: 32768
        app_name:
          type: string
          maxLength: 255
        error_code:
          type: string
          description: Deterministic string for alert bucketing.
          maxLength: 255
        attributes:
          type: array
          description: Raw nested KeyValue array.
          maxItems: 250
          items:
            type: object
            properties:
              key:
                type: string
                maxLength: 255
              value:
                type: object
                maxProperties: 50
```

---

### The Topic Topology & Deployment Boundaries

The system is compiled as a **single Modular Monolith binary**, however, it is strictly deployed as isolated containers via role-based entrypoint flags (e.g., `logger --role edge`, `logger --role ws-server`). 

```mermaid
graph TD
    Client[Client App] -->|OTLP HTTP + Auth| Edge[Edge Receiver Actor Deployment]
    Edge -->|Produces Flattened JSON| TopicRaw["logs-raw (Topic)"]
    
    Worker[Normalization Actor Deployment] -->|Consumes| TopicRaw
    Worker -->|Produces Normalized & Parallel Arrays| TopicNorm["logs-normalized (Topic)"]
    Worker -->|Duplicates Alerts (Post-Redaction)| TopicAlert["alerts-priority-stream (Topic)"]
    Worker -->|Produces Failed (Truncated Payload)| TopicDLQ["logs-dlq (Topic)"]
    
    DBWriter[DB Writer Actor Deployment] -->|Consumes| TopicNorm
    DBWriter -->|Batch Writes| CHLogs[(ClickHouse logs table)]
    DBWriter -->|Materialized View| CHAgg[(AggregatingMergeTree)]
    
    AIConsumer[AI Consumer Actor Deployment] -->|Consumes| TopicNorm
    AIConsumer -->|Batch Writes| CHSidecar[(ClickHouse log_ai_tags)]
    
    AlertConsumer[Alert Consumer Actor Deployment] -->|Consumes| TopicAlert
    AlertConsumer -->|Deduplicate & Lua Token Bucket| Redis[(Redis Counter)]
    
    WS[WebSocket Server Actor Deployment] -->|Consumes| TopicNorm
    WS -->|Filters| ClientViewer[Viewer Client]
```

---

### Database Table Contracts

To perfectly support dynamic flattened data, ClickHouse utilizes parallel Array columns (`attribute_keys` and `attribute_values_string`). The UUID (`log_id`) is explicitly omitted from the `ORDER BY` clause to preserve sparse index compression. Sidecar lookups MUST utilize ClickHouse Dictionaries.

```sql
CREATE TABLE default.logs
(
    log_id UUID,
    timestamp DateTime64(3, 'UTC'),
    level Enum8('DEBUG' = 1, 'INFO' = 2, 'WARN' = 3, 'ERROR' = 4, 'CRITICAL' = 5),
    error_code LowCardinality(String),
    message String,
    exception_blob String,
    app_name LowCardinality(String),
    attribute_keys Array(String),
    attribute_values_string Array(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (app_name, level, timestamp)
TTL timestamp + INTERVAL 7 DAY DELETE WHERE level = 'DEBUG',
    timestamp + INTERVAL 30 DAY DELETE WHERE level IN ('INFO', 'WARN'),
    timestamp + INTERVAL 90 DAY;

-- Real-Time Application Health Analytics
CREATE MATERIALIZED VIEW default.app_health_mv
ENGINE = AggregatingMergeTree()
ORDER BY (app_name, level, toStartOfMinute(timestamp))
AS SELECT
    app_name,
    level,
    toStartOfMinute(timestamp) AS minute,
    countState() AS log_count
FROM default.logs
GROUP BY app_name, level, minute;
```

---

### Error Routing & DLQ Contracts

When a consumer encounters a processing failure, it MUST wrap the original payload in this exact schema envelope before publishing to `logs-dlq` to prevent PII leaks and DoS bloat:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "DLQEnvelope",
  "type": "object",
  "required": [
    "failed_at",
    "error_reason",
    "worker_id",
    "original_payload_truncated",
    "sha256_hash"
  ],
  "properties": {
    "failed_at": { "type": "string", "format": "date-time" },
    "error_reason": { "type": "string" },
    "worker_id": { "type": "string" },
    "original_payload_truncated": { 
      "type": "string",
      "maxLength": 2048,
      "description": "The first 2KB of the payload. DO NOT embed the full payload to prevent PII leaks to storage."
    },
    "sha256_hash": { "type": "string" }
  }
}
```

---

### Telemetry & Metric Contracts (ADR-0024)
To satisfy ADR-0024, the pipeline MUST expose the following Prometheus metrics to track implicit state across asynchronous topics:
* `logger_ingest_bytes_total`: Total bytes ingested at Edge.
* `logger_dlq_events_total`: Counter for poison pills.
* `logger_pii_redactions_total`: Counter for AST-level regex hits.
* `logger_alerts_fired_total`: Notifications passed through the Lua Token Bucket.

---

### Authorization Contracts
Both the Edge Receiver (Telemetry Ingestion) and the WebSocket server (Viewer Output) MUST enforce stateless RBAC utilizing JWT tokens validated entirely in-memory using shared public keys. No database lookups are permitted. The wildcard `*` MUST be supported to denote global administrative access.

---

### Key Entities
- **LogEntry**: The canonical normalized log message inside the system, containing `error_code`.
- **PoisonPill**: A payload quarantined to the Dead Letter Queue.
- **AITag**: Classification tags stored in the sidecar table.

---

## Governance & Security Evidence *(mandatory)*

### Agent Parity Governance
- **Checkpoint**: Shared Agent Guidance compliance.
- **Status**: `N/A`
- **Rationale**: No updates to `.specify/memory/constitution.md`. 
- **Maintained Surfaces**: Feature specification (`v6/README.md`).
- **Deviations**: Redis State Amnesia formally logged as an architectural exception.

### Architecture Governance
- **Checkpoint**: Memory safety and trust boundaries.
- **Status**: `Pass`
- **Evidence/Rationale**:
  - Implementation language is Rust (memory-safe).
  - Trust boundary identified: The Edge Receiver strictly checks the `app_name` against the stateless JWT `app_grants` array to prevent Cross-Tenant Log Spoofing.
  - Zero synchronous database polling loops exist inside streaming paths. Sidecar lookups utilize ClickHouse Dictionaries.

### Security Governance
- **Checkpoint**: Security compliance standards.
- **Status**: `Pass`
- **Evidence/Rationale**:
  - PII Controls: Static compiled regex applied *before* alert duplication.
  - DLQ Containment: Payload truncated to 2KB to prevent unredacted PII storage and broker DoS bloat.
  - OOM Guardrails: OpenAPI boundaries explicitly define `maxProperties`. Edge flattening uses a strictly iterative JSON parser.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes
- **SC-001**: 95% of ingested client logs MUST be normalized, validated, and safely stored in ClickHouse in under 1.0 second.
- **SC-002**: The WebSocket viewer server MUST fan out logs from `logs-normalized` topic to client browsers in under 50 milliseconds of event receipt.
- **SC-003**: The Edge Receiver ingestion layer MUST sustain a write throughput of 500+ logs per second under continuous load without stack exhaustion.
- **SC-004**: Alert deduplication MUST decrease Telegram API call volume by at least 90% during cascading incident storms without triggering rate limits.
- **SC-005**: 100% of Poison Pills MUST be detected, truncated, and successfully routed to `logs-dlq` within 500ms of worker consumption.

---

## Assumptions
- **A-001**: Network load balancers will distribute incoming client traffic evenly across multiple Edge Receiver deployment instances.
- **A-002**: Client applications are responsible for obtaining valid JWT tokens from the Identity Provider prior to hitting the Edge Receiver.
