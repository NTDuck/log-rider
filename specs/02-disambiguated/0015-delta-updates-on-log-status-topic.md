# 0015. Delta Updates on Log Status Topic

## Status
Accepted

## Context
Our log processing pipeline involves multiple stages: a single log progresses from `Raw` to `Processed`, then to `Stored`, and potentially `Categorized` by the AI system. The Viewer subsystem needs to display these lifecycle transitions in real-time. The architectural plan relies on an event-driven status pipeline where services publish status updates to a dedicated `log-status` compacted topic in Redpanda.

The fundamental challenge arises in how we communicate these state changes. The logs can be quite large (e.g., massive structured JSON payloads, exception blobs up to 64KB).

## Alternatives Considered & The Debate
During the architecture grilling session, two main options were debated:

1. **Full Payload Broadcasting (Rejected)**
   The naive approach allows internal services (like the Normalization Worker or the DB Writer) to blindly copy-paste the entire massive log payload into every single status transition event published to the `log-status` topic.
   *Why it was rejected:* A single log transitions states at least 3-4 times. Duplicating the entire payload for every lifecycle stage artificially multiplies Redpanda network bandwidth and disk I/O by 300-400%. This would cause the system to collapse under its own weight in a high-throughput production environment.

2. **Delta Updates / Partial Payloads (Accepted)**
   Enforce strict Delta Updates on the `log-status` topic. After the initial "Raw" event (which contains the full payload), all subsequent transitions sent by services to the state topic must only include the diff: `{"status": "stored", "Log_ID": "123"}` or `{"status": "categorized", "Log_ID": "123", "ai_tags": ["anomaly"]}`.

## Decision
We will strictly implement **Delta Updates (Partial Payloads)** on the `log-status` topic. Services publishing to this state machine topic must use Delta Updates for all transitions after the initial "Raw" event.

To make this work for the end user, the Viewer's WebSocket server will act as an in-memory reducer. It will maintain an in-memory map of logs, receive these lightweight `PATCH` events from the tail of the topic, merge the deltas into the complete payload, and then push only the lightweight updates to the connected clients.

## Consequences
- **Positive**: Drastically minimizes network bandwidth consumption and disk I/O on the Redpanda cluster (slashing it by up to 75% for state tracking).
- **Positive**: Enables smooth UI transitions for engineers without requiring full row re-renders or transferring massive JSON blobs repeatedly over WebSockets.
- **Negative**: Adds state-management complexity to the Viewer's WebSocket server, which must intelligently handle state merging and potential out-of-order updates (e.g., if a "stored" event arrives slightly before a "processed" event due to network jitter).
