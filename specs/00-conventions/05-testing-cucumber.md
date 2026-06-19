# Behavior-Driven Development (BDD) with Cucumber

The `logger` project utilizes **Behavior-Driven Development (BDD)** for integration, repository, and gateway testing. Tests are written in natural Gherkin syntax and executed programmatically using the `cucumber` crate.

---

## 1. Feature Files Layout

Feature files are organized in the `tests/features` folder, matching the module names:
```
tests/features/
├── alerts/
│   └── threshold_alerting.feature
└── ingestion/
    └── log_ingestion.feature
```

Feature descriptions must follow standard Gherkin syntax:
```gherkin
Feature: Log Ingestion

  Scenario: Ingest valid log record
    Given an empty database
    When ingesting a log record with level "INFO" and message "System running"
    Then the database contains exactly 1 log record
```

---

## 2. Test World Implementation

To maintain test state, define a test context struct that implements the `cucumber::World` trait:

```rust
#[derive(::cucumber::World)]
#[derive(::core::default::Default)]
pub struct LogIngestionWorld {
    pub ingestion_repository: ::std::sync::Arc<dyn LogRepository + ::core::marker::Send + ::core::marker::Sync>,
    pub last_response: ::core::option::Option<IngestLogResponse>,
}
```

Implement the test entry point in the integration test module:
```rust
#[::tokio::test(flavor = "multi_thread")]
async fn test_ingestion() {
    LogIngestionWorld::run("tests/features/ingestion/log_ingestion.feature").await;
}
```

---

## 3. Step Definitions

Steps are defined using the `#[given]`, `#[when]`, and `#[then]` attribute macros. Step functions accept `&mut World` as the first argument, and parsed parameter types as subsequent arguments.

- **Given steps**: Setup the initial state.
- **When steps**: Execute the action being tested.
- **Then steps**: Assert the post-conditions.

```rust
use ::cucumber::given;
use ::cucumber::when;
use ::cucumber::then;

#[given("an empty database")]
pub fn given_empty_db(world: &mut LogIngestionWorld) {
    world.ingestion_repository.clear_all();
}

#[when(expr = "ingesting a log record with level {string} and message {string}")]
pub fn when_ingesting(world: &mut LogIngestionWorld, level: ::std::string::String, message: ::std::string::String) {
    let request = IngestLogRequest::builder()
        .log_level(level)
        .message(message)
        .build();
    world.last_response = Some(world.ingest_boundary.apply(request).await.unwrap());
}
```

---

## 4. Custom Parameter Parsers

When steps refer to complex domain values (e.g. `{log_level}`), define custom parameter parser types. This keeps step definitions type-safe and avoids manual parsing inside step functions.

- Derive the `cucumber::Parameter` trait.
- Specify the parameter name and a matching regular expression.
- Implement `::core::str::FromStr` to construct the parameter from the captured text segment.

```rust
#[derive(::cucumber::Parameter)]
#[param(name = "log_level", regex = r"DEBUG|INFO|WARN|ERROR|CRITICAL")]
pub struct LogLevelParameter(LogLevel);

impl ::core::str::FromStr for LogLevelParameter {
    type Err = ::anyhow::Error;

    fn from_str(s: &str) -> ::core::result::Result<Self, Self::Err> {
        let level = LogLevel::try_from(s)?;
        Ok(Self(level))
    }
}
```

---

## 5. Reusable Integration Test Suites (`suite!` Macro)

To verify that multiple database or gateway implementations (e.g. in-memory repositories vs real database repositories) behave identically under the same BDD scenarios, wrap tests in a parameterized `suite!` macro:

```rust
macro_rules! repository_suite {
    (handle = $handle:ident) => {
        type World = RepositoryTestWorld<$handle>;

        #[::tokio::test(flavor = "multi_thread")]
        async fn run_bdd_tests() {
            World::run("tests/features/repositories/log_repository.feature").await;
        }
    };
}
```

By changing the handle input, developers can run the exact same feature suite against mock, memory, and database configurations.
