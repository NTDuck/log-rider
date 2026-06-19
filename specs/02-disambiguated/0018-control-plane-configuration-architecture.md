# 0018. Control Plane Configuration Architecture

## Status
Accepted

## Context
To manage thresholds and application state across a highly decoupled pipeline, we require a Control Plane that avoids split-brain scenarios but remains highly performant.

## Decision
ClickHouse will act as the append-only source of truth for dynamic configurations, warming the stateless consumers (like the Alert Consumer) on boot. Redis Pub/Sub will exclusively handle real-time cache invalidation and hot-reloading during runtime.

## Consequences
- **Positive**: Solidifies the architecture by cleanly separating durable configuration storage (ClickHouse) from ephemeral signaling (Redis).
- **Positive**: Services boot reliably from a cold state without depending on transient Redis data.
- **Negative**: Increases the complexity of service startup routines.
