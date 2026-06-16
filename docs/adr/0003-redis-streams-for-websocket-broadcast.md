# 0003. Use Redis Streams with Unique Consumer Groups for Real-time Broadcast

## Status
Accepted

## Context
The system requires a "Live Stream View" where logs are pushed to the frontend via WebSockets in real-time. Since we can have multiple WebSocket server instances to handle client load, we need a fan-out (broadcast) mechanism where every WebSocket server instance receives every log, so it can filter and push logs to its specific connected clients. 

## Decision
We will use a dedicated Redis Stream named `logs:parsed` for real-time broadcast:
1. **Producer:** As Workers process logs from the main ingestion queue, they will pipeline a write to the `logs:parsed` stream.
2. **Consumers (Stateless):** Every WebSocket server instance will perform a blocking read from the tail of the stream (`XREAD BLOCK 0 STREAMS logs:parsed $`). They will NOT use Consumer Groups. 
3. **Catch-up:** When a browser client connects, it fetches historical logs from TimescaleDB via an HTTP API. The WebSocket connection then provides a strictly ephemeral "Live Tail" of new events.
4. **Retention:** The `logs:parsed` stream will have a strict retention policy (`MAXLEN ~ 10000`) to prevent unbounded memory growth.

## Consequences
- **Positive:** Zero Redis memory overhead per WebSocket server instance (no pending entry lists or consumer group metadata).
- **Positive:** True fan-out architecture; every server instance sees every log, solving the load-balancing trap.
- **Positive:** Massively simplifies the WebSocket server logic (no `XACK`, no crash recovery, purely stateless).
- **Negative:** If a WebSocket server restarts, it relies entirely on the frontend client to query the database to fill any gap before establishing the new live tail.
