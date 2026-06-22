# Council Audit Report

**Status**: ❌ **REJECTED: Architectural Contradictions & PII Leaks Identified**
**Audited Artifact**: `specs/03-hardened/v5/README.md`
**Baseline Reference**: `specs/02-disambiguated/README.md`

## 1. Security & Compliance Officer Findings
**Status**: ❌ **REJECTED**

* **Edge Flattening Contradiction**: `v5` moved JSON flattening to the Worker. This directly violates the established architectural baseline (`ADR-0016: OTLP Flattening at Edge`). This boundary shift must be reverted; the Edge must flatten the payload.
* **PII Leaks to DLQ**: Because poison pills are dropped to the DLQ *before* PII regex scrubbing occurs, unredacted PII is leaked into the DLQ. The DLQ topic must have a strict 24-hour retention TTL, and the `DLQEnvelope` JSON schema must mandate payload truncation (e.g., storing only the first 2KB of the `original_payload` and a cryptographic hash) to contain the leak.
* **PII Leaks to Alerts**: `FR-003` fails to explicitly mandate that duplicating high-priority logs to `alerts-priority-stream` occurs *after* PII redaction.
* **DLQ DoS Bloat**: Storing the full, uncompressed 256KB payload in the DLQ allows a trivial DoS attack that will bloat the broker. Payload truncation in the DLQ envelope is mandatory.

## 2. Systems Performance Engineer Findings
**Status**: ❌ **REJECTED**

* **Edge Stack Exhaustion vs. Contradiction**: Moving flattening to the worker introduces massive un-flattened OTLP transport payloads to the broker, violating ADR-0016. To safely flatten at the Edge without stack exhaustion, the Edge Receiver must utilize an *iterative* JSON parser, failing fast when the depth boundary is breached, rather than a recursive parser.
* **OpenAPI Missing Data Boundaries**: The OpenAPI schema for `attributes` defines `value: type: object` without boundaries. Code generators will evaluate this as an unbounded map. The schema must explicitly enforce `maxProperties` and depth limits on dynamic objects to prevent memory allocation spikes.
* **The Homogeneous Arrays Paradox**: The ClickHouse schema uses `attribute_values_string Array(String)`, meaning *all* attribute values are cast to strings. Enforcing a strict "Homogeneous Array" constraint on the original AST is logically absurd (e.g., `[1, "two"]` becomes `["1", "two"]`, which is perfectly valid). This artificial boundary must be DELETED to prevent rejecting valid telemetry.

## 3. Skeptic Architect Findings
**Status**: ❌ **REJECTED**

* **Unindexed UUID `IN` Clause (Fatal OLAP Trap)**: `v5` successfully removed `log_id` from the `ORDER BY` clause to protect the sparse index. However, it instructed sidecars to query via `WHERE log_id IN (...)`. Because `log_id` is now unindexed, this triggers a massive Full Table Scan DoS on ClickHouse. Sidecar correlations MUST rely on indexed fields like `(app_name, level, timestamp, error_code)`.
* **Missing AggregatingMergeTree (ADR-0011)**: `v5` completely omitted the Real-Time Application Health Analytics. The spec must include ClickHouse Materialized Views (`AggregatingMergeTree`).
* **Missing Lua Token Bucket (ADR-0022)**: The Redis tumbling window for deduplication is present, but the Lua Token Bucket rate limit required to prevent Telegram API bans was omitted.
* **Missing Prometheus Metrics (ADR-0024)**: The spec fails to mandate Prometheus metric contracts for tracking implicit log states across the topics.

## Recommended Action
The `v5/README.md` artifact is **REJECTED**. The council identified severe baseline contradictions, paradoxes in validation logic, PII leak vectors, and critical OLAP traps. You must apply this evaluation as a Prompt Patch to rewrite the design document, correcting every absolute violation to generate a flawless `v6`.
