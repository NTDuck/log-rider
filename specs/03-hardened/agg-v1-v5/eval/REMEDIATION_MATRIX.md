# Hardening Remediation Matrix (v1 -> v6)

This document is the definitive output of the Differential Root-Cause Analysis across the `v1` to `v5` specification history. It acts as the final Loop-Breaker patch to guide the generation of the `v6` specification, ensuring zero invariant collisions.

## 1. Executive Summary of Oscillations
The progression from v1 to v5 revealed three primary axes of invariant collision:
*   **The Ingestion Paradox**: Oscillating between Edge Receiver stack-exhaustion (from recursive parsing), violating the "zero-logic" constraint, or violating `ADR-0016` by moving flattening downstream to the Worker.
*   **The OLAP Relational Hangover**: Oscillating between ClickHouse dictionary bloat, OOM Hash Joins (from joining sidecars via UUID), and I/O Full Table Scans (from using `WHERE log_id IN (...)` after removing `log_id` from the primary index).
*   **The PII/DLQ Leak**: Oscillating between strict schema validation and PII containment, revealing that dropping poison pills to the DLQ *before* PII regex extraction leaks unredacted data to the broker and enables DLQ DoS attacks.

---

## 2. The Remediation Matrix (Prompt Patch for v6)

| Architectural Domain | The Oscillation / Trap (v1-v5) | The Final Remediation Rule (v6) |
| :--- | :--- | :--- |
| **Ingestion Validation** | Demanding recursive flattening while forbidding parsing; moving flattening to Worker (ADR-0016 violation). | Edge MUST flatten using an **Iterative JSON Parser** with a fail-fast depth limit > 5. |
| **Data Shape Rules** | Enforcing Homogeneous Arrays while DB schema casts all values to strings anyway. | **DELETE** the Homogeneous Array constraint entirely. Enforce `maxProperties` in OpenAPI. |
| **OLAP Sidecars** | Joining on UUID causing Hash Join OOM; using `IN(log_id)` causing Full Table Scan. | Sidecar resolution MUST use **ClickHouse Dictionaries**. Forbid `IN (UUID)` on main table. |
| **OLAP Attributes** | Using `Map()` forcing stringified JSON, defeating indexing. | Transform flat JSON into **Parallel Arrays** (`attribute_keys`, `attribute_values_string`). |
| **DLQ & PII Safety** | Poison pills bypass PII redaction, leaking data and blooming DLQ storage. | DLQ Envelope MUST **truncate** original payload to 2KB and apply 24h retention. |
| **Alert Routing** | Moving alerts vs Duplicating; leaking PII to alert streams. | Duplicate to `alerts-priority-stream` strictly **after** PII regex redaction. |
| **Missing Baselines** | Dropped Telegram Rate limits, Prometheus metrics, and Materialized Views. | Restore **Lua Token Bucket**, **Prometheus Contracts**, and **AggregatingMergeTree**. |
| **Redis Resilience** | Blocking Redpanda consumer to reconstruct Redis state from ClickHouse on crash. | **Accept ephemeral state loss** on Redis crash. Forbid synchronous DB queries in consumer loop. |

---

## 3. Strict Action Items for the v6 Generator
1. **Adhere entirely to the "Final Remediation Rule" column** in the matrix above. Do not attempt to re-introduce previous paradoxes.
2. **Remove any mention of the Homogeneous Arrays constraint**. It is artificial and factually incorrect given ClickHouse's `Array(String)` schema.
3. **Explicitly add OpenAPI boundaries** (`maxProperties`, `maxLength`) to prevent in-memory map bloat.
4. **Ensure the DLQ schema is explicitly rewritten** to require truncation (`first 2KB + sha256 hash`).
5. **Ensure the ClickHouse `AggregatingMergeTree`** is defined for Real-Time Application Health Analytics.
