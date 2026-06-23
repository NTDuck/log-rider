# 0018. Append-Only Configuration Stream

## Status
Accepted

## Context
The system is heavily decoupled, consisting of an Edge Receiver, Normalization Workers, DB Writers, AI Consumers, and an Alert Consumer. These stateless services rely on dynamic configurations configured by System Admins (e.g., changing the alert threshold for an app from 100 errors/minute to 50 errors/minute). 

We must propagate these configuration changes to the active consumers in real-time, without forcing our high-speed workers to execute slow SQL polling queries or introducing a secondary relational database (PostgreSQL) just for admin configs. 

## Alternatives Considered & The Debate
Managing state across decoupled microservices presents massive synchronization challenges.

1. **Redis Persistent State Store via AOF (Rejected)**
   Store configurations in Redis and configure Redis with Append Only File (AOF) enabled so the Admin configurations survive container restarts.
   *Why it was rejected:* We decided to keep Redis strictly as a volatile, ephemeral cache. Treating a caching layer as a persistent primary database complicates the infrastructure footprint. However, if Redis restarts and wipes memory, we lose the configurations.

2. **ClickHouse Mutation Updates (Rejected)**
   Use ClickHouse as the source of truth, and execute `UPDATE admin_configs SET threshold = 50` when the admin changes a value.
   *Why it was rejected:* This is the OLAP mutation trap. ClickHouse executes mutations asynchronously by rewriting entire data parts on disk. Using an OLAP engine for row-level, OLTP-style state mutations is a massive architectural anti-pattern that causes locking issues and storage fragmentation.

3. **Append-Only Configuration Stream with Boot-Time Cache Warming (Accepted)**
   Use ClickHouse as the absolute source of truth, but strictly through an append-only pattern. Use Redis Pub/Sub purely for real-time cache invalidations.

## Decision
We strictly commit to the **Append-Only Configuration Stream** pattern. There will be absolutely no mutations (`UPDATE` statements) in the OLAP database.

1. **The Append-Only SoT:** We create an `alert_configs` table in ClickHouse using the `ReplacingMergeTree` engine. When the Admin changes a threshold, the Viewer executes a pure `INSERT` of a brand new row (e.g., `('payment_api', 50, timestamp)`).
2. **Real-Time Updates:** Immediately after inserting, the Viewer publishes to a Redis Pub/Sub channel (`config-updates: payment_api=50`). Active Alert Consumers instantly catch the signal and update their in-memory `HashMap` (zero DB queries, memory-speed latency).
3. **Boot-Time Cache Warming:** If an Alert Consumer cold-boots (or Redis crashes), it executes a single lightning-fast query against ClickHouse: `SELECT app_name, argMax(threshold, timestamp) FROM alert_configs GROUP BY app_name`. This rebuilds the local cache instantly, entirely bypassing the need for Redis persistence.

## Consequences
- **Positive**: Protects the OLAP database from mutation penalties and locking issues, as we strictly use `INSERT` and `argMax` aggregation.
- **Positive**: Keeps the fast Alert Consumer workers running at pure memory speed, as runtime configurations are read directly from local RAM.
- **Positive**: Allows Redis to remain a strictly volatile, ephemeral cache without risking configuration loss on a cold boot.
