# Traceability Matrix

This matrix ensures that every technical decision recorded in the ADRs is accounted for within our System Boundaries, Functional Requirements, and Non-Functional Requirements.

| ADR | Decision Summary | Boundaries | Functional Req. | Non-Functional Req. | Note |
|---|---|---|---|---|---|
| 0001 | ClickHouse over standard SQL | [01-boundaries.md#4-clickhouse-tables](01-boundaries.md) | | | |
| 0002 | Custom Rust Workers for Ingestion | [01-boundaries.md#3-redpanda-topics](01-boundaries.md) | FR-002 | | |
| 0003 | Redpanda Native over MQ | [01-boundaries.md#3-redpanda-topics](01-boundaries.md) | | | |
| 0004 | Dedicated Redpanda topic for priority queue | [01-boundaries.md#3-redpanda-topics](01-boundaries.md) | FR-003 | | |
| 0005 | Strict schema policies on attributes | [01-boundaries.md#1-http-ingress-edge-receiver](01-boundaries.md) | FR-001 | | |
| 0006 | Attribute projection | [01-boundaries.md#4-clickhouse-tables](01-boundaries.md) | | | |
| 0007 | ClickHouse native TTL | [01-boundaries.md#4-clickhouse-tables](01-boundaries.md) | | NFR-002 | |
| 0008 | Sidecar table for AI metadata | [01-boundaries.md#4-clickhouse-tables](01-boundaries.md) | FR-006 | | |
| 0009 | Stateless authorization boundary | [01-boundaries.md#1-http-ingress-edge-receiver](01-boundaries.md), [01-boundaries.md#2-websocket-ingress-real-time-viewer](01-boundaries.md) | | | |
| 0010 | Dedicated edge receiver service | [01-boundaries.md#1-http-ingress-edge-receiver](01-boundaries.md) | | | |
| 0011 | ClickHouse materialized views | [01-boundaries.md#4-clickhouse-tables](01-boundaries.md) | | | |
| 0012 | Alert fingerprints | [01-boundaries.md#3-redpanda-topics](01-boundaries.md) | | | |
| 0013 | Deployment model single binary | | | | **Flagged**: Deployment concern, no explicit software boundary/FR mapped. |
| 0014 | In-memory materializer for WebSocket | [01-boundaries.md#2-websocket-ingress-real-time-viewer](01-boundaries.md) | FR-005 | NFR-004 | |
| 0015 | Control plane configuration | [01-boundaries.md#6-control-plane-endpoints](01-boundaries.md) | | | |
| 0016 | Attribute flattening at edge | [01-boundaries.md#1-http-ingress-edge-receiver](01-boundaries.md) | FR-001 | | |
| 0017 | Pipeline fan-out for AI consumer | [01-boundaries.md#3-redpanda-topics](01-boundaries.md) | | | |
| 0018 | Dead letter queue | [01-boundaries.md#3-redpanda-topics](01-boundaries.md) | FR-002 | | |
| 0019 | Abandon pipeline state machine | [01-boundaries.md#2-websocket-ingress-real-time-viewer](01-boundaries.md) | FR-005 | | |
| 0020 | Concrete SoA | | | | **Flagged**: Architecture concern, no explicit behavioral mapping. |
| 0021 | Pragmatic performance | | | NFR-005 | |
| 0022 | Telegram integration and rate limiting | [01-boundaries.md#5-telegram-webhooks](01-boundaries.md) | FR-004 | NFR-003 | |
| 0023 | Tumbling window for alert deduplication| | FR-004 | | |
| 0024 | Implicit log processing status | | FR-001, FR-002 | | |
| 0025 | JWT claim-based RBAC | [01-boundaries.md#1-http-ingress-edge-receiver](01-boundaries.md), [01-boundaries.md#2-websocket-ingress-real-time-viewer](01-boundaries.md) | FR-005 | | |
