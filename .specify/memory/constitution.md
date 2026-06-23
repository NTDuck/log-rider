<!--
Sync Impact Report
- Version: [CONSTITUTION_VERSION] -> 1.0.0
- Modified principles: N/A
- Added sections: Core Principles, DevOps and Operational Readiness
- Removed sections: N/A
- Templates requiring updates: 
  - .specify/templates/plan-template.md: ✅ updated
- Follow-up TODOs: None
-->
# logger Constitution

## Core Principles

### I. Architecture and Correctness (Concrete Service-Oriented Architecture)
The `logger` ecosystem strictly adheres to a **Concrete Service-Oriented Architecture (SoA)** (ADR-0020). Our architectural philosophy fundamentally rejects the dogmatic enforcement of pure, workspace-wide Clean Architecture. While global abstraction layers isolate the domain, they inherently produce "leaky abstractions" when interacting with specialized infrastructure (e.g., Redpanda stream processing, ClickHouse columnar aggregations). Hiding these technologies behind lowest-common-denominator interfaces destroys our leverage over their unique capabilities. Instead, we enforce correctness, multi-core scalability, and modularity through pragmatic, localized boundaries:
- **Concrete Services over Global Layers**: The workspace is partitioned into discrete, bounded contexts.
- **Consumer-Driven Local Traits**: Abstraction is mandatory, but it must be defined *locally*. Services define the boundary traits and Higher-Ranked Trait Bounds (HRTBs) they require from their dependencies. 
- **Monomorphization over Dynamic Dispatch**: Dynamic dispatch (`dyn Trait`) is strictly forbidden unless heterogeneous collections are architecturally unavoidable.

### II. Rust Engineering and Performance
We optimize for multi-core scalability under Tokio’s work-stealing executor without introducing pervasive borrow-checker contagion.
- **Pragmatic Concurrency**: Shared state and dependencies MUST default to `::std::sync::Arc` to guarantee `Send` and `Sync` bounds. The use of `::std::rc::Rc` is strictly quarantined to fully synchronous algorithms.
- **Targeted Zero-Copy**: Default to owned `String` and `Vec`. `::std::borrow::Cow` is aggressively reserved **only** for empirically proven hot-path boundaries.
- **Bifurcated Error Segregation**: A robust system never conflates a broken infrastructure with user-error. We enforce a strict semantic divide using the double-wrapped boundary pattern: `::axiom::result::Fallible<::core::result::Result<T, ::std::vec::Vec<E>>>`.
- **Syntactic Hygiene**: All types MUST be invoked via Fully Qualified Names prefixed with `::`. All struct constructions must utilize `bon` builders, and side-effects must use `tap` chaining.

### III. Testing Standards (Behavior-Driven Development)
We treat tests not just as verification mechanisms, but as living documentation.
- All integration and boundary testing must be driven by natural-language Gherkin feature files (`cucumber` crate).
- Integration test suites (`suite!`) must be parameterized. This allows the exact same BDD scenarios to execute against multiple gateway implementations natively within multi-threaded Tokio runtimes.

## DevOps and Operational Readiness

The `logger` project treats continuous integration, deployment, and observability as non-negotiable architectural constraints.
- **CI/CD Strictness and Security**: Quality assurance is enforced entirely via automated, modular CI/CD pipelines (matrix compilation checks, `nextest`, `cargo deny`).
- **Infrastructure-Driven Operations**: We acknowledge that high-throughput systems cannot be abstracted indefinitely. Operational readiness dictates that we explicitly embrace our foundational infrastructure—Redpanda for message streaming and ClickHouse for analytical storage.
- **Observability**: Unpredictable infrastructural faults must bubble up via the `Fallible` wrapper to trigger immediate operational alerts. Expected domain failures are gracefully accumulated as `Erratum`-derived JSON responses.
- **Zero-Downtime Evolution**: Services must handle graceful termination, cleanly draining in-flight async Tokio tasks and safely committing Redpanda offsets without data loss.

## Governance
All PRs must verify compliance with Concrete SoA and Pragmatic Performance principles. Changes require an update to `specs/00-conventions` and this Constitution.

**Version**: 1.0.0 | **Ratified**: 2026-06-20 | **Last Amended**: 2026-06-20
