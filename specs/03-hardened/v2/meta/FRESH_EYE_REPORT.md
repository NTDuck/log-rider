# Fresh-Eye Invariant Inspector Report

**Target:** `v2/README.md` vs `02-disambiguated/README.md`
**Role:** Fresh-Eye Invariant Inspector
**Status:** 🚨 MULTIPLE INVARIANTS & LEAKY ABSTRACTIONS DETECTED

## 1. Unchallenged Invariants (Missing/Poorly Defined Requirements)

### 1.1. The Missing Front Door (Ingestion Authentication)
* **Baseline Context:** The Edge Receiver API is responsible for terminating external HTTP/gRPC connections.
* **The Gap:** The hardened spec goes to great lengths to define JWT RBAC for the WebSocket viewer, but is **completely silent** on how the Edge Receiver authenticates incoming telemetry. 
* **Impact:** Is the Edge Receiver a completely open, unauthenticated endpoint? The OpenAPI `IngestedLog` spec (`FR-001`) defines no auth headers (like API keys or mTLS). This is a critical unflagged security invariant.

### 1.2. The Phantom `Error Code` in Alert Fingerprints
* **Baseline Context:** Alert Deduplication is keyed by deterministic Alert Fingerprints: `(App Name + Log Level + Error Code)`.
* **The Gap:** The `Error Code` concept has vanished. It does not exist in the ClickHouse `logs` schema, nor is it part of the `IngestedLog` OpenAPI spec. 
* **Impact:** The Alert Consumer cannot generate the deterministic fingerprint as defined. The spec demands exact deduplication but provides an impossible data model for it.

### 1.3. PII Regex Rules Origin (Leaky Configuration)
* **Baseline Context:** Workers must scrub PII from payloads.
* **The Gap:** `FR-002` states the Normalization Worker must execute "compiled regex-based PII redaction rules". Where do these rules come from? Are they hardcoded? Fetched from Redis? Stored in ClickHouse? 
* **Impact:** This is an undefined dependency injected directly into a critical, high-speed data-cleansing loop. 

## 2. Implicit vs. Explicit Violation Check (Leaky Abstractions)

### 2.1. The Admin Control Plane Black Hole
* **Violation:** `FR-010` mandates: "Admin configuration updates MUST be written to `alert_configs` ReplacingMergeTree table in ClickHouse and published via Redis Pub/Sub."
* **Leaky Abstraction:** **Who** writes these updates? The Topic Topology diagram and Actor list contain no Admin API Actor. There is no defined entry point for admin configuration updates. The spec describes the database tables and sync mechanisms but implicitly assumes an actor exists to accept and validate the admin requests.

### 2.2. Redis Crash "State Reconstruction" Fallacy
* **Violation:** Under Edge Cases, the spec states: "If Redis crashes... the Alert Consumer MUST fall back to query the ClickHouse `alert_configs` configuration stream directly using `argMax` to reconstruct in-memory state."
* **Leaky Abstraction:** `alert_configs` only holds threshold configurations (rules), **not** the tumbling window occurrence counters (event state). If Redis crashes, the deduplication counters are gone. You cannot reconstruct the deduplication state from ClickHouse. 
* **Secondary Violation:** Querying ClickHouse via `argMax` directly from the Alert Consumer introduces a synchronous network I/O blocking call right inside an asynchronous Redpanda event consumption loop.

### 2.3. Deployment Model Contradiction
* **Violation:** The Baseline specified the image is "deployed as isolated containers via role-based entrypoint flags (e.g., `--role receiver`)". The hardened spec states: "The following nodes represent asynchronous actor threads running concurrently within a single Modular Monolith binary, **not** distributed microservices."
* **Leaky Abstraction:** Does the binary run *all* actors concurrently in every container, or does it isolate them via entrypoints? If all actors run in the same process, how does the WebSocket Server independently scale using the "Broadcast Consumer Pattern" without accidentally spinning up multiple DB Writers and Edge Receivers, causing massive Kafka consumer group conflicts? The boundary of scalability is deeply ambiguous.

## 3. Evaluator Audit Gaps (Banned Anti-Pattern Check)

The `EVALUATION.md` missed the following checks:
1. **Microservice network I/O blockages:** The evaluator explicitly claimed microservice bloat was eradicated, but entirely missed the blocking network I/O introduced by the Alert Consumer's synchronous ClickHouse query fallback during a Redis crash.
2. **Transactional SQL:** The evaluator confirmed `UPDATE/DELETE` queries were eradicated, but didn't explicitly confirm the absence of Transactional SQL (though ClickHouse implicitly prevents this, the evaluation rubric requires explicit checking).
3. **Security Officer Blindspot:** The Security & Compliance Officer gave a 100% PASS without noticing the Edge Receiver API accepts public internet JSON traffic with absolutely zero authentication/authorization mechanisms defined.
