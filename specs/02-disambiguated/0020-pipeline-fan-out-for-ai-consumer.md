# 0020. Pipeline Fan-Out for AI Consumer

## Status
Accepted

## Context
The AI Consumer needs access to clean, normalized logs to perform inference. Placing it inline before the DB Writer would block critical storage writes, while having it poll ClickHouse post-insertion would degrade database performance.

## Decision
We will fan-out the `logs-normalized` topic. The DB Writer and the AI Consumer will act as independent consumer groups reading the exact same normalized stream in parallel.

## Consequences
- **Positive**: The AI Consumer operates entirely out-of-band and cannot slow down the critical ingestion-to-storage pipeline.
- **Positive**: Downstream consumers can independently scale based on their specific workload (I/O bound vs GPU/CPU bound).
- **Negative**: None; this is the optimal use of Redpanda consumer groups.
