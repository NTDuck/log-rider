# 0017. In-Memory Materializer for WebSocket Scaling

## Status
Accepted

## Context
A critical functional requirement is the "Real-time Log Viewer Subsystem": a live dashboard for operations engineers to monitor a continuous, real-time log stream filtered by application or error level without page reloads. The system must support high concurrency, potentially up to 10,000 connected engineers.

In previous decisions, we chose to utilize a dedicated Redpanda topic (`log-status`) to track the real-time state of log pipelines. 

## Alternatives Considered & The Debate
We analyzed how the WebSocket server should connect the Redpanda stream to the engineers' browsers.

1. **Per-Client Redpanda Consumers (Rejected)**
   Spawn a new Redpanda consumer for every connected WebSocket client. 
   *Why it was rejected:* Kafka/Redpanda are not designed to handle tens of thousands of ephemeral, rapidly connecting/disconnecting consumers. 10,000 engineers spinning up 10,000 consumer groups would immediately overwhelm the broker with connection state and consumer group rebalancing overhead, taking down the messaging cluster.

2. **Database Polling (Rejected)**
   Have the WebSocket server periodically query ClickHouse (e.g., `SELECT * WHERE timestamp > X`).
   *Why it was rejected:* ClickHouse is an OLAP database optimized for massive batch inserts and heavy analytical reads, not sub-second polling. High-frequency, tiny concurrent reads would destroy its performance.

3. **In-Memory Materializer and FANOUT (Accepted)**
   Treat the WebSocket server as an in-memory stream materializer. The server runs a **single shared Redpanda consumer** that tails the `log-status` topic. It maintains a rolling in-memory map of logs. When a new log arrives, the server performs a FANOUT operation, evaluating the log against the in-memory filters of all 10,000 connected clients, and pushing the update only to those who match.

## Decision
We will use the WebSocket server as an **In-Memory Materializer** using the FANOUT pattern. The server acts as a Stateless Broadcast Consumer, reading from Redpanda exactly once on behalf of all users, and fanning out the data dynamically.

When an engineer connects, the server serves the last 100 messages from its memory buffer instantly, and then seamlessly transitions to live streaming. 

## Consequences
- **Positive**: Shields the Redpanda cluster from client connection scaling. Whether there is 1 user or 10,000 users, there is only 1 consumer connection at the broker level.
- **Positive**: Eliminates database load entirely for live-tail scenarios. ClickHouse is reserved purely for historical batch analytics.
- **Positive**: Sub-millisecond filtering performance because all `App_X` and `INFO/ERROR` level routing is done purely in CPU memory.
- **Negative**: Higher RAM requirements on the WebSocket server nodes, as they must maintain the rolling buffer of recent logs and client filter states. Memory bounds must be carefully engineered to prevent OOM errors.
