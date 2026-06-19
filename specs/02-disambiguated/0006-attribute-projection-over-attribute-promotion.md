# 0006. Attribute Projection Over Attribute Promotion

## Status
Accepted

## Context
Frequently queried nested JSON fields need to be optimized for read performance. We considered "Attribute Promotion" (the ingestion pipeline dynamically extracting fields into new columns), but it risks race conditions with database schema migrations.

## Decision
We will use "Attribute Projection" at the Viewer layer, which transparently rewrites user queries to map logical paths to database syntax. The burden of extracting high-performance fields is shifted to the client applications (via helper libraries) during log creation.

## Consequences
- **Positive**: Keeps the ingestion pipeline "dumb" and free of complex schema migration logic.
- **Positive**: Avoids race conditions between Rust workers and ClickHouse `ALTER TABLE` statements.
- **Negative**: Clients must be proactive about flattening their most critical fields for optimal query performance.
