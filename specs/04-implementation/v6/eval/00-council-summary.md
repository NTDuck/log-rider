# The Principal Architecture Council - Final Evaluation Report (v6)

## Executive Summary
**Overall Status: SYSTEMIC REJECTION (Must Generate v7)**

While the `v6` tracks have successfully achieved physical resilience (passing the Operational Reality and Memory Auditors) and strict data boundaries (passing the Zero-Logic Database Enforcer), they have structurally failed on Observability and Traceability contracts. 

If we allow the generator to simply "fix the errors" by adding `tracing` spans where told and deleting the orphaned metrics, **we will induce Semantic Overfitting**. The generator will have learned the test answers rather than internalizing the structural constraints.

To prevent overfitting, the next generation phase (v7) must implement structural guards, not symptomatic fixes.

## Key Systemic Failures in v6

1. **The Telemetry Illusion (Systemic Reject across all tracks)**
   * **The Failure:** All 7 tracks omitted explicit `::tracing::debug!` and `::tracing::error!` spans in their Execution DAGs. The DAGs instruct "logging" abstractly but fail to instantiate the mechanical rust tracing spans required. 
   * **The Overfit Trap:** Just telling the agent "add tracing spans" will result in a mindless sprinkle of macros.
   * **The Structural Fix:** The Execution DAG template must mandate a specific structural layer for observability (e.g., "All I/O actions must be wrapped in an `#[instrument(skip_all)]` boundary or explicit `span.in_scope()` block"). Telemetry must be an architectural boundary, not an inline afterthought.

2. **The Metric Hallucination (Reject on Tracks 1, 3, 4, 5, 6, 7)**
   * **The Failure:** The agent completely ignored the strict limitation of 4 global Prometheus metrics dictated by FR-024. Instead, it hallucinated unique metrics for every single track (`logger_ws_dropped_total`, `logger_edge_requests_total`, etc.). Track 1 also forgot the required `logger_ingest_bytes_total` metric.
   * **The Overfit Trap:** Simply asking the agent to delete the extra metrics teaches it nothing about boundary discipline.
   * **The Structural Fix:** The prompt for v7 must enforce a **"Closed-World Telemetry" constraint**. The agent must be explicitly forbidden from inventing any metrics not pre-defined in the `specs/03-hardened/v6/README.md` state machine list.

3. **The I/O Boundary Paradox (Track 1 Critical Reject)**
   * **The Failure:** Track 1 defined an `IngestedLog` struct where the value is a flattened `String`. Yet, it receives raw JSON arrays from the HTTP client. If Axum deserializes this directly, it throws a 422 Unprocessable Entity, bypassing all downstream validation logic.
   * **The Structural Fix:** The domain model must be structurally decoupled from the wire model. For v7, Track 1 must explicitly define a `WireLog` (with `serde_json::Value`) for the HTTP boundary, and a `DomainLog` (Flattened String) for the internal Kafka boundary, with a mechanical mapping step in the DAG.

## Mandatory Directives for v7 Generation

To pass the Council in the next round, the `/speckit-plan` generator must adopt these three new meta-constraints:

1. **The Closed-World Telemetry Constraint:** You may only use the 4 exact Prometheus metrics defined in FR-024. Invention of any operational metrics results in immediate rejection.
2. **The Observability Boundary Constraint:** You must mechanically instantiate `::tracing` spans at the boundary of every asynchronous I/O operation within the Execution DAG. No abstract "log this" commands.
3. **The Wire-to-Domain Decoupling Constraint (Track 1):** You must define two distinct models for ingestion: the HTTP Wire Model (which accepts unbounded JSON) and the Domain Model (which enforces the flattened strings). Deserialization must never fail on type coercion before size/depth limits are applied.
