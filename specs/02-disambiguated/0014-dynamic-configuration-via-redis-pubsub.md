# 0014. Dynamic Configuration via Redis Pub/Sub

## Status
Accepted

## Context
The system allows the System Admin to dynamically configure operational settings, such as modifying the deduplication threshold for specific applications (e.g., changing the alert threshold from 100 errors/min to 50 errors/min).
The Alert Consumer needs to be aware of these thresholds instantly to process critical error logs from the Redpanda priority queue. However, if the active Alert Consumer is forced to execute a database query (e.g., `SELECT threshold FROM alert_configs WHERE app_name = 'payment_api'` against ClickHouse or PostgreSQL) for every single critical log to check the current threshold, it introduces a severe I/O bottleneck. This undermines the high-speed stream processing architecture we have established.

## Decision
We will implement a Dynamic Configuration pattern using Redis Pub/Sub combined with an In-Memory Cache to achieve zero-latency configuration reads.
1. When an Admin updates a configuration in the Viewer, the Viewer backend persists it to the Source of Truth database and simultaneously publishes a notification to a Redis Pub/Sub channel (e.g., `config-updates: payment_api=50`).
2. The Alert Consumer subscribes to this channel.
3. The Alert Consumer maintains a local, in-memory map of these thresholds. When a config update fires, it immediately applies the change to its local map.
4. During high-speed log processing, the Alert Consumer checks its local RAM (0ms latency) to evaluate thresholds, completely bypassing database queries.

## Consequences
- **Positive**: Ensures instantaneous propagation of configuration changes to all active workers.
- **Positive**: Eliminates database polling overhead, guaranteeing memory-speed latency for the Alert Consumer's business logic.
- **Negative**: Relies on a volatile messaging layer for invalidation. If a Redis Pub/Sub message is dropped, the worker could suffer from split-brain logic. Therefore, services must perform boot-time cache warming by querying the Source of Truth upon startup.
