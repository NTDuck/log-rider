# Logger Project Conventions & Coding Standards

This directory contains the granular, formalized coding conventions, standards, and engineering practices for the `logger` project. These standards ensure syntactic, semantic, architectural, and operational consistency across all modules.

## Conventions Index

1. **[01-architecture-ddd.md](file:///home/ayin/projs/logger/specs/00-conventions/01-architecture-ddd.md)**
   - Domain-Driven Design (DDD) & Clean/Hexagonal Architecture.
   - Boundaries, Interactors, Entities, and Value Objects.
2. **[02-rust-syntax-style.md](file:///home/ayin/projs/logger/specs/00-conventions/02-rust-syntax-style.md)**
   - Fully Qualified Names (FQN) and prefixing imports/calls with `::`.
   - FQN on derive macros (e.g., `#[derive(::core::fmt::Debug)]`).
   - Suffix-position chaining using the `tap` and `bon` crates.
   - Workspace cargo configuration.
3. **[03-axiom-utilities.md](file:///home/ayin/projs/logger/specs/00-conventions/03-axiom-utilities.md)**
   - Shared utility crates (`axiom` and `axiom-derive`).
   - Central type aliases (`Fallible`, `String`, `Timestamp`, etc.).
   - Standardized extension traits.
4. **[04-error-handling.md](file:///home/ayin/projs/logger/specs/00-conventions/04-error-handling.md)**
   - Expected (domain validation) vs. Unexpected (system/infrastructural) errors.
   - Double-wrapped boundary return values.
   - The custom `Erratum` derive macro and interactor-level macros.
5. **[05-testing-cucumber.md](file:///home/ayin/projs/logger/specs/00-conventions/05-testing-cucumber.md)**
   - Behavior-Driven Development (BDD) using the `cucumber` crate.
   - Step definitions, `World` implementations, custom parameter parsing, and parameterized `suite!` macros.
6. **[06-ci-cd-devops.md](file:///home/ayin/projs/logger/specs/00-conventions/06-ci-cd-devops.md)**
   - Continuous Integration and Deployment configurations.
   - Detailed formatting (`.rustfmt.toml`), linting (`.clippy.toml`), and workflow definitions.
