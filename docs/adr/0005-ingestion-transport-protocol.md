# 0005. Ingestion Transport Protocol

## Status
Accepted

## Context
The system must ingest logs at high speed (initially hundreds per second, potentially scaling to tens of thousands). We need to select the transport protocol and data format for the ingestion API that balances integration simplicity with processing efficiency.

## Decision
We will adopt a two-phased approach for the Ingestion API:

1. **Phase 1 (Current): HTTP/JSON REST**
   - The primary endpoint will be `/api/v1/ingest` accepting `POST` requests with JSON payloads.
   - It will utilize HTTP Keep-Alive for connection pooling to reduce overhead.
   - Validation failures (missing required fields) will return `HTTP 422`. Successful enqueues to Redis will return `HTTP 202`.
   - This ensures the easiest possible integration for existing scripts, web apps, and legacy systems.

2. **Phase 2 (Future): gRPC / OTLP**
   - We will expose a secondary gRPC endpoint on a separate port specifically supporting the OpenTelemetry (OTLP) standard.
   - This endpoint will share the exact same internal Rust logic for inserting into the Redis Stream.
   - This enables high-performance, binary-packed ingestion from modern microservices and direct integration with tools like Grafana Alloy.

## Consequences
- **Positive:** Phase 1 delivers maximum developer ergonomics and ease of demonstration.
- **Positive:** The architecture remains open for Phase 2 without requiring breaking changes or a separate ingestion service.
- **Negative:** JSON parsing in Phase 1 requires slightly more CPU than binary formats, but this is mitigated by Rust's zero-copy deserialization (Serde).
