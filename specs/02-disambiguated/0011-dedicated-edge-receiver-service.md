# 0011. Dedicated Edge Receiver Service

## Status
Accepted

## Context
Logs arrive via HTTP/HTTPS and gRPC/OTLP endpoints. Combining network connection handling and protocol translation with CPU-intensive log normalization in the same Worker couples I/O wait times with processing limits.

## Decision
We will introduce a dedicated Edge Receiver service. This lightweight Rust service will handle the raw network ingestion and protocol translation, pushing standardized payloads to a `logs-raw` topic.

## Consequences
- **Positive**: Keeps the core Worker pure and focused strictly on business logic and normalization.
- **Positive**: Allows independent scaling of the network ingress layer vs. the CPU-heavy normalization layer.
- **Negative**: Adds an additional microservice and topic (`logs-raw`) to the deployment footprint.
