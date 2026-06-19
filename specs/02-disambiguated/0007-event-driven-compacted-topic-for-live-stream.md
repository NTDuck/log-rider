# 0007. Event-Driven Compacted Topic for Live Stream

## Status
Accepted

## Context
The functional requirements specify a "Real-time Log Viewer Subsystem" that displays a continuous, real-time live stream of logs, supporting quick filtering without page reloads.

Because we selected ClickHouse as our primary storage, we inherited a massive architectural constraint: ClickHouse is an OLAP database optimized for massive batch writes and heavy analytical reads. It is fundamentally **not** a real-time push database. 

If the Viewer backend attempted to simulate a "live stream" by executing a `SELECT * FROM logs WHERE timestamp > last_seen` query against ClickHouse every 500 milliseconds for hundreds of connected engineers, it would completely destroy the database's performance. ClickHouse severely degrades under high-frequency, tiny, concurrent read queries.

Furthermore, a log's lifecycle involves multiple asynchronous stages (`RAW` -> `PROCESSED` -> `STORED` -> `CATEGORIZED`). Displaying these real-time status transitions requires tracking mutations, which OLAP databases handle poorly.

## Decision
We will build an **Event-Driven Status Pipeline** utilizing a dedicated **compacted Redpanda topic (`log-status`)**, completely bypassing the database for real-time live views.

The architecture functions as follows:
1. Every service in the pipeline (Ingestion, Normalizer, DB Writer) publishes lightweight status update events (`Log_ID -> status, payload`) to the `log-status` compacted topic.
2. The Viewer's WebSocket server maintains a *single shared consumer* reading from the tail of this topic.
3. The server builds an in-memory map of log states and fans out lightweight `PATCH` events to connected clients, applying user-specific filters in-memory.
4. ClickHouse is strictly reserved for historical, analytical queries (e.g., when a user scrolls up to view yesterday's logs).

## Alternatives Considered
- **Polling ClickHouse every 500ms**: Rejected. Catastrophic for OLAP performance.
- **WebSocket server reading directly from ClickHouse mutations**: Rejected. ClickHouse mutations are highly asynchronous, causing the UI to drastically lag behind reality.
- **Per-client Redpanda consumers**: Rejected. Spinning up a dedicated Kafka consumer for every connected engineer (potentially thousands) would overwhelm the Redpanda broker.

## Consequences
- **Positive**: Sub-millisecond latency for real-time log ingestion and status updates presented directly to the user.
- **Positive**: The single shared consumer pattern prevents broker overload, and in-memory filtering eliminates database round-trips entirely.
- **Positive**: ClickHouse is completely shielded from live-polling load, allowing it to dedicate its resources to massive bulk inserts and heavy historical aggregations.
- **Negative**: Adds architectural complexity. Services must strictly adhere to publishing status updates, and we must carefully manage the compacted topic (including firing mandatory Tombstones) to ensure the Redpanda topic doesn't grow infinitely in memory.
