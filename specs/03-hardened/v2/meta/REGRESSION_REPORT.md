# Context Regression Analyst Report

**Target**: `v2/README.md`
**Objective**: Detect Context Overfitting (Goodhart's Law) and Architectural Regressions introduced during hardening.

## Executive Summary
The `v2` specification has severely overfitted to the council's constraints. In an attempt to satisfy the exact phrasing of the reviewers (e.g., "no business logic", "enforce before deserialization", "strict schema"), the document has introduced impossible physical contradictions and structurally warped the architecture. 

## Architectural Regressions & Overfitting Findings

### 1. The "Zero Logic" vs. "Flattening" Paradox (Edge Receiver)
* **The Overfit**: To satisfy the Performance Engineer's mandate for ingress boundaries and the Architect's demand for dumb pipes, `FR-001` and the Edge Cases state the Edge Receiver MUST execute *"zero business logic"* and enforce a 1MB limit *"before initiating any JSON or OTLP payload deserialization or parsing"*.
* **The Contradiction**: In the exact same breath, it requires the Edge Receiver to *"mechanically unroll OTLP nested `kvlists` into dot-notation strings."* 
* **The Reality**: It is physically impossible to traverse and flatten a nested Protobuf/JSON OTLP tree without parsing/deserializing the payload into memory first. The spec has warped reality to check two mutually exclusive boxes.

### 2. Regex JSON Corruption (Normalization Worker)
* **The Overfit**: To satisfy the Security Officer's strict PII requirements without appearing to add processing overhead, `FR-002` dictates that the worker must *"execute compiled regex-based PII redaction rules directly against the unrolled string payloads"* prior to publishing.
* **The Contradiction**: Running raw string regex replacements against unparsed JSON payloads is disastrous. It risks corrupting the JSON syntax (e.g., removing quotes, breaking brackets) and creating invalid payloads that will fail downstream. PII redaction must be done on the parsed AST (Object representation), not the raw string bytes.

### 3. The `Map(String, String)` Serialization Defeat
* **The Overfit**: Trying to enforce absolute schema strictness, the spec defines the ClickHouse `attributes` column purely as `Map(String, String)`. To make arrays fit into this, it mandates the DB Writer *"explicitly serialize all non-primitive nested or array values into JSON string literals"* (e.g., `["admin"]` becomes `"[\"admin\"]"`).
* **The Contradiction**: This completely defeats the purpose of the Baseline's "Attribute Projection" and OTLP flattening. If values are stringified JSON arrays, ClickHouse cannot utilize its native Map indexing to search them. Queries will be forced to use expensive, on-the-fly `JSONExtract` functions at read-time, destroying the OLAP performance the spec was trying to protect.

### 4. The Redis State Reconstruction Fallacy
* **The Overfit**: Addressing the "Redis Crash" edge case, the spec mandates that the Alert Consumer *"MUST fall back to query the ClickHouse `alert_configs`... to reconstruct in-memory state."*
* **The Contradiction**: ClickHouse only stores the *threshold configurations* (e.g., 100 errors / 60s). It does *not* store the ephemeral tumbling window event counters (how many errors have actually occurred in the current window). Those counters lived exclusively in Redis. If Redis crashes, the active window state is gone and cannot mathematically be "reconstructed" from a static config table. 

## Conclusion
The `v2` spec suffers from severe Goodhart's Law. By optimizing strictly for the *metrics* of the council's feedback (saying the right buzzwords like "O(1)", "before deserialization", and "zero logic"), it has broken the actual physical implementation of the pipeline. The document must be unfrozen and corrected before Phase 04 implementation.
