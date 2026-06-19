# 0004. Dedicated Redpanda Topic for Priority Queue

## Status
Accepted

## Context
The system requirements dictate an Alert Locking Mechanism: when a Worker detects an `ERROR` or `CRITICAL` log, it must trigger a real-time notification to a WebSocket dashboard and Telegram. It also must apply deduplication via Redis (e.g., if an error occurs 100 consecutive times in 1 minute, send only 1 notification to avoid alert fatigue).

Initially, the design proposed keeping the "priority queue" as a logical boundary, where the Worker would query Redis to check the count, attach a `should_send` boolean based on the deduplication logic, and push the log to a secondary Priority Queue. A separate Alert Consumer would then read from the PQ and fire the notification. The initial choices for this secondary PQ included exotic brokers like HexboltMQ or Qrusty.

However, this design contained a glaring contradiction. The primary goal of the custom Rust Worker is to be a "dumb, fast ingester." By forcing the Worker to query Redis, track counts, and execute deduplication logic on every `ERROR` log, the Worker's speed and availability became directly coupled to network round-trips and the uptime of the Redis instance. If Redis slowed down, the entire main log ingestion loop would grind to a halt.

At the same time, removing the priority queue entirely was rejected. A buffer is crucial for retries, backpressure, and decoupling notification failures (e.g., if the Telegram API or WebSocket server goes down for 30 seconds, without a PQ, the Worker must either block to retry or drop the alert, coupling failure handling directly to high-speed log ingestion) from the main ingestion loop. The PQ acts as a shock absorber for these downstream failures.

## Decision
We will eliminate the use of niche standalone brokers (like HexboltMQ) and create a **dedicated Redpanda topic (`alerts-priority-stream`)** to act as our Priority Queue. 

Crucially, we are shifting the Redis deduplication logic entirely to the Alert Consumer. The Worker will remain 100% blind: if it parses an `ERROR` or `CRITICAL` log, it simply duplicates that log into the `alerts-priority-stream` topic and instantly moves on.

## Alternatives Considered
- **Worker-Side Deduplication without PQ**: Rejected. Couples the ingestion path directly to Telegram API failures. If a notification fails, the Worker blocks trying to retry, halting ingestion.
- **Worker-Side Deduplication with PQ**: Rejected. Forces the Worker to query Redis, destroying its status as a "dumb, fast pipe" and coupling high-throughput ingestion to Redis latency.
- **Third-Party Brokers (HexboltMQ, RPQ, Qrusty)**: Rejected. Introducing a third broker technology specifically for alerts introduces needless operational drag and bloats the Docker-compose footprint when Redpanda is already in the stack.

## Consequences
- **Positive**: The ingestion Worker remains incredibly fast and completely decoupled from both Redis availability and external API (Telegram/WebSocket) latency.
- **Positive**: The Alert Consumer is completely isolated, allowing it to safely process deduplication rules, manage rate limits, and handle retries for external notifications without affecting log ingestion.
- **Positive**: Utilizing an additional Redpanda topic leverages the high-throughput, backpressure-resistant broker we are already deploying, minimizing infrastructure sprawl.
- **Negative**: Adds a secondary processing hop (Worker -> Redpanda Topic -> Alert Consumer) for critical alerts, theoretically introducing a slight delay, though Redpanda's latency is sub-millisecond.
