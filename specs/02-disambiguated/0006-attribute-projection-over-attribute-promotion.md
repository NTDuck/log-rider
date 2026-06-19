# 0006. Attribute Projection Over Attribute Promotion

## Status
Accepted

## Context
With the introduction of structured JSON `Attributes` for logs, we face a performance challenge: searching deep within nested JSON fields in ClickHouse is computationally slower than querying a top-level, dedicated column. 

The initial design proposed an "Attribute Promotion" configuration API. If an attribute appeared in a `WHERE` clause frequently (e.g., `attributes.http.status`), the API would automatically "promote" it to a dedicated root-level column without requiring client-side code changes.

However, implementing Attribute Promotion introduces severe architectural friction:
- **Worker-Side Promotion**: If the Rust Worker dynamically checks a configuration store to pull `http.status` out of the JSON and rewrite its batch `INSERT` statement, we introduce dynamic SQL generation into our high-speed ingestion loop. Worse, if the Worker adds the column to the `INSERT` statement before the ClickHouse `ALTER TABLE ADD COLUMN` migration finishes, the batch fails due to a schema mismatch.
- **Database-Side Promotion**: While ClickHouse can extract columns via `ALTER TABLE ... MATERIALIZED`, managing these stateful schema changes dynamically based on usage statistics is complex and risky to automate in a high-throughput production environment.

## Decision
We will completely discard "Attribute Promotion" from our requirements. Instead, we will implement **"Attribute Projection"**. 

Attribute Projection is a Viewer-layer SQL rewriting system. It transparently maps logical nested JSON paths from user queries into their actual database syntax or pre-existing aliased columns. The ingestion Worker remains a "dumb, fast pipe" that simply inserts the JSON it receives. We explicitly shift the burden of schema optimization to the client.

## Alternatives Considered
- **Worker-Side Attribute Promotion**: Rejected. Introduces dynamic SQL generation into a critical performance path and risks fatal race conditions with database schema migrations.
- **ClickHouse Materialized Columns (Automated)**: Rejected as a primary automated feature due to the complexity of safely mutating production database schemas on the fly. We will, however, document ClickHouse's native `PROJECTION` feature as a manual optimization for power users.

## Consequences
- **Positive**: Completely eliminates the risk of race conditions between Rust ingestion workers and ClickHouse schema migrations.
- **Positive**: Adheres strictly to the "dumb pipes, smart endpoints" philosophy. The ingestion system remains incredibly fast and simple.
- **Positive**: The Viewer layer can safely handle query rewriting without touching the underlying database schema.
- **Negative**: Clients bear the burden of optimization. For maximum query performance, developers must proactively extract their most frequently filtered fields into root-level key-value pairs during log ingestion, aided by our provided helper libraries. As a general heuristic, any attribute that appears in a `WHERE` clause more than 5% of the time should be extracted.
