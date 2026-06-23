# Architecture Specification Oscillations (v1 to v5)

## 1. The JSON Flattening & Stack Exhaustion Ping-Pong
**Core Conflict**: Balancing OTLP flattening constraints, Edge memory protection, and architectural baselines.
* **v1 / v2**: The Edge Receiver is strictly responsible for flattening JSON payloads before passing them to the broker.
* **v3**: Ambiguity is introduced. The Edge Receiver performs the flattening, but the Normalization Worker evaluates the `Max Depth > 5` constraint. The auditor demands that the Edge must evaluate depth during flattening.
* **v4**: The Edge Receiver is configured to mechanically unroll key-value lists *before* enforcing the depth limit. The auditor rejects this due to a **Stack/Memory Exhaustion** vulnerability (recursive stack-overflow).
* **v5**: To solve the stack exhaustion and validation paradoxes, the specification moves flattening entirely to the Normalization Worker. The auditor immediately rejects this as an **Edge Flattening Contradiction**, violating `ADR-0016: OTLP Flattening at Edge` by allowing massive un-flattened payloads to bloat the Redpanda broker. The final mandate forces flattening back to the Edge using a safe *iterative* parser.

## 2. Database Schema Traps: `ReplacingMergeTree` vs. Append-Only TTLs
**Core Conflict**: Reconciling the need for configuration updates and log eviction with ClickHouse's append-only performance mechanics.
* **v1 / v2**: The `alert_configs` table uses `ReplacingMergeTree(updated_at)` to implicitly keep the latest config per app. Log retention uses a blanket `TTL timestamp + INTERVAL 7 DAY` rule.
* **v3**: The auditor rejects `ReplacingMergeTree` as an **OLAP Mutation Trap**, stating it violates the append-only stream mandate (`ADR-0015`), demanding a standard `MergeTree`. Additionally, it flags a **Silent Deletion Trap** because the blanket TTL blindly drops all logs (including errors meant to be kept for 30/90 days).
* **v4 / v5**: The spec pivots to `MergeTree` for configs (with the Alert Consumer resolving state via Redis) and implements conditional eviction (`TTL ... DELETE WHERE level = 'DEBUG'`), successfully escaping the mutation traps.

## 3. The Homogeneous Arrays Validation Paradox
**Core Conflict**: Enforcing data shape boundaries on nested arrays while simultaneously flattening them for ClickHouse insertion.
* **v3**: The auditor flags a **Missing Data Boundary** (mandated by `ADR-0005`) and forces the spec to explicitly add a "Homogeneous Arrays" constraint with a DLQ routing consequence.
* **v4**: The constraint is added, but the auditor flags a **Homogeneous Arrays Validation Paradox**: Because the Edge Receiver flattens the payload into dot-notation strings, the original nested array structure is destroyed by the time the Normalization Worker tries to validate it.
* **v5**: The spec attempts to fix this by validating against the "original AST" at the Worker. The auditor rejects this again as logically absurd. Because the final ClickHouse schema casts all attribute values to `Array(String)`, mixed types (like `[1, "two"]`) are safely cast to `["1", "two"]`. The auditor orders the complete deletion of this artificial boundary to prevent dropping valid telemetry.

## 4. RDBMS Hangovers: UUID Indexing & Joins
**Core Conflict**: Applying traditional relational DB patterns (UUID primary keys, JOINs) to a columnar OLAP database (ClickHouse).
* **v1 / v2 / v3**: The ClickHouse schema includes `log_id` (a UUID) inside the table's `ORDER BY` clause.
* **v4**: The auditor identifies an **RDBMS Trap**, explaining that a UUID in the `ORDER BY` explodes the sparse index in RAM, destroying compression. They also forbid relational `JOIN` operations against the `log_ai_tags` sidecar table.
* **v5**: The spec removes `log_id` from the `ORDER BY` clause. However, to compensate, it instructs sidecars to correlate records using a `WHERE log_id IN (...)` clause. The auditor flags this as an **Unindexed UUID IN Clause** (a fatal OLAP trap) because `log_id` is now unindexed, triggering massive Full Table Scan DoS attacks.

## 5. PII Containment & Pipeline Leaks
**Core Conflict**: Determining exactly *when* and *where* PII redaction occurs in the pipeline relative to DLQ and Alerting branches.
* **v1**: The auditor flags a **PII Containment Logic Flaw** at the Edge, re-assigning server-side PII regex redaction strictly to the Normalization Worker as defense-in-depth.
* **v5**: Because PII redaction was moved deeper into the pipeline, the auditor flags multiple **PII Leaks**:
  1. Poison pills are routed to the DLQ *before* the Normalization Worker scrubs them, leaking unredacted PII into the DLQ. (Fix: Truncate payloads in the DLQ envelope).
  2. High-priority logs are duplicated to the alerts stream *before* PII redaction, leaking sensitive data to notifications.
