# 0009. Sidecar Table for AI Metadata

## Status
Accepted

## Context
An AI-powered log analysis worker is required to classify logs and attach ML-generated metadata (e.g., anomaly scores and tags) to the log records.
The initial plan proposed that after a log is written to the database with a `null` tag field, an asynchronous AI background job would query the DB for "logs where tags is null", perform inference, and then execute an `UPDATE` query to attach the new tags. This introduces a heavy polling mechanism, which we explicitly banned when designing the Live Viewer.
However, ClickHouse is an append-only OLAP database. Standard row-level `UPDATE` statements are not supported directly and require `ALTER TABLE ... UPDATE` commands, which trigger heavy asynchronous rewrites of entire data parts on disk. Executing thousands of updates per hour would heavily penalize performance, fragment the storage, and eventually cause the cluster to grind to a halt.
Two alternatives were considered to avoid OLAP mutations:
1. **Option A (Pre-DB Streaming approach):** The AI Consumer reads from Redpanda, runs the model, and attaches tags *before* the log is batch-inserted into ClickHouse. Rejected because AI inference is inherently slow; placing it inline before insertion risks bottlenecking the entire ingestion pipeline and causing logs to pile up in the broker.
2. **Option B (Sidecar Table approach):** The ingestion pipeline inserts raw logs instantly. The AI Consumer asynchronously reads from the `log-status` topic, runs inference, and writes results into a completely separate, append-only table.

## Decision
We will isolate ML metadata into a separate, append-only `log_ai_tags` sidecar table (Option B). 
The AI Consumer will consume from the Redpanda stream, perform its inference (e.g., using a small HuggingFace model via an ONNX runtime in Rust), and write tags strictly as new `INSERT` statements into this sidecar table. We explicitly prohibit any `UPDATE` queries on the primary log table.

## Consequences
- **Positive**: Completely preserves ClickHouse's append-only performance profile and protects the database from heavy rewrite penalties.
- **Positive**: Decouples the slower AI inference process from the primary lightning-fast ingestion pipeline. The worker can act as a dumb, fast pipe.
- **Negative**: Requires analytical queries in the Viewer to perform `JOIN`s on `Log_ID` between the primary table and the sidecar table when a user wants to filter logs by AI tags.
