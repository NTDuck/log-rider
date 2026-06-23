# 0007. Event-Driven Compacted Topic for Live Stream

## Status
Accepted

## Context
The functional requirements specify a "Real-time Log Viewer Subsystem" that displays a continuous, real-time live stream of logs, supporting quick filtering without page reloads.

Because we selected ClickHouse as our primary storage, we inherited a massive architectural constraint: ClickHouse is an OLAP database optimized for massive batch writes and heavy analytical reads. It is fundamentally **not** a real-time push database. 

If the Viewer backend attempted to simulate a "live stream" by executing a `SELECT * FROM logs WHERE timestamp > last_seen` query against ClickHouse every 500 milliseconds for hundreds of connected engineers, it would completely destroy the database's performance. ClickHouse severely degrades under high-frequency, tiny, concurrent read queries.

Furthermore, a log's lifecycle involves multiple asynchronous stages (`RAW` -> `PROCESSED` -> `STORED` -> `CATEGORIZED`). Displaying these real-time status transitions requires tracking mutations, which OLAP databases handle poorly.

## Decision
We will build an **Event-Driven Status Pipeline** utilizing a dedicated **compacted Redpanda topic (`log-status`)**, completely bypassing the database for real-time live views. The Live Stream View acts as a distributed state-machine dashboard tracking a single log's lifecycle across 4 asynchronous stages (`RAW` -> `PROCESSED` -> `STORED` -> `CATEGORIZED`).

The architecture functions as follows:
1. Every service in the pipeline (Ingestion, Normalizer, DB Writer, AI Categorizer) publishes lightweight status update events to the `log-status` compacted topic. The exact payload format is `Key = Log_ID`, `Value = { status: "raw|processed|stored|categorized", timestamp, payload }`.
2. The Viewer's WebSocket server maintains a *single shared consumer* reading from the tail of this topic. On connection, the consumer reads the **last 100 messages** from the topic tail to instantly populate the UI without a database query.
3. The server builds an in-memory map of log states and fans out lightweight `PATCH` events to connected clients, applying user-specific filters in-memory. The client-side updates only the badge/status column, minimizing bandwidth. The in-memory overwrite handles out-of-order arrivals (e.g., "stored" arriving before "processed" due to network lag).
4. ClickHouse receives only finalized logs via batch micro-batches (every 5 seconds) from the DB Writer. ClickHouse is strictly reserved for historical, analytical queries (e.g., when a user scrolls up).
5. **Terminal State Eviction**: To prevent memory and disk leaks, once the WebSocket server pushes the final PATCH event (STORED or CATEGORIZED), it waits 5 seconds to handle out-of-order packets and then strictly deletes that `Log_ID` from its in-memory map. Concurrently, the final service in the pipeline emits a **Tombstone message** (Log_ID key, `null` payload) to the `log-status` topic after a short delay (e.g., 1 minute). Redpanda's compactor physically deletes the key.

## Alternatives Considered
- **Polling ClickHouse every 500ms**: Rejected. Catastrophic for OLAP performance. High-frequency tiny concurrent reads destroy performance.
- **WebSocket server reading directly from ClickHouse mutations**: Rejected. ClickHouse mutations are highly asynchronous, causing the UI to drastically lag behind reality.
- **Per-client Redpanda consumers**: Rejected. Spinning up a dedicated Kafka consumer for every connected engineer (potentially thousands) would overwhelm the Redpanda broker. A single shared consumer ensures 10,000 engineers don't mean 10,000 consumers.

## Consequences
- **Positive**: Sub-millisecond latency for real-time log ingestion and status updates presented directly to the user.
- **Positive**: The single shared consumer pattern prevents broker overload, and in-memory filtering eliminates database round-trips entirely. FANOUT pattern minimizes network traffic.
- **Positive**: ClickHouse is completely shielded from live-polling load, allowing it to dedicate its resources to massive bulk inserts and heavy historical aggregations.
- **Positive**: Terminal Tombstones close the lifecycle loop. The WebSocket server avoids memory exhaustion and Redpanda prevents disk bloat with stale state data.
- **Negative**: Adds architectural complexity. Services must strictly adhere to publishing status updates and firing mandatory Tombstones.
