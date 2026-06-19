# Error Handling Architecture

The project maintains a strict segregation between **expected domain/validation failures** and **unexpected system/infrastructural failures**.

```
Ingestion Boundary Result
 ├── Fallible (Result<..., anyhow::Error>)  --> System/Database Failures (bubbles up via ?)
 └── Inner Result<Ok, Vec<ErrResponse>>      --> Validation/Domain Failures (returned cumulatively)
```

## 1. Segregation of Error Types

1. **Unexpected Failures (System Errors)**:
   - Database connection losses, message queue disruptions, file access denials, and serialization bugs.
   - Handled via the `?` operator.
   - Represented using `::axiom::result::Fallible` (aliasing `::core::result::Result<T, ::anyhow::Error>`).
2. **Expected Failures (Validation / Domain Errors)**:
   - Invalid authentication tokens, malformed log payloads, missing log levels, application key rate limit exhaustion.
   - Handled as normal values without breaking the execution flow.
   - Collected cumulatively and returned inside the success channel of the `Fallible` wrapper.

---

## 2. Double-Wrapped Boundary Returns

All boundary interfaces and interactors must return a double-wrapped signature to handle both types of errors separately:

```rust
::axiom::result::Fallible<::core::result::Result<OkResponse, ::std::vec::Vec<ErrResponse>>>
```

- If an infrastructure operation fails, the interactor returns `::axiom::result::Fallible::Err(anyhow_err)`.
- If business rules or field validations fail, the interactor collects all errors into a `Vec<ErrResponse>` and returns `::axiom::result::Fallible::Ok(::core::result::Result::Err(errors))`.

---

## 3. Helper Macros

Define local interactor macros `ok!`, `err!`, and `errs!` at the parent module level to streamline boundary responses:

```rust
macro_rules! ok {
    ($($ok:tt)*) => {
        ::axiom::result::Fallible::Ok(Response::Ok($($ok)*))
    };
}

macro_rules! errs {
    ($($errs:tt)*) => {
        ::axiom::result::Fallible::Ok(Response::Err($($errs)*))
    };
}

macro_rules! err {
    ($($err:tt)*) => {
        ::axiom::result::Fallible::Ok(Response::Err(::std::vec![ErrResponse::$($err)*]))
    }
}
```

---

## 4. Structured Error Serialization with `Erratum`

Expected domain validation errors (which are defined as enums) must serialize into structured JSON messages. Use the custom derive macro `::axiom::Erratum` (provided by `axiom-derive`) along with `thiserror::Error` attributes to achieve this:

```rust
#[derive(::core::fmt::Debug, ::core::clone::Clone)]
#[derive(::axiom::Erratum)]
#[erratum(rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum LogRecordErrResponse {
    #[error("Invalid log level `{provided_level}`: must be one of DEBUG, INFO, WARN, ERROR, CRITICAL")]
    InvalidLogLevel {
        provided_level: ::axiom::string::String,
    },

    #[error("App key expired")]
    AppKeyExpired,
}
```

The `::axiom::Erratum` derive macro implements `::serde::ser::Serialize` to format the variants into standard JSON objects:
- **`error`**: The variant name converted to the configured case convention (e.g. `"invalid-log-level"`).
- **`message`**: The human-readable string formatted by the `#[error(...)]` attribute (e.g. `"Invalid log level 'UNKNOWN': must be..."`).
- **`data`**: An object containing the fields of the variant (e.g. `{ "providedLevel": "UNKNOWN" }`).
