# 0007. Event-Driven Compacted Topic for Live Stream

## Status
Accepted

## Context
The Viewer requires a "Live Stream View" of log status updates. Since ClickHouse performs poorly with high-frequency, small read queries, polling the database every 500ms for updates is not viable.

## Decision
We will use an event-driven architecture with a dedicated `log-status` compacted Redpanda topic. The WebSocket server will consume this topic and maintain an in-memory map of state, pushing updates to clients. Eviction will be handled via mandatory Tombstones.

## Consequences
- **Positive**: Sub-millisecond latency for real-time status updates without hitting the database.
- **Positive**: ClickHouse is entirely spared from live-polling read load, preserving its performance for heavy analytical batch queries.
- **Negative**: Introduces complexity in managing a compacted topic and ensuring all services correctly publish Tombstones to prevent infinite state growth in Redpanda.
