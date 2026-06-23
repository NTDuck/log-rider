# Council Audit Report

**Status**: ❌ **REJECTED: Critical Violations Found**
**Audited Artifact**: `specs/03-hardened/v3/README.md`
**Baseline Reference**: `specs/02-disambiguated/README.md`

## 1. Skeptic Architect Findings
**Status**: ❌ **REJECTED**

* **OLAP Mutation Traps (`ReplacingMergeTree`)**: `FR-010` states the Admin API Actor writes to a `ReplacingMergeTree`. This violates the explicit Append-Only stream mandate in baseline [ADR-0015]. It must use a standard `MergeTree`.
* **Broken TTL / Silent Deletion Trap**: The ClickHouse table contract specifies `TTL timestamp + INTERVAL 7 DAY` without conditional logic. This will blindly drop ALL logs after 7 days, destroying the 30-day and 90-day retention policies for ERROR/CRITICAL logs. It must use `DELETE WHERE` conditional filters based on `level`.
* **Alert Routing vs. Duplication**: `FR-003` mandates to "route logs... directly to alerts-priority-stream", implying a move. Baseline [ADR-0004] explicitly mandates to "duplicate" them. A move would break the primary observability pipeline by removing ERROR logs from the main stream.
* **Generic MQ Abstractions**: `FR-002` refers to configuring retention at the "broker level". Baseline [ADR-0003] demands "rely exclusively on Redpanda". The spec must explicitly dictate "Redpanda topic-level" configurations.

## 2. Systems Performance Engineer Findings
**Status**: ❌ **REJECTED**

* **Missing Data Boundary (Homogeneous Arrays)**: The Attributes Constraints Map completely omits the "Homogeneous Arrays" constraint mandated by baseline [ADR-0005]. If heterogeneous arrays pass, they complicate Edge flattening and analytical parsing. This must be explicitly added with DLQ routing consequence.
* **Validation Location Ambiguity**: While `v3` places OTLP flattening at the edge, it places the "Max Depth > 5" DLQ classification in the Normalization Worker. The spec must clarify that the Edge Receiver calculates key segment depth during flattening, and the Normalization Worker evaluates this count for DLQ routing.

## 3. Security/Compliance Officer Findings
**Status**: ❌ **REJECTED**

* **Cross-Tenant Log Spoofing**: `FR-001` added Edge Receiver authentication but explicitly forbade business logic, causing it to fail at authorization. An authenticated client could send a payload with `app_name: auth-service` while only possessing grants for `payment-api`. The Edge Receiver MUST reject the payload (HTTP 403) if the `app_name` in the parsed JSON does not exist within the JWT `app_grants` array (unless wildcard `*` is present).
* **Missing Stateless Admin Wildcards**: `FR-007` and `User Story 1` specify parsing JWT `app_grants` but completely omit the `*` wildcard requirement mandated by baseline [ADR-0009]. Without this, administrators cannot stream logs globally without breaking the stateless contract.

## Recommended Action
The `v3/README.md` artifact is **REJECTED**. You must apply this evaluation as a Prompt Patch to rewrite the design document, correcting every absolute violation identified by the council, until a clean approval is reached.
