# 0011. Dedicated Edge Receiver Service

## Status
Accepted

## Context
The high-load ingestion API must allow external client applications to continuously send logs using both HTTP/HTTPS and gRPC/OTLP protocols. 
However, the primary ingestion broker (Redpanda/Kafka) does not natively speak OTLP or standard HTTP/HTTPS. Allowing thousands of external client applications to open native TCP connections directly to the infrastructure broker is a massive security and connection-pooling risk.
Furthermore, if we combined the HTTP/gRPC API termination into the same custom Rust Worker responsible for the heavy lifting (JSON normalization, policy enforcement, and database batch insertions), we would tightly couple network I/O wait times with CPU-bound processing limits. A spike in external connections or a DDoS attack could starve the workers of the CPU needed to process the logs.

## Decision
We will introduce a dedicated, lightweight Edge Receiver service (API Gateway) built in Rust (utilizing Axum for HTTP and Tonic for gRPC). 
This service will be strictly responsible for:
1. Terminating external connections and accepting payloads.
2. Authenticating clients (e.g., verifying API keys).
3. Performing Canonical Translation to map various external formats (like OTLP Protobuf or custom HTTP JSON) into our internal `StructuredLog` struct.
4. Acting as a pure, high-speed Kafka Producer that instantly proxies the mapped payloads into the Redpanda broker and returns a `202 Accepted` response.

## Consequences
- **Positive**: Keeps the core Worker pure and focused strictly on CPU-heavy business logic, normalization, and DB insertions.
- **Positive**: Provides horizontal scalability specifically for the network ingress layer, independent of the processing layer.
- **Positive**: Protects internal infrastructure from direct external access, improving security and connection management resilience.
- **Negative**: Adds an additional microservice to maintain and introduces a `logs-raw` topic to the deployment footprint, slightly increasing infrastructure complexity.
