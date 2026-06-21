---
name: no-mocking-validation-gates
description: "Use whenever someone is about to write a mock, stub, test double, or test file — or is already tempted to. This skill explains why mocking creates false confidence (mock drift), shows what gets blocked and what doesn't, and redirects to real-system validation via a concrete DIAGNOSE → FIX → VERIFY flow. Trigger on phrases like 'just mock it', 'stub out the API', 'add a test file', 'jest.mock', 'unittest.mock', 'sinon', 'XCTest', 'vitest', 'staging is slow so I'll fake it', or whenever the real system feels inconvenient."
triggers:
  - "block test file"
  - "mock detection"
  - "prevent mocking"
  - "test double elimination"
  - "real system validation redirect"
  - "jest.mock"
  - "unittest.mock"
  - "just mock it"
  - "stub the api"
context_priority: critical
---

# No-Mocking Validation Gates

## When to use this skill

Load this skill whenever the urge to mock rises: a flaky API, a slow dependency, a dev DB that isn't up, "we just need a quick test". Those are all real problems, but mocks solve them by hiding reality. This skill shows the pattern for fixing the real system instead.

Handles: blocking mock/test file creation, detecting mock code patterns, redirecting to real validation.
Does NOT handle: how to validate once you're committed (`functional-validation`), evidence examination (`gate-validation-discipline`).

## The Iron Rule

Mocking creates **false confidence**. Mock drift is the silent killer:

```
Jan:  API returns {"data": [...]}              Mock returns {"data": [...]}        MATCH
Mar:  API adds {"data": [...], "meta": {...}}  Mock still returns {"data": [...]}  DRIFT
Jun:  Prod: code crashes on missing "meta"     Tests: still green                  BUG SHIPPED
```

The tests pass. The code is broken. The mock is lying.

Real scenario this keeps catching: API field renamed in staging (`users` → `data`), every mocked test still returns `users` and passes, frontend that reads `.data` crashes the moment it hits the real staging server. The test suite said green. Production said red. Only real-system validation catches this.

## Automated scan

`bash scripts/scan-for-mocks.sh --project-dir=. --scan-scope='src lib'` surfaces the
violations the rules below describe (jest.mock, sinon, vi.mock, MagicMock/mock.patch,
gomock, OHHTTPStubs/Cuckoo, generic `.stub()/.mock()`, and test-named files). Use in
pre-commit hooks or CI; exits 1 on any match when `--fail-on-find=true` (default).

## What Gets Blocked

The pre-tool-use hook rejects Write/Edit operations targeting:

| Category | Examples |
|----------|----------|
| Test files | `*.test.ts`, `*.spec.js`, `*_test.go`, `test_*.py`, `*Tests.swift` |
| Test dirs | `__tests__/`, `__mocks__/`, `mocks/`, `stubs/`, `fixtures/` |
| Mock code | `jest.mock()`, `vi.fn()`, `sinon.stub()`, `unittest.mock`, `XCTest`, `gomock` |

### Patterns that get blocked inline

These are all rejected — don't even stage them:

```javascript
// JavaScript / TypeScript
jest.mock('./payment-api');
const mockFetch = vi.fn().mockResolvedValue({ ok: true });
sinon.stub(db, 'query').returns([]);
```

```python
# Python
from unittest.mock import patch, MagicMock
with patch('app.services.stripe.charge') as mock_charge:
    mock_charge.return_value = {"status": "ok"}
```

```swift
// Swift
class MockAPIClient: APIClientProtocol {
    func fetch() -> Data { return Data() }
}
```

```go
// Go
ctrl := gomock.NewController(t)
mockDB := mocks.NewMockDatabase(ctrl)
mockDB.EXPECT().Query(gomock.Any()).Return(rows, nil)
```

For the complete pattern catalog (12 thought patterns that lead to mocking, all blocked file patterns, all blocked code patterns by language), see `references/mock-pattern-catalog.md`.

## What Is NOT Blocked

- Playwright or browser automation (interacts with the real system)
- Database seed scripts (populates real databases with real data)
- API client code that calls real endpoints
- Integration with real external services via staging/dev environments
- Files in `e2e-evidence/`, `validation-evidence/`, `.claude/`, `validationforge/`

## When You Want to Mock: The Three-Step Correction

1. **DIAGNOSE** — Why can't I use the real system? (not running? not configured? too slow?)
2. **FIX** — Make the real system available (start it, configure it, fix it)
3. **VERIFY** — Validate through the real system (run it, exercise it, capture evidence)

For detailed commands and a real-world mock-drift example, see `references/real-system-validation-guide.md`.

## Rules

1. **NEVER create** any file matching blocked patterns — the hook will reject it
2. **NEVER write** mock/stub/spy code in any language — the hook detects it
3. **ALWAYS fix** the real dependency instead of mocking it
4. **ALWAYS validate** through the actual system interface
5. **Slowness is a bug** — profile and fix it, don't mock around it

## Security Policy

This skill blocks file creation and code patterns. It never modifies existing production code,
never disables security checks, and never introduces new functionality. It only prevents
the creation of mock/test artifacts.

## Related Skills

- `functional-validation` — The protocol for how to validate through the real system
- `gate-validation-discipline` — Evidence examination before marking tasks complete
- `e2e-validate` — End-to-end validation flows for complex user journeys
- `error-recovery` — When real system validation fails, structured recovery
