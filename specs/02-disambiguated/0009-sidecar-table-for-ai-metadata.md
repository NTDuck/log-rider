# 0009. Sidecar Table for AI Metadata

## Status
Accepted

## Context
An AI-powered log analysis worker will classify logs asynchronously. Appending these generated tags to the original log records using `UPDATE` queries in ClickHouse is a massive anti-pattern that destroys performance.

## Decision
We will isolate ML metadata into a separate, append-only `log_ai_tags` sidecar table. The AI Consumer will write tags here independently, strictly prohibiting `UPDATE` queries on the primary log table.

## Consequences
- **Positive**: Preserves ClickHouse's append-only performance profile.
- **Positive**: Decouples the AI inference speed from the primary ingestion pipeline.
- **Negative**: Requires analytical queries in the Viewer to perform `JOIN`s between the primary table and the sidecar table when filtering by AI tags.
