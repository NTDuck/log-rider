# Disambiguated Requirements & Architecture

This document synthesizes the original functional and technical requirements for the Log Collection and Application Error Monitoring System, incorporating the disambiguations and technical decisions recorded in the ADRs.

## 1. High-Speed Ingestion Matrix
- **Edge Receiver API**: A dedicated, lightweight Edge Receiver (Rust, Axum/Tonic) terminates external HTTP/gRPC connections, performs OTLP flattening at the edge ([ADR-0019](./adr/0019-attribute-flattening-at-the-edge.md)), and acts as a dumb pipe pushing raw payloads to Redpanda ([ADR-0011](./adr/0011-dedicated-edge-receiver-service.md)).
- **Message Broker**: We rely exclusively on Redpanda (no generic MQ abstractions) for all stream buffering ([ADR-0003](./adr/0003-redpanda-native-over-mq-abstraction.md)).

## 2. Log Parsing & Filtering Engine
- **Custom Rust Workers**: Dedicated workers consume from `logs-raw`, perform CPU-heavy cleaning, and enforce Strict Schema Policies (max 5 depth, 64KB size, homogenous arrays) to protect the database ([ADR-0002](./adr/0002-custom-rust-workers-for-ingestion.md), [ADR-0005](./adr/0005-strict-schema-policies-on-attributes.md)).
- **Dead Letter Queue (DLQ)**: Poison pills (malformed payloads) are sent to `logs-dlq` to prevent infinite retry loops and partition blocking ([ADR-0021](./adr/0021-dead-letter-queue-for-poison-pills.md)).
- **Pipeline Fan-Out**: Once scrubbed of PII, logs are published to `logs-normalized` for independent downstream consumption ([ADR-0020](./adr/0020-pipeline-fan-out-for-ai-consumer.md)).
- **Alert Priority Queue**: When workers detect `ERROR` or `CRITICAL` logs, they duplicate them into a dedicated `alerts-priority-stream` topic, isolating alerts from the main ingestion loop ([ADR-0004](./adr/0004-dedicated-redpanda-topic-for-priority-queue.md)).

## 3. Log Asset Management & Storage
- **Primary Database**: ClickHouse is the OLAP database used for massive batch writes and historical analytical reads ([ADR-0001](./adr/0001-clickhouse-over-standard-sql.md)).
- **Log Retention Policy**: Log cleanup is managed strictly via ClickHouse native TTL rules (e.g., deleting INFO logs older than 7 days) deployed via infrastructure-as-code ([ADR-0008](./adr/0008-clickhouse-native-ttl-for-retention.md)).
- **Schema Optimization**: We use Attribute Projection (client-side query rewriting) rather than dynamic database Attribute Promotion to query nested JSON safely ([ADR-0006](./adr/0006-attribute-projection-over-attribute-promotion.md)).
- **Dynamic Configuration**: Admin settings (like alert thresholds) use an Append-Only Configuration Stream in ClickHouse, with Redis Pub/Sub providing memory-speed invalidation for active workers ([ADR-0014](./adr/0014-dynamic-configuration-via-redis-pubsub.md), [ADR-0018](./adr/0018-control-plane-configuration-architecture.md)).

## 4. Alert Locking Mechanism
- **Alert Deduplication**: Deduplication is performed by the Alert Consumer using Redis counters keyed by deterministic Alert Fingerprints (App Name + Log Level + Error Code) rather than hashing raw payloads ([ADR-0013](./adr/0013-alert-fingerprints-for-deterministic-deduplication.md)).

## 5. Real-time Log Viewer Subsystem
- **Live Stream Architecture**: We abandoned the flawed state-machine/compacted topic design ([ADR-0007](./adr/0007-event-driven-compacted-topic-for-live-stream.md), [ADR-0015](./adr/0015-delta-updates-on-log-status-topic.md)). Instead, the Viewer's WebSocket server directly consumes the PII-scrubbed `logs-normalized` topic ([ADR-0022](./adr/0022-abandon-pipeline-state-machine-for-live-stream.md)).
- **WebSocket Scaling**: The server scales horizontally using the Broadcast Consumer Pattern, where each replica generates an ephemeral consumer group ID to receive 100% of the `logs-normalized` traffic for in-memory fan-out ([ADR-0017](./adr/0017-in-memory-materializer-for-websocket-scaling.md)).
- **Stateless Authorization**: Display permissions are strictly enforced at the Edge using JWT claims verified entirely in-memory by the WebSocket server ([ADR-0010](./adr/0010-stateless-authorization-boundary.md)).
- **Application Health Analytics**: Real-time analytical dashboards are powered by ClickHouse Materialized Views (AggregatingMergeTree engines), completely shielding the raw logs table from expensive `GROUP BY` queries ([ADR-0012](./adr/0012-clickhouse-materialized-views-for-analytics.md)).

## 6. AI Integration & Bonus Features
- **AI Classification**: An AI Consumer reads from `logs-normalized` and writes ML-generated metadata into an append-only `log_ai_tags` Sidecar Table to prevent massive OLAP mutation penalties on the main logs table ([ADR-0009](./adr/0009-sidecar-table-for-ai-metadata.md), [ADR-0020](./adr/0020-pipeline-fan-out-for-ai-consumer.md)). It also emits lightweight patches to an `ai-tags-stream` for live UI badging ([ADR-0022](./adr/0022-abandon-pipeline-state-machine-for-live-stream.md)).

## 7. Deployment Constraints
- **Modular Monolith**: All custom Rust services are compiled into a single multi-call binary and shipped in a single Docker image. In production, this image is deployed as isolated containers via role-based entrypoint flags (e.g., `--role receiver`) ([ADR-0016](./adr/0016-deployment-model-single-binary-across-containers.md)).
