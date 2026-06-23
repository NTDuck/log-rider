# Logger Project Constitution Principles

This document is the authoritative, comprehensive constitution governing the `logger` project. It defines our absolute, non-negotiable standards for architecture, Rust engineering, performance, and DevOps readiness, replacing dogmatic generic advice with pragmatic, battle-tested engineering philosophy. For the formal governance record, see `../../.specify/memory/constitution.md`.

## I. Architecture and Correctness (Concrete Service-Oriented Architecture)

The `logger` ecosystem strictly adheres to a **Concrete Service-Oriented Architecture (SoA)** (ADR-0020). Our architectural philosophy fundamentally rejects the dogmatic enforcement of pure, workspace-wide Clean Architecture. While global abstraction layers isolate the domain, they inherently produce "leaky abstractions" when interacting with specialized infrastructure (e.g., Redpanda stream processing, ClickHouse columnar aggregations). Hiding these technologies behind lowest-common-denominator interfaces destroys our leverage over their unique capabilities.

Instead, we enforce correctness, multi-core scalability, and modularity through **pragmatic, localized boundaries**:

1. **Concrete Services over Global Layers**: The workspace is partitioned into discrete, bounded contexts. Infrastructure implementations live alongside the domain logic they serve, rather than being exiled to a global outer ring.
2. **Consumer-Driven Local Traits**: Abstraction is mandatory, but it must be defined *locally*. Services define the boundary traits and Higher-Ranked Trait Bounds (HRTBs) they require from their dependencies. We do not maintain sweeping, workspace-wide domain traits.
3. **Monomorphization over Dynamic Dispatch**: To ensure maximum compiler optimization and thread-safety across Tokio's work-stealing executor, boundaries must rely on generics and HRTBs. Dynamic dispatch (`dyn Trait`) is strictly forbidden unless heterogeneous collections are architecturally unavoidable.

## II. Rust Engineering and Performance

This project balances extreme performance capabilities with maintainability and developer ergonomics. We reject dogmatic optimization in favor of **Pragmatic Performance** and **Syntactic Rigor**.

### 1. Pragmatic Concurrency and Allocation
We optimize for multi-core scalability under Tokio’s work-stealing executor without introducing pervasive borrow-checker contagion.
- **Thread-Safe Architecture by Default**: Shared state and dependencies MUST default to `::std::sync::Arc` to guarantee `Send` and `Sync` bounds required by asynchronous tasks. The use of `::std::rc::Rc` or `::core::cell::RefCell` is strictly quarantined to fully synchronous, thread-local algorithms (e.g., isolated parsers or state machines).
- **Targeted Zero-Copy**: Default to owned `String` and `Vec` for data structures to preserve API flexibility and prevent viral lifetime parameters. `::std::borrow::Cow` and raw references (`&[u8]`, `&str`) are aggressively reserved **only** for empirically proven hot-path boundaries, such as high-throughput zero-copy log payload ingestion.
- **Pragmatic Cloning**: We prefer `clone()` on small data types over complex reference counting or lifetimes if it significantly reduces architectural coupling and cognitive load. 

### 2. Bifurcated Error Segregation
A robust system never conflates a broken infrastructure with user-error. We enforce a strict semantic divide using the double-wrapped boundary pattern: `::axiom::result::Fallible<::core::result::Result<T, ::std::vec::Vec<E>>>`.
- **System Failures (The Outer Fallible)**: Unpredictable infrastructural failures (e.g., database timeouts, network drops) are captured by `Fallible` (aliasing `anyhow::Error`) and bubbled up using the `?` operator.
- **Domain Violations (The Inner Result)**: Expected business rule violations (e.g., malformed payloads, rate limits) are treated as data. They must be collected cumulatively and returned inside the success channel. 
- **Structured Erratum**: All domain errors must derive `::axiom::Erratum` and `thiserror::Error` to guarantee consistent, kebab-cased JSON serialization for API consumers.

### 3. Syntactic Hygiene and Immutability
Code cleanliness prevents logic errors and namespace collisions in a rapidly scaling codebase.
- **Absolute FQN Prefixing**: All standard library, core, and external crate types MUST be invoked via Fully Qualified Names prefixed with `::` (e.g., `::std::sync::Arc`, `::serde::Serialize`). Implicit prelude reliance is forbidden.
- **Builder-Driven Construction**: Direct struct instantiation for domain entities and interactors is prohibited. All constructions must utilize the `bon` crate via `#[builder]` macros to ensure forward-compatible, strongly-typed fluent APIs.
- **Expression-Oriented Chaining**: Temporary variable mutations are an anti-pattern. Developers must utilize the `tap` crate (`tap`, `tap_mut`, `tap_err`, `pipe`) to perform inline side-effects (like logging) and mutations, maintaining a clean functional pipeline.

## III. Testing Standards (Behavior-Driven Development)

We treat tests not just as verification mechanisms, but as living documentation of the system's requirements and boundary definitions.
- **Gherkin-Driven BDD**: All integration and boundary testing must be driven by natural-language Gherkin feature files, executed programmatically via the `cucumber` crate. This enforces a strict separation between test intent and test implementation.
- **Parameterized Native Suites**: To prevent local abstractions from becoming brittle, integration test suites (`suite!`) must be parameterized. This allows the exact same BDD scenarios to execute against multiple gateway implementations (e.g., in-memory mocks vs real ClickHouse instances) concurrently within native multi-threaded Tokio runtimes, ensuring thread-safety and correctness simultaneously.

## IV. DevOps and Operational Readiness

The `logger` project treats continuous integration, deployment, and observability as non-negotiable architectural constraints. Our operational stance is dictated by absolute reliability, rigorous automated quality gates, and direct alignment with our core infrastructure.

- **CI/CD Strictness and Security**: Quality assurance is enforced entirely via automated, modular CI/CD pipelines. All changes must pass matrix compilation checks across target operating systems, rapid parallelized testing via `nextest`, and nightly compiler formatting bounds. Dependency supply chains are strictly governed; the introduction of any new crate must pass `cargo deny` and `cargo audit` scans to prevent the ingress of vulnerable, banned, or improperly licensed code.
- **Infrastructure-Driven Operations**: We acknowledge that high-throughput systems cannot be abstracted indefinitely. Operational readiness dictates that we explicitly embrace our foundational infrastructure—Redpanda for message streaming and ClickHouse for analytical storage. We reject leaky generic abstractions in favor of a Concrete Service-Oriented Architecture (SoA) when doing so allows us to leverage the explicit performance, batching, and resilience features of these specific technologies.
- **Observability and Failure Segregation**: Our monitoring systems must reliably distinguish between actionable system degradation and expected user behavior. Unpredictable infrastructural faults (e.g., database connection drops, queue disruptions) must bubble up via the `Fallible` wrapper to trigger immediate operational alerts. Conversely, expected domain failures (e.g., invalid tokens, malformed payloads) are strictly segregated, gracefully accumulated as `Erratum`-derived JSON responses, and logged without inflating system error rates or triggering pager fatigue.
- **Zero-Downtime Evolution**: The system is designed for continuous delivery. Services must handle graceful termination, cleanly draining in-flight async Tokio tasks and safely committing Redpanda offsets without data loss. Infrastructure and schemas must be forward-compatible, ensuring that zero-downtime rolling updates can occur without halting ingestion or compromising data integrity.
