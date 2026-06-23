# 0014. Broadcast Consumer Pattern for WebSocket Scaling

## Status
Accepted

## Context
A critical functional requirement is the "Real-time Log Viewer Subsystem": a live dashboard for operations engineers to monitor a continuous, real-time log stream filtered by application or error level without page reloads. The system must support high concurrency, potentially up to 500+ connected engineers.

Our Live Stream View relies on a WebSocket server acting as an in-memory materializer, reading from the `logs-normalized` topic. The challenge arises when we scale this WebSocket edge tier.

## Alternatives Considered & The Debate
We analyzed how the WebSocket server instances should consume the Redpanda stream when scaled horizontally behind a load balancer.

1. **Shared Consumer Group (Rejected)**
   Configure the scaled WebSocket servers with a standard, static Consumer Group ID (e.g., `websocket-viewers`).
   *Why it was rejected:* This introduces a distributed stream consumption trap. If we scale to 3 replicas, Redpanda will partition the traffic: Server 1 gets 33% of the logs, Server 2 gets 33%, and Server 3 gets 33%. If Engineer A and Engineer B both filter for `App_X` but connect to different servers, they will each miss 66% of the logs. The "real-time viewer" would be completely broken, displaying a fragmented reality.

2. **Per-Client Redpanda Consumers (Rejected)**
   Spawn a new Redpanda consumer for every connected WebSocket client.
   *Why it was rejected:* Kafka/Redpanda are not designed to handle thousands of ephemeral consumers. This would immediately overwhelm the broker with connection state and consumer group rebalancing overhead.

3. **Broadcast Consumer Pattern (Accepted)**
   When a WebSocket container boots up, it must generate a completely **unique, ephemeral Consumer Group ID** (e.g., `viewer-group-<uuid>`). Redpanda treats every single WebSocket server as a completely independent application. Redpanda pushes 100% of the `logs-normalized` topic traffic to Server 1, 100% to Server 2, and 100% to Server 3. 

## Decision
We will enforce the **Broadcast Consumer** pattern for our real-time streaming servers. Each replica of the Viewer's WebSocket server will generate a unique, ephemeral consumer group ID upon boot.

When the server receives the full stream, it acts as a Stateless Broadcast Consumer, filtering and fanning out the data dynamically in memory to whichever clients happen to be connected to that specific replica.

## Consequences
- **Positive**: Guarantees that no matter how many WebSocket servers are spun up to handle user load, every single engineer sees the exact same, complete reality in their dashboard.
- **Positive**: Redpanda flawlessly fans out the status updates to every container without the risk of partitioned streams.
- **Negative**: Increases the network egress from the Redpanda cluster, as every message must be duplicated across the network to every running WebSocket server replica. However, this is mitigated by our use of Delta Updates (ADR-0015).
