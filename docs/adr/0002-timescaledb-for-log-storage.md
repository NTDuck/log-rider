# 0002. Use TimescaleDB for Log Storage

## Status
Accepted

## Context
We need a persistent SQL database capable of sustaining high write throughput for incoming logs, while also supporting fast analytical queries for the dashboard and efficient log retention policies (e.g., dropping or compressing logs older than 7 days). Traditional relational tables struggle with high-volume, append-only time-series data at scale.

## Decision
We will use **TimescaleDB** (running on PostgreSQL 16) as our primary log store. 

Specifically:
- **Batching**: Workers will pull logs from Redis Streams and insert them in batches of 100-500 rows per transaction to maximize write throughput.
- **Hypertables**: The `logs` table will be converted into a TimescaleDB Hypertable, partitioned by `Timestamp` into 1-day chunks.
- **Indexing**: 
  - A composite B-tree index on `(Application_Name, Log_Level, Timestamp)` to support fast dashboard filtering.
  - A BRIN index on `Timestamp` for efficient large-range time scans.
- **Retention**: We will utilize TimescaleDB's native continuous aggregates and retention policies to automatically compress or drop `INFO` level logs older than 7 days, avoiding heavy `DELETE` queries.

## Consequences
- **Positive**: Provides the familiarity and querying power of SQL while delivering NoSQL-like write performance for time-series data.
- **Positive**: Native, zero-maintenance log retention and compression features solve the disk-space requirement elegantly.
- **Positive**: Chunking by time means most recent inserts stay in memory, keeping writes fast.
- **Negative**: Adds a TimescaleDB extension dependency (using `timescale/timescaledb:latest-pg16`), slightly increasing the database memory footprint compared to vanilla PostgreSQL.
