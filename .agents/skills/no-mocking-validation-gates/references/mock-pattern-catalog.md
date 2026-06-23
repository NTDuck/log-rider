# Mock Pattern Catalog

## 12 Thought Patterns That Precede Mocking Violations

If you catch yourself thinking any of these, STOP and apply the correction.

| # | The Thought | Why It's Wrong | What To Do Instead |
|---|-------------|----------------|-------------------|
| 1 | "Let me add a mock fallback" | Masks real dependency failures; bug hides behind mock | Fix why the real dependency is unavailable. `docker compose up`, check credentials, verify network. |
| 2 | "I'll write a quick unit test" | Unit tests validate code paths, not user experiences. Code can be "correct" and UX can still be broken. | Run the real app. Navigate to the page. Click the button. See what happens. |
| 3 | "I'll stub this database" | In-memory DBs miss constraints, triggers, permissions, connection pooling, query plans. | Start a real database: `docker run -d -p 5432:5432 postgres:16`. Run migrations. Seed data. |
| 4 | "The real system is too slow" | Slowness is a real bug affecting real users right now. Mocking it hides the bug from everyone. | Profile the slow path. Fix the query, add an index, cache the result. The slowness IS the finding. |
| 5 | "Just for local development" | "Local only" never stays local. It leaks into CI, into other developers' workflows, into habits. | Use the same setup a user would use. If setup is hard, that is a real problem to fix. |
| 6 | "I'll add a test mode flag" | Two code paths = two systems. You test one, ship the other. Bugs live in the gap between them. | There is one mode: production. Configure it for dev with env vars, but never fork the code path. |
| 7 | "Let me mock this API" | Mock responses drift from real API within weeks. You test against a fantasy version of the API. | Call the real API with dev/staging credentials. If the API is down, that is a real finding. |
| 8 | "I'll fake the auth" | Auth is where security bugs live. Faking it means you never test the actual security boundary. | Use real auth flow with test user credentials. Create a test user in the real auth system. |
| 9 | "The simulator is flaky" | Flaky infrastructure is a real bug that affects real developers every day. Hiding it helps no one. | Fix the simulator setup. Reset state, clean caches, update tooling. |
| 10 | "I'll create a fixture" | Fixtures are frozen snapshots of data that was real once. They become stale immediately. | Use real data from a seeded dev database. Seed scripts > fixture files. |
| 11 | "Mock for speed" | Maintaining mocks costs more time than running real validation. Mock maintenance is invisible tax. | Real validation IS faster in total when you account for mock maintenance and false-positive debugging. |
| 12 | "Just a smoke test" | "Smoke test" is code for "I know this isn't thorough but I want to move on." | Full functional validation or nothing. Half-validation is worse than no validation — it creates false confidence. |

## Blocked File Patterns

The pre-tool-use hook (`hooks/lib/patterns.js` → `TEST_PATTERNS`) blocks creation of
files matching these patterns. This list is the authoritative hook surface — if a
pattern is not here, the hook does NOT block it.

| Pattern | Language/Framework | What It Usually Contains |
|---------|-------------------|------------------------|
| `*.test.ts`, `*.test.js`, `*.test.tsx`, `*.test.jsx` | JavaScript/TypeScript | Jest, Vitest, or Mocha test suites |
| `*.spec.ts`, `*.spec.js`, `*.spec.tsx`, `*.spec.jsx` | JavaScript/TypeScript | Jasmine or Angular test specs |
| `*_test.go` | Go | Go testing package tests |
| `test_*.py` | Python | pytest `test_*.py` prefix convention |
| `*.test.py` | Python | alternate `.test.py` convention |
| `*Tests.swift`, `*Test.swift` | Swift | XCTest test classes |
| `__tests__/` | JavaScript/TypeScript | Jest test directory convention |
| `/test/**` | Any | any path containing a `/test/` segment |
| `*.mock.{js,ts,tsx,jsx}` | JavaScript/TypeScript | `.mock.` file suffix |
| `*.stub.{js,ts,tsx,jsx}` | JavaScript/TypeScript | `.stub.` file suffix |
| `mocks/`, `stubs/` | Any | Mock and stub modules |
| `fixtures/` | Any | Test fixture data |
| `test-utils/` | Any | Test utility modules |
| `*.stories.tsx`, `*.stories.js` | React | Storybook stories (isolated rendering) |

## Iron Rule (not hook-enforced)

These patterns violate the no-mocks Iron Rule but are NOT caught by
`hooks/lib/patterns.js`. They must be enforced by code review, the
`mock-detection` post-edit hook (content scan, not filename scan), or the project
benchmark. Treat creating any of these as a ValidationForge violation even though
the Write/Edit hook will not block them.

| Pattern | Language/Framework | What It Usually Contains | Why Not Hook-Enforced |
|---------|-------------------|------------------------|-----------------------|
| `*_test.py` | Python | pytest `_test.py` suffix convention | Hook enforces `test_*.py` prefix only |
| `*Test.java`, `*Test.kt` | Java/Kotlin | JUnit test classes | Not in `TEST_PATTERNS` |
| `*_test.rs` | Rust | `#[cfg(test)]` modules | Not in `TEST_PATTERNS` |
| `__mocks__/` | JavaScript/TypeScript | Jest manual mock directory | Not in `TEST_PATTERNS` (only `__tests__/` is) |
| `conftest.py` | Python | pytest configuration and fixtures | Not in `TEST_PATTERNS` |
| `testing/` | Any | Test utility modules | Not in `TEST_PATTERNS` (only `test-utils/` is) |
| `factories/` | Any | Test data factory patterns | Not in `TEST_PATTERNS` |

## Blocked Code Patterns by Language

### JavaScript / TypeScript

```javascript
// ALL BLOCKED — do not use any of these
jest.mock('...')           // Jest module mocking
jest.fn()                 // Jest mock functions
jest.spyOn(obj, 'method') // Jest spy
vi.mock('...')            // Vitest module mocking
vi.fn()                   // Vitest mock functions
vi.spyOn(obj, 'method')  // Vitest spy
sinon.stub(obj, 'method') // Sinon stubs
sinon.mock(obj)           // Sinon mocks
sinon.fake()              // Sinon fakes
nock('http://...')         // HTTP request interception
setupServer(...)          // MSW mock server
http.get('/api/...')      // MSW request handler
import { render } from '@testing-library/react'  // Testing library
```

### Python

```python
# ALL BLOCKED — do not use any of these
from unittest.mock import Mock, MagicMock, patch, PropertyMock
from unittest import mock
import mock
@patch('module.Class')             # Decorator patching
@patch.object(MyClass, 'method')   # Object method patching
with patch('module.function'):     # Context manager patching
monkeypatch.setattr(...)           # pytest monkeypatch
@pytest.fixture                    # pytest fixtures
pytest.mark.parametrize            # pytest parametrize (test framework)
```

### Swift

```swift
// ALL BLOCKED — do not use any of these
import XCTest
class MyTests: XCTestCase { }
XCTAssertEqual(a, b)
XCTAssertTrue(condition)
XCTAssertNil(value)
@testable import MyModule
let expectation = XCTestExpectation(description: "...")
```

### Go

```go
// ALL BLOCKED — do not use any of these
import "testing"
func TestMyFunction(t *testing.T) { }
httptest.NewServer(handler)
httptest.NewRecorder()
gomock.NewController(t)
mock.NewMockClient(ctrl)
```

### Rust

```rust
// ALL BLOCKED — do not use any of these
#[cfg(test)]
mod tests { }
#[test]
fn test_something() { }
mock!{ }                    // mockall macro
automock                    // mockall attribute
```
