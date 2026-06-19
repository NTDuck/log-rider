# 0018. Control Plane Configuration Architecture

## Status
Accepted

## Context
The system is heavily decoupled, consisting of an Edge Receiver, Normalization Workers, DB Writers, AI Consumers, and an Alert Consumer. These stateless services rely on dynamic configurations configured by System Admins (e.g., alert thresholds, deduplication rules, schema guardrails, attribute projection rules). 

We need a Control Plane mechanism to propagate configuration changes across all isolated Docker containers in real-time without requiring rolling restarts, while avoiding split-brain or cold-boot synchronization issues.

## Alternatives Considered & The Debate
Managing state across highly decoupled microservices (or modular monolith containers) presents synchronization challenges.

1. **Redis as the Sole Source of Truth (Rejected)**
   Store all configurations in Redis and have services query Redis on boot or via polling.
   *Why it was rejected:* Redis is excellent for ephemeral caching and high-speed Pub/Sub, but treating it as durable configuration storage introduces cold-boot flakiness. If Redis goes down or evicts keys, the system loses its configuration state and cannot boot reliably. 

2. **ClickHouse Polling (Rejected)**
   Store configurations in ClickHouse and have services periodically poll the database for changes.
   *Why it was rejected:* ClickHouse is not designed for high-frequency point lookups or polling. It introduces latency to "real-time" configuration updates and unnecessarily burdens the OLAP engine.

3. **Hybrid: ClickHouse + Redis Pub/Sub (Accepted)**
   Use ClickHouse as the durable, append-only source of truth for dynamic configurations. Use Redis Pub/Sub exclusively for real-time cache invalidation signaling.

## Decision
We will cleanly separate durable configuration storage from ephemeral signaling.
- **ClickHouse** acts as the append-only source of truth. When a service (like the Alert Consumer) boots from a cold state, it queries ClickHouse once to warm its in-memory configuration cache.
- **Redis Pub/Sub** is used for hot-reloading. When an admin updates a threshold, the API saves the durable record to ClickHouse, and then blasts an invalidation signal via Redis Pub/Sub. The running services instantly catch the signal and reload their cache.

## Consequences
- **Positive**: Solidifies the architecture by ensuring services can boot reliably from a durable cold state (ClickHouse) without depending on transient data stores.
- **Positive**: Achieves true real-time configuration propagation (via Redis) without polling the database.
- **Negative**: Increases the complexity of service startup routines, as they must handle initial ClickHouse querying and subsequent Redis subscription management.
