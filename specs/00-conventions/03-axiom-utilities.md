# The `axiom` Utility Crate & Common Aliases

To maintain cross-cutting type consistency, the `logger` workspace utilizes a central library crate named `axiom` (paired with its macro companion `axiom-derive`). This crate is implicitly or auto-imported by all packages to expose standard alias definitions, macros, and extension helper methods.

## 1. Central Type Aliases

All domain and use-case modules must replace native types with the corresponding `axiom` aliases:

| Conceptual Type | Native Rust Underlying Type | `axiom` Qualified Alias |
|---|---|---|
| **String** | `::std::borrow::Cow<'static, str>` | `::axiom::string::String` |
| **Fallible Result** | `::core::result::Result<T, ::anyhow::Error>` | `::axiom::result::Fallible<T = ()>` |
| **Timestamp** | `::chrono::DateTime<::chrono::Utc>` | `::axiom::time::Timestamp` |
| **Interval** | `::chrono::Duration` | `::axiom::time::Interval` |

Using `Cow<'static, str>` as the default string representation allows for memory-efficient, zero-copy operations on static string slices, owned heap allocations, and shared references.

---

## 2. Utility Macros

The `axiom` crate provides central helper macros that must be used project-wide:

### 2.1 Lazily-Compiled Regular Expressions
Use `::axiom::string::regex!` to lazily compile regular expressions once in a thread-safe static context:
```rust
let is_valid_ip = ::axiom::string::regex!(r"^\d{1,3}(\.\d{1,3}){3}$")
    .is_match(ip_address);
```
*(This wraps `::once_cell::sync::OnceCell` and `::regex::Regex` internally to eliminate duplicate compilation overhead.)*

---

## 3. Extension Traits in Prelude

The `::axiom::prelude::*` module re-exports common utility traits anonymously (`as _`) so their methods are in scope without namespace pollution:

- **`IntoType`**: Provides `.into_t::<T>()` as an alias for `T::from(self)` to make conversions readable in function chains:
  ```rust
  let bytes = file_buffer.into_t::<::axiom::bytes::Bytes>();
  ```
- **`OptionExt`**: Introduces `.some()` to transform an `Option` into a `Fallible` result (returning an error with exact panic-style call-site file/line details if it was `None`):
  ```rust
  let val = optional_value.some()?;
  ```
- **`IntoOptionExt`**: Introduces `.into_some()` to wrap any value in `Some(...)`.
- **`IteratorExt`**: Provides `.try_collect_all()` to map a collection and collect all mapping errors cumulatively rather than stopping at the first failure:
  ```rust
  let categories = raw_inputs
      .into_iter()
      .try_collect_all::<::std::vec::Vec<_>, ::std::vec::Vec<_>, _, _, _>(Category::try_from);
  ```
