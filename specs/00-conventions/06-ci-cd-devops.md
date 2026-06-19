# DevOps, Formatting, and CI/CD Workflows

The `logger` project maintains strict quality assurance checks using cargo tools, static analyzers, and a modularized GitHub Actions CI/CD setup. The configurations are stored locally and parameterized for this repository.

---

## 1. Rust Code Formatting

Formatting is defined in [references/.rustfmt.toml](file:///home/ayin/projs/logger/specs/00-conventions/references/.rustfmt.toml) and checked on every commit.

### Key Formatting Standards:
- **`imports_granularity = "Item"`**: Forces imports to be listed individually (one per line) rather than nested inside braces:
  ```rust
  // Correct
  use ::std::sync::Arc;
  use ::std::sync::Mutex;
  
  // Incorrect
  use ::std::sync::{Arc, Mutex};
  ```
- **`group_imports = "StdExternalCrate"`**: Groups imports logically into three groups (Standard/Core Library, External Crates, and Local Crate Modules) separated by empty lines.
- **`merge_derives = false`**: Forces multiple derive attributes to be annotated on separate lines for readability:
  ```rust
  // Correct
  #[derive(::core::fmt::Debug)]
  #[derive(::core::clone::Clone)]
  pub struct LogEntry;
  ```
- **`use_small_heuristics = "Off"`**: Disables collapsing small blocks (e.g., structs, matches) onto a single line.
- **`max_width = 120`**: Limits line width to 120 characters.

Formatting validation is run in CI via:
```bash
cargo fmt --all -- --check
```

---

## 2. Rust Linting with Clippy

Clippy rules are defined in [references/.clippy.toml](file:///home/ayin/projs/logger/specs/00-conventions/references/.clippy.toml).

### Key Linting Rules:
- **`too-many-arguments-threshold = 3`**: Functions with more than 3 arguments trigger warnings. Use request models or builders to group inputs.
- **`check-private-items = true`**: Enforces strict linting on internal and private types/fields.
- **`max-trait-bounds = 42`**: Restricts the maximum allowed trait bounds on generic parameters to maintain clean generic signatures.
- **Lints Allowed in Workspace**:
  - `derived_hash_with_manual_eq` (allows deriving Hash when implementing Eq manually).
  - `new_without_default` (allows `new` methods without requiring a `Default` implementation).
  - `let_and_return` (allows creating a local binding and immediately returning it, which aids debugging).

Lints are run in CI via:
```bash
cargo clippy --workspace --all-targets --all-features
```

---

## 3. GitHub Actions CI/CD Workflows

Workflows are structured modularly inside the [references/.github/workflows/](file:///home/ayin/projs/logger/specs/00-conventions/references/.github/workflows/) folder. The main workflows delegate their jobs to reusable workflow files to prevent duplication.

### 3.1 Main Pipelines:
- **[ci.yml](file:///home/ayin/projs/logger/specs/00-conventions/references/.github/workflows/ci.yml)**: The primary integration pipeline. Triggered on pushes to any branch. Delegates jobs to `lint.yml`, `build.yml`, `test.yml`, and `dependencies-check.yml`. Includes concurrency rules to cancel redundant in-progress runs.
- **[cd.yml](file:///home/ayin/projs/logger/specs/00-conventions/references/.github/workflows/cd.yml)**: The continuous delivery pipeline. Triggered on pull request updates to the default branch or successful completions of the CI pipeline. Triggers `publish.yml` to compile and upload release artifacts.

### 3.2 Reusable Jobs:
- **[lint.yml](file:///home/ayin/projs/logger/specs/00-conventions/references/.github/workflows/lint.yml)**: Verifies formatting and runs clippy under the `nightly` compiler channel.
- **[build.yml](file:///home/ayin/projs/logger/specs/00-conventions/references/.github/workflows/build.yml)**: Checks compilation across a matrix of operating systems (`ubuntu-latest`, `macos-latest`, `windows-latest`) and channels (`stable`, `beta`, `nightly`) using:
  ```bash
  cargo check --workspace --all-targets --all-features
  ```
- **[test.yml](file:///home/ayin/projs/logger/specs/00-conventions/references/.github/workflows/test.yml)**: Runs tests across the OS and compiler matrix using `nextest` for faster, parallel execution:
  ```bash
  cargo nextest run --workspace --all-targets --all-features --no-tests=pass
  ```
- **[dependencies-check.yml](file:///home/ayin/projs/logger/specs/00-conventions/references/.github/workflows/dependencies-check.yml)**: Performs security scans using `cargo deny` (checking advisories, licenses, sources, and bans) and `cargo audit` to detect known vulnerabilities.
- **[publish.yml](file:///home/ayin/projs/logger/specs/00-conventions/references/.github/workflows/publish.yml)**: Parameters are set to build and package release binaries for the `logger` application (uploading `target/release/logger` or `target/release/logger.exe` depending on the target OS).

All build and test steps use `Swatinem/rust-cache@v2` to cache compilation dependencies and decrease build times.
