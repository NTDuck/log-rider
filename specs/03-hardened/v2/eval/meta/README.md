# Meta-Evaluation Report: Auditing the v2 Council

**Status**: ❌ **SEVERE FAILURE: Evaluator Complicity & Architectural Regression**
**Audited Artifacts**: `specs/03-hardened/v2/README.md` and `specs/03-hardened/v2/EVALUATION.md`
**Baseline Reference**: `specs/02-disambiguated/README.md`

## 1. Compliance Precision & Spec Anchoring (Traceability Audit)
* **Finding**: ❌ **FAILURE** (Evaluator Complicity)
* The original council evaluator issued a 100% clean approval without force-linking a single implementation check back to the physical baseline requirements established in `02-disambiguated/README.md`. The evaluator graded its own homework and acted as a rubber-stamp rather than a strict traceability enforcement gate.

## 2. Context Overfitting & "Goodhart’s Law" Detection
* **Finding**: ❌ **SEVERE STRUCTURAL WARPING**
* **The "Zero Logic" vs "Flattening" Paradox**: The Edge Receiver is mandated to apply a 1MB limit "before deserialization" and execute "zero business logic", but is simultaneously tasked with mechanically unrolling nested OTLP `kvlists`. It is physically impossible to flatten a nested JSON payload without parsing/deserializing it first.
* **The `Map(String, String)` Defeat**: To satisfy the evaluator's ClickHouse Map constraints, the DB Writer was instructed to serialize dynamic arrays into JSON strings. This structurally breaks the design: it defeats the entire premise of Attribute Projection and OTLP flattening, forcing expensive `JSONExtract` operations at read-time.
* **Regex JSON Corruption**: Demanding regex execution directly against unparsed raw JSON string payloads risks severe data corruption compared to executing rules against a safely parsed Abstract Syntax Tree (AST).

## 3. Fresh-Eye Invariant Audit against Baseline
* **Finding**: ❌ **UNFLAGGED MISSING INVARIANTS**
* **The Missing Front Door (Ingestion Auth)**: The spec exhaustively details WebSocket RBAC, but is completely silent on how the Edge Receiver authenticates incoming telemetry, leaving a massive unauthenticated ingestion endpoint on the public internet.
* **Phantom Error Code**: The alert deduplication fingerprint relies on an `Error Code`, but this field vanished from the data model and the `IngestedLog` OpenAPI schema.
* **PII Regex Rules Origin**: The origin of the compiled regex rules is a leaky abstraction. Are they hardcoded, fetched from Redis, or loaded from DB? This state dependency is undefined.
* **Admin Control Plane Black Hole**: The spec mandates writing `alert_configs` to ClickHouse via Redis Pub/Sub, but fails to define an "Admin API Actor" or any entrypoint to actually receive these administrative HTTP requests.
* **Deployment Model Contradiction**: If the "Modular Monolith" runs all actors concurrently in a single un-partitioned environment, horizontally scaling the WebSocket Server will inadvertently horizontally scale the DB Writers and Edge Receivers on the exact same pods, leading to massive Redpanda consumer group conflicts and database write lock contention. 

## 4. Implicit vs. Explicit Violation Check (Negative Constraints)
* **Finding**: ❌ **LEAKY ABSTRACTIONS & BLOCKING I/O**
* **Redis State Reconstruction Fallacy**: The spec claims that if Redis crashes, the Alert Consumer should query ClickHouse `alert_configs` using `argMax` to reconstruct in-memory state. This is a severe fallacy: `alert_configs` only holds threshold *rules*, not the ephemeral 60s live occurrence counts. Furthermore, this fix introduces a banned synchronous network I/O blocking call directly inside an asynchronous Redpanda event consumption loop.

## Conclusion & Next Steps
The `v2/EVALUATION.md` was deeply flawed and failed the meta-evaluation. The `v2/README.md` design succumbed to Goodhart's Law, warping its architecture to pass superficial text checks and inadvertently introducing physical impossibilities and massive leaky abstractions. 

The `v2-hardened` design is officially **UNFROZEN**. We must proceed to a `v3` specification that resolves these deep architectural paradoxes, formalizes the modular monolith's deployment boundaries, and establishes true ingestion authentication.
