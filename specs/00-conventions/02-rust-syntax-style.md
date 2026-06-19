# Rust Syntactic Style & Utilities

To ensure code cleanliness, prevent import namespace pollution, and establish patterns for method chaining, follow these syntactic rules.

## 1. Fully Qualified Names (FQN) & Leading `::`

### 1.1 FQN Prefix for Calls and Types
- **Always use fully qualified names** for items from the standard library (`std`), `core`, `alloc`, third-party crates, and external workspace dependency crates.
- **Prefix all FQN paths with `::`** to specify they are absolute paths from the root crate namespace:
  - **Correct**: `::std::sync::Arc`, `::core::option::Option`, `::std::vec::Vec`, `::serde::Serialize`.
  - **Incorrect**: `std::sync::Arc`, `core::option::Option`, `serde::Serialize`.
- Only import relative paths for local module contents (e.g. `use crate::boundaries::*`).

### 1.2 FQN on Derive Attributes
Derive macros must also specify fully qualified names.
- **Correct**:
  ```rust
  #[derive(::core::fmt::Debug)]
  #[derive(::core::clone::Clone)]
  #[derive(::serde::Serialize)]
  ```
- **Incorrect**:
  ```rust
  #[derive(Debug, Clone)]
  #[derive(Serialize)]
  ```

---

## 2. Construction Patterns with `bon`

Use the `bon` crate to define constructors and fluent builders.
- Builders are used on request and response models, domain entities, and interactors.
- Specify `#[builder(on(_, into))]` on builders to accept automatic conversions to standard types like `Cow` and `String`.
- Put `#[builder]` on `new` constructor methods to implement ergonomic builders directly:
  ```rust
  #[::bon::bon]
  impl LogRecord {
      #[builder(on(::axiom::string::String, into))]
      pub fn new(
          application_name: ::axiom::string::String,
          message: ::axiom::string::String,
      ) -> Self {
          Self { application_name, message }
      }
  }
  ```

---

## 3. Chaining with `tap`

To keep local blocks in a functional style and avoid introducing temporary variables, effectively utilize the `tap` crate for suffix-position operations.

- **`tap`**: Evaluates a side-effect closure on a shared reference (`&T`) and returns the original value. Useful for logging or asserting inline.
  ```rust
  let user = get_user()
      .tap(|u| ::tracing::debug!("Fetched user: {u:?}"));
  ```
- **`tap_mut`**: Runs a side-effect on a mutable reference (`&mut T`) and returns the modified value. Great for inline modifications.
  ```rust
  let numbers = ::std::vec![1, 2, 3]
      .tap_mut(|vec| vec.push(4));
  ```
- **`tap_err`**: Evaluates a side-effect on the error variant (`&E`) of a `Result`, returning the original `Result` unchanged. Excellent for logging failures.
  ```rust
  let file_data = ::std::fs::read_to_string("log.txt")
      .tap_err(|err| ::tracing::error!("Failed to read file: {err}"))?;
  ```
- **`pipe`**: Passes the value by-value into a mapping function, allowing suffix-position chaining of standard calls.
  ```rust
  let log_length = get_log_message()
      .pipe(|msg| msg.len());
  ```

---

## 4. Workspace Cargo Configurations

Every workspace must contain a local [.cargo/config.toml](file:///home/ayin/projs/logger/.cargo/config.toml) file specifying the relative workspace directory environment variable to enable unified path references:

```toml
[env]
CARGO_WORKSPACE_DIR = { value = "", relative = true }  # https://stackoverflow.com/a/78606410
```
