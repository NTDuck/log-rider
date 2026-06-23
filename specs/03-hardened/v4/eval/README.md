# Council Audit Report

**Status**: ❌ **REJECTED: Architectural Paradoxes & RDBMS Traps Remain**
**Audited Artifact**: `specs/03-hardened/v4/README.md`
**Baseline Reference**: `specs/02-disambiguated/README.md`

## 1. Security/Compliance Officer Findings
**Status**: 🟢 **PASSED**

* The critical v3 vulnerabilities (Cross-Tenant Log Spoofing and Missing Admin Wildcards) have been flawlessly patched. The Edge Receiver explicitly enforces authorization (`app_name` must match JWT `app_grants`), and the `*` wildcard is strictly integrated into the stateless boundaries.

## 2. Skeptic Architect Findings
**Status**: ❌ **REJECTED**

* **RDBMS Trap - UUID in `ORDER BY` (CRITICAL)**: The `logs` table schema includes `log_id` (a UUID) in the `ORDER BY (app_name, level, timestamp, log_id)` clause. In ClickHouse, this explodes the primary sparse index in RAM, destroying compression and performance. `log_id` MUST be removed from the `ORDER BY`.
* **RDBMS Trap - The "Sidecar" Join (CRITICAL)**: The specification silently assumes the `log_ai_tags` sidecar table can be easily joined back to the `logs` table. Joining two billion-row fact tables on a UUID in ClickHouse triggers massive in-memory Hash Joins, guaranteeing an OOM cluster crash. The spec must explicitly forbid relational `JOIN` operations against the sidecar.

## 3. Systems Performance Engineer Findings
**Status**: ❌ **REJECTED**

* **Stack/Memory Exhaustion**: Forcing the Edge Receiver to mechanically unroll `kvlists` *before* the 5-depth limit is evaluated exposes the Edge to recursive stack-overflow attacks.
* **ClickHouse Dictionary Bloat**: `LowCardinality(String)` columns (`app_name`, `error_code`) lack `maxLength` limits in the OpenAPI schema. Malicious actors could send 999KB strings, causing severe dictionary bloat and OOM crashes.
* **OpenAPI Boundary Gap**: The schema entirely lacks `maxLength` boundaries for strings and `maxItems` boundaries for arrays.
* **I/O Boundary Gap (Payload Size)**: The Edge Receiver permits 1MB connections, but the Worker DLQs payloads > 64KB compressed. This permits up to 1MB of malicious payload to traverse the network and broker (`logs-raw`), wasting bandwidth and disk space before being dropped.
* **Data Shape Mismatch**: The Edge Receiver outputs a flat JSON object (e.g. `{"a.b": "value"}`), but the ClickHouse schema requires parallel arrays (`attribute_keys` and `attribute_values_string`). The pipeline lacks a defined step to transform the flat JSON into these parallel arrays.
* **Homogeneous Arrays Validation Paradox**: By the time the payload reaches the Normalization Worker, the Edge Receiver has already flattened it, destroying the original nested array structure. It is therefore physically impossible for the Worker to reliably validate "Homogeneous Arrays". Array validation must occur *prior* to or *during* flattening.

## Recommended Action
The `v4/README.md` artifact is **REJECTED**. The council identified severe RDBMS hangovers in the ClickHouse design and multiple memory/validation paradoxes in the Edge-to-Worker pipeline. You must apply this evaluation as a Prompt Patch to rewrite the design document, correcting every absolute violation until a clean approval is reached.
