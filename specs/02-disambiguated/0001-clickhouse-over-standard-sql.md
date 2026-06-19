# 0001. Use ClickHouse Over Standard SQL for Log Storage

## Status
Accepted

## Context
The system was presented with a foundational requirement to build a "Log Collection and Application Error Monitoring System" capable of surviving a high-load API (e.g., 500+ logs per second) while executing `INSERT` statements into a "SQL DB" and providing a "Real-time Log Viewer Subsystem". 

During the initial design phase, there was an inclination to use off-the-shelf log aggregators like Loki paired with Grafana for the dashboard to quickly satisfy the monitoring and deduplication requirements. However, relying on Loki and Grafana would completely bypass the core systems engineering challenge of designing a database schema optimized for fast writing and building a custom real-time frontend. 

Furthermore, research and case studies (e.g., Bank Raya's case study) indicated that Loki performs poorly under heavy, concurrent workloads and has limited vertical scalability, making it unsuitable for the extreme write throughput expected from the ingestion matrix.

The system needed a database that could:
1. Sustain extreme write throughput without crashing.
2. Support SQL syntax to satisfy the explicit "SQL DB" requirement.
3. Allow for fast analytical queries on massive datasets to power the custom Viewer.

## Decision
We will use **ClickHouse**, an OLAP (Online Analytical Processing) and Time-Series database, as the primary datastore instead of a standard transactional SQL database (like PostgreSQL without extensions) or NoSQL log aggregators like Loki.

## Alternatives Considered
- **Loki + Grafana**: Rejected. Bypasses the core architectural challenge of building the system, performs poorly under heavy concurrent write loads, and has limited vertical scalability.
- **InfluxDB**: Considered alongside ClickHouse. However, InfluxDB is natively a NoSQL Time Series Database using Flux/InfluxQL, which strictly violates the original constraint of executing standard `INSERT` statements into a SQL DB.
- **Standard Transactional SQL (e.g., MySQL, PostgreSQL)**: Rejected. Traditional ACID-compliant transactional databases are not designed for the sheer volume of continuous append-only log ingestion and would quickly become a bottleneck, crashing under the high write load.
- **PostgreSQL with TimescaleDB**: Considered as a valid SQL alternative, but ClickHouse provides unparalleled batch insert performance and native support for complex data types (Maps/JSON) which will be critical for structured logging.

## Consequences
- **Positive**: ClickHouse provides exceptional write throughput (via batch inserts) and lightning-fast analytical read performance, perfectly aligning with the log aggregation use case.
- **Positive**: Satisfies the explicit "SQL DB" constraint since ClickHouse supports a SQL dialect for both ingestion and querying.
- **Positive**: We own the entire ingestion, storage, and presentation layer, successfully meeting the systems engineering challenge without relying on third-party black boxes.
- **Positive**: Native support for `Map` and `JSON` data types in ClickHouse lays the foundation for high-performance structured logging.
- **Negative**: We sacrifice standard ACID transactions. While unnecessary for immutable, append-only log data, it represents a paradigm shift from traditional relational database assumptions.
- **Negative**: ClickHouse performs exceptionally poorly with high-frequency, concurrent small reads (e.g., polling every 500ms). This requires us to build a completely separate, non-database solution for the real-time Live Stream View to avoid melting the database cluster.
