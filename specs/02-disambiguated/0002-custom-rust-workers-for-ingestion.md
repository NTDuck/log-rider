# 0002. Custom Rust Workers for Ingestion

## Status
Accepted

## Context
Log ingestion requires parsing, normalisation, and routing of logs from the message queue to the database. We considered using off-the-shelf tools like Telegraf or Logstash to stream data directly into the database.

## Decision
We will build custom Rust Workers to consume from the message broker, apply normalisation policies, and execute batch inserts into the database, rejecting standard ecosystem tools.

## Consequences
- **Positive**: Absolute control over batching semantics, memory allocation, and specific business logic.
- **Positive**: Enables complex custom routing, such as instantly forwarding CRITICAL logs to a separate alerting pipeline.
- **Negative**: Increased development time and maintenance burden compared to configuring an off-the-shelf data collector.
