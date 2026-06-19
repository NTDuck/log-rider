# 0001. Use ClickHouse Over Standard SQL for Log Storage

## Status
Accepted

## Context
The log collection system needs to sustain extreme write throughput and support fast analytical queries on massive datasets. The original requirements called for a standard SQL database optimized for fast writing.

## Decision
We will use ClickHouse (an OLAP/Time-Series database) natively instead of a standard transactional SQL database.

## Consequences
- **Positive**: Exceptional write throughput and analytical read performance perfectly suited for log aggregation.
- **Positive**: Native support for Map and JSON data types enables structured logging out of the box.
- **Negative**: Sacrifices standard ACID transactions, which are unnecessary for append-only log data but represent a departure from traditional SQL assumptions.
- **Negative**: High-frequency, concurrent small reads perform poorly, requiring alternative solutions for real-time streaming.
