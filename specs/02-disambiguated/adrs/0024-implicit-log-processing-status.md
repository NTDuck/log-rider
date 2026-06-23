# 0024. Implicit Log Processing Status

## Status
Accepted

## Context
The origin specifications require the system to "manage log processing status (Raw, Normalized, Stored)." However, explicitly tracking and updating a status field for every single log transitioning through the pipeline would introduce a massive OLTP mutation load, paralyzing our ClickHouse database and reintroducing the state-machine complexity abandoned in ADR-0019.

## Decision
We adopt **Implicit Architectural Status**. The status of a log is determined exclusively by its physical location in the pipeline, rather than a stored state flag:
- **Raw**: Exists in the Redpanda `logs-raw` topic.
- **Normalized**: Exists in the Redpanda `logs-normalized` topic.
- **Stored**: Persisted in the ClickHouse `logs` table.

We satisfy the user-facing observability requirement by exposing Prometheus metrics (throughput and lag) at each boundary, rather than querying microscopic log states.
