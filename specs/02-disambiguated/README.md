# Disambiguated Requirements & Architecture

This document synthesizes the original functional and technical requirements for the Log Collection and Application Error Monitoring System, incorporating the disambiguations and technical decisions recorded in the ADRs.

## 1. High-Speed Ingestion Matrix
- **Edge Receiver API**: A dedicated, lightweight Edge Receiver (Rust, Axum/Tonic) terminates external HTTP/gRPC connections, performs OTLP flattening at the edge ([ADR-0016](./adrs/0016-attribute-flattening-at-the-edge.md)), and acts as a dumb pipe pushing raw payloads to Redpanda ([ADR-0010](./adrs/0010-dedicated-edge-receiver-service.md)).
- **Message Broker**: We rely exclusively on Redpanda (no generic MQ abstractions) for all stream buffering ([ADR-0003](./adrs/0003-redpanda-native-over-mq-abstraction.md)).

## 2. Log Parsing & Filtering Engine
- **Custom Rust Workers**: Dedicated workers consume from `logs-raw`, perform CPU-heavy cleaning, and enforce Strict Schema Policies (max 5 depth, 64KB size, homogenous arrays) to protect the database ([ADR-0002](./adrs/0002-custom-rust-workers-for-ingestion.md), [ADR-0005](./adrs/0005-strict-schema-policies-on-attributes.md)).
- **Dead Letter Queue (DLQ)**: Poison pills (malformed payloads) are sent to `logs-dlq` to prevent infinite retry loops and partition blocking ([ADR-0018](./adrs/0018-dead-letter-queue-for-poison-pills.md)).
- **Pipeline Fan-Out**: Once scrubbed of PII, logs are published to `logs-normalized` for independent downstream consumption ([ADR-0017](./adrs/0017-pipeline-fan-out-for-ai-consumer.md)).
- **Alert Priority Queue**: When workers detect `ERROR` or `CRITICAL` logs, they duplicate them into a dedicated `alerts-priority-stream` topic, isolating alerts from the main ingestion loop ([ADR-0004](./adrs/0004-dedicated-redpanda-topic-for-priority-queue.md)).

## 3. Log Asset Management & Storage
- **Primary Database**: ClickHouse is the OLAP database used for massive batch writes and historical analytical reads ([ADR-0001](./adrs/0001-clickhouse-over-standard-sql.md)).
- **Log Retention Policy**: Log cleanup is managed strictly via ClickHouse native TTL rules (e.g., deleting INFO logs older than 7 days) deployed via infrastructure-as-code ([ADR-0007](./adrs/0007-clickhouse-native-ttl-for-retention.md)).
- **Schema Optimization**: We use Attribute Projection (client-side query rewriting) rather than dynamic database Attribute Promotion to query nested JSON safely ([ADR-0006](./adrs/0006-attribute-projection-over-attribute-promotion.md)).
- **Dynamic Configuration**: Admin settings (like alert thresholds) use an Append-Only Configuration Stream in ClickHouse, with Redis Pub/Sub providing memory-speed invalidation for active workers ([ADR-0015](./adrs/0015-control-plane-configuration-architecture.md)).
- **Implicit Processing Status**: Rather than explicitly mutating database status fields, a log's status (Raw, Normalized, Stored) is implicitly determined by its physical presence in the pipeline topics/tables, monitored via Prometheus metrics ([ADR-0024](./adrs/0024-implicit-log-processing-status.md)).

## 4. Alert Locking Mechanism
- **Alert Deduplication (Tumbling Window)**: Deduplication is performed by the Alert Consumer using an O(1) Redis counter (100 occurrences within a 60s tumbling window), ignoring interleaved INFO logs. It is keyed by deterministic Alert Fingerprints (App Name + Log Level + Error Code) ([ADR-0012](./adrs/0012-alert-fingerprints-for-deterministic-deduplication.md), [ADR-0023](./adrs/0023-tumbling-window-for-alert-deduplication.md)).
- **Telegram Rate Limiting**: Telegram notifications are protected by a global Redis token bucket (via Lua) to prevent API bans during catastrophic failures, with batching digest fallbacks ([ADR-0022](./adrs/0022-telegram-integration-and-rate-limiting.md)).

## 5. Real-time Log Viewer Subsystem
- **Live Stream Architecture**: We abandoned the flawed state-machine/compacted topic design. Instead, the Viewer's WebSocket server directly consumes the PII-scrubbed `logs-normalized` topic ([ADR-0019](./adrs/0019-abandon-pipeline-state-machine-for-live-stream.md)).
- **WebSocket Scaling**: The server scales horizontally using the Broadcast Consumer Pattern, where each replica generates an ephemeral consumer group ID to receive 100% of the `logs-normalized` traffic for in-memory fan-out ([ADR-0014](./adrs/0014-in-memory-materializer-for-websocket-scaling.md)).
- **Stateless App Ownership (RBAC)**: Display permissions are strictly enforced at the Edge using JWT claims (`app_grants`) verified entirely in-memory by the WebSocket server, supporting wildcards (`*`) for admins without database lookups ([ADR-0009](./adrs/0009-stateless-authorization-boundary.md), [ADR-0025](./adrs/0025-jwt-claim-based-rbac-for-app-ownership.md)).
- **Application Health Analytics**: Real-time analytical dashboards are powered by ClickHouse Materialized Views (AggregatingMergeTree engines), completely shielding the raw logs table from expensive `GROUP BY` queries ([ADR-0011](./adrs/0011-clickhouse-materialized-views-for-analytics.md)).

## 6. AI Integration & Bonus Features
- **AI Classification**: An AI Consumer reads from `logs-normalized` and writes ML-generated metadata into an append-only `log_ai_tags` Sidecar Table to prevent massive OLAP mutation penalties on the main logs table ([ADR-0008](./adrs/0008-sidecar-table-for-ai-metadata.md), [ADR-0017](./adrs/0017-pipeline-fan-out-for-ai-consumer.md)). It also emits lightweight patches to an `ai-tags-stream` for live UI badging ([ADR-0019](./adrs/0019-abandon-pipeline-state-machine-for-live-stream.md)).

## 7. Deployment Constraints
- **Modular Monolith**: All custom Rust services are compiled into a single multi-call binary and shipped in a single Docker image. In production, this image is deployed as isolated containers via role-based entrypoint flags (e.g., `--role receiver`) ([ADR-0013](./adrs/0013-deployment-model-single-binary-across-containers.md)).

## 8. Software Architecture & Implementation Guidelines
- **Code Architecture**: We utilize a Concrete Service-Oriented Architecture (SoA) rather than pure Clean Architecture. Abstractions (traits, HRTB) are defined locally within bounded contexts, preventing leaky abstractions and allowing us to directly leverage specific infrastructure features without heavy global interfaces ([ADR-0020](./adrs/0020-concrete-soa-over-clean-architecture.md)).
- **Pragmatic Performance**: In our multi-core async Rust environment, we favor multi-threaded work-stealing by defaulting to `Arc` over `Rc` (which breaks `tokio::spawn`). We prioritize standard owned `String` allocations, restricting zero-copy `Cow<'static, str>` strictly to extreme high-throughput hot paths to avoid lifetime contagion ([ADR-0021](./adrs/0021-pragmatic-performance-over-micro-optimizations.md)).
