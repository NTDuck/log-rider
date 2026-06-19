# 0017. In-Memory Materializer for WebSocket Scaling

## Status
Accepted

## Context
Thousands of engineers connecting to the Live Stream Viewer cannot each spawn their own direct consumer to Redpanda, as this would quickly overwhelm the broker with connection and rebalancing overhead.

## Decision
We will use the WebSocket server as an in-memory materializer. The server will run a single shared consumer reading the topic tail, build an in-memory map of logs, and FANOUT updates to all connected clients applying their specific filters in-memory.

## Consequences
- **Positive**: Shields Redpanda from client connection scaling; 10,000 users still only equals 1 consumer at the broker level.
- **Positive**: Sub-millisecond filtering performance.
- **Negative**: Higher RAM requirements on the WebSocket server to maintain the rolling buffer of recent logs.
