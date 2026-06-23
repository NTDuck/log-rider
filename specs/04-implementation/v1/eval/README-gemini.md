You are absolutely right to be suspicious of these tracks. The current generated tracks are structurally flawed, violate the holistic guidelines we established, and will cause your generation agent to hallucinate or write rigid, brittle code.

Here is a critical evaluation of why they fail, why code artifacts must be purged, and the exact structural overhaul required to fix them.

---

### 1. Critical Evaluation of the Generated Tracks

Applying our holistic guidelines (Scope Hallucination, Boundary Bleeding, and Happy-Path Bias), the current tracks fail on several fronts:

* **Vague Execution DAGs:** Section 4 ("Incremental Logic Implementation") is dangerously broad. Saying *"Implement the iterative (non-recursive) JSON parser"* is not a micro-task; it is a massive cognitive leap. An LLM will likely panic, write a recursive parser anyway, and wrap it in a mock adapter to finish the prompt quickly.
* **Missing "Happy-Path" Protections:** The tracks mention the success states and some limits, but completely ignore the holistic failure modes. Track 3 (DB Writer) says "implement exponential backoff" but doesn't define the backpressure mechanism if the in-memory vector buffer overflows.
* **The "Wiring" Section is a Trap:** Section 5 provides literal `main.rs` wiring. This encourages the LLM to hardcode the initialization rather than building a clean, testable dependency injection setup.
* **Absence of Observability Constraints in Tasks:** While Section 6 mentions Prometheus, there are no specific steps in the DAG forcing the LLM to emit `tracing` spans or handle metric increments safely.

---

### 2. The Verdict on Code Artifacts: Purge Them All

**You are 100% correct: The tracks MUST NOT contain Rust code artifacts.** Including Rust code (like `#[async_trait] pub trait LogProducer`) triggers **Anchoring Bias** in the LLM.

* If the LLM sees `#[async_trait]`, it will blindly use that macro, ignoring the fact that modern Rust (since 1.75) supports native `async fn` in traits, costing you performance overhead.
* Providing code turns the LLM into a "copy-paste editor" rather than a "reasoning engine."
* If your architecture evolves, hardcoded Rust in your track `.md` files instantly deprecates the specification.

**The Rule:** Define *logical* shapes (JSON schemas, memory sizes, behavioral constraints) and let the LLM generate the *syntactic* shapes (Rust structs, traits).

---

### 3. The Structural Overhaul (New Section Schema)

To force the agent into a prescriptive, test-driven micro-task loop, the structure must change from *descriptive* to *imperative*.

Here is the revised, bulletproof structure for your Track `.md` files:

#### **Section 1: Component Context & Immutable Rules**

* **Trigger:** The CLI flag (e.g., `--role edge`).
* **I/O Topology:** The strict upstream input and downstream output.
* **Absolute Constraints:** The physical limits (e.g., 256KB max, no recursion, O(1) space).

#### **Section 2: Logical Data Contracts (No Rust Code)**

* **Incoming Payload Shape:** Describe the input as a logical schema or JSON tree.
* **Outgoing Payload Shape:** Describe the expected output schema.
* **Failure Envelope:** Define the exact data fields required when an error occurs (e.g., the DLQ envelope shape).

#### **Section 3: Behavior-Driven Specification (Gherkin Only)**

* Provide the strict `.feature` file text. The agent's first job will be to implement the Rust scaffolding for these tests.

#### **Section 4: The Micro-Task DAG (The Agent's Instruction Set)**

This replaces the vague DAG. It must be a strict, sequential list of instructions.

* **Task 1: Types & Traits:** "Translate Section 2 into Rust structs using `bon` and define local boundaries. Stop and verify."
* **Task 2: BDD Scaffolding:** "Implement the `cucumber` test steps for Section 3. Use `todo!()` for the assertions. Ensure it compiles."
* **Task 3: Pure Logic:** "Implement the parser/validator. It must have zero network imports."
* **Task 4: Adapters:** "Implement the Kafka/HTTP clients."
* **Task 5: The Actor Loop:** "Wire logic and adapters into a `tokio::spawn` loop."

#### **Section 5: Negative Constraints & Quality Gates**

* A checklist the agent must explicitly read and acknowledge before returning a completion status.

---

### 4. Concrete Example: How Track 1 *Should* Look

Here is how Track 1 (Edge Receiver) looks when rewritten to enforce agentic quality control, with zero Rust code artifacts.

```markdown
# Implementation Ledger: Track 1 - Edge Receiver

## Section 1: Component Context & Immutable Rules
* **Role Trigger:** `--role edge`
* **Upstream:** HTTP POST `/v1/logs` (Requires stateless JWT).
* **Downstream:** Redpanda Topic `logs-raw`.
* **Absolute Constraints:**
    * Payloads strictly > 256KB uncompressed MUST be rejected with HTTP 413 before parsing begins.
    * JSON nesting depth > 5 MUST be rejected with HTTP 400.
    * The parsing algorithm MUST be iterative. Recursive functions are strictly banned.

## Section 2: Logical Data Contracts
* **Ingestion Schema:** The incoming payload is arbitrary JSON.
* **Normalized Schema:** The output to Redpanda MUST be flattened.
    * Fields: `timestamp` (String), `level` (String), `message` (String), `app_name` (String), `attributes` (Array of Key/Value pairs where the key is the flattened dot-notation path).
* **Error Routing:** Validation errors (HTTP 4xx) return JSON to the user. System errors (Kafka down) return HTTP 5xx to the user. Do NOT route to DLQ here.

## Section 3: Behavior-Driven Specification
```gherkin
Feature: Edge Receiver Ingestion
  Scenario: Valid log payload is accepted
    Given a valid JSON payload with nesting depth 3
    And a JWT with app_grants containing the payload's app_name
    When it is submitted to the Edge Receiver
    Then it MUST be flattened into dot-notation attributes
    And proxied to logs-raw

  Scenario: Payload exceeds depth limit
    Given a JSON payload with nesting depth 6
    When it is submitted to the Edge Receiver
    Then it MUST immediately return HTTP 400

```

## Section 4: The Micro-Task DAG

* **[ ] Task 4.1: Domain Types.** Generate the Rust structs for the Normalized Schema. Use `bon` builders. Generate the `Erratum` enums for HTTP 400, 413, and 401.
* **[ ] Task 4.2: Boundary Traits.** Define a local trait for the Redpanda producer. It must accept the flattened struct and return the bifurcated `Fallible<Result<...>>` signature.
* **[ ] Task 4.3: BDD Scaffolding.** Implement the `cucumber::World` and step definitions for Section 3. Do not write the core logic yet. Verify the tests fail as expected.
* **[ ] Task 4.4: Pure Parser Logic.** Implement the iterative JSON flattener.
* *Negative Constraint:* You MUST NOT use `serde_json::Value` recursion. Maintain an explicit stack `Vec` to track depth.


* **[ ] Task 4.5: Axum Server.** Implement the HTTP handler.
* *Requirement:* Enforce the 256KB limit using Axum's `DefaultBodyLimit` extractor.


* **[ ] Task 4.6: Metrics & Telemetry.** Inject `tracing::info_span!` for the request and increment `logger_ingest_bytes_total` upon success.

## Section 5: Quality Gates (Pre-Council Checklist)

* [ ] Does the JSON parser use a `Vec` for state instead of function recursion?
* [ ] Are all standard library and external crate imports prefixed with `::`?
* [ ] Is `cargo clippy` passing with `--all-features`?
* [ ] Is there exactly zero usage of `.unwrap()`, `expect()`, or `panic!()` outside of the test files?

By removing the code artifacts and replacing them with logical schemas and prescriptive micro-tasks, you force the LLM to *engineer* the solution rather than just hallucinating boilerplate to match your provided snippets.
