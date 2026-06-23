#!/usr/bin/env bash
# scan-for-mocks.sh — deterministic scan for mock/stub/fake patterns and test files.
# Part of the no-mocking-validation-gates skill.
#
# Usage:
#   scan-for-mocks.sh [--project-dir=PATH] [--scan-scope="DIR1 DIR2"] [--fail-on-find=true|false]
#
# Defaults:
#   --project-dir=.
#   --scan-scope="src lib"
#   --fail-on-find=true
#
# Exit codes:
#   0 — no matches (or --fail-on-find=false)
#   1 — matches found and --fail-on-find=true
#   2 — invalid invocation

set -u

PROJECT_DIR="."
SCAN_SCOPE="src lib"
FAIL_ON_FIND="true"

for arg in "$@"; do
  case "$arg" in
    --project-dir=*) PROJECT_DIR="${arg#*=}" ;;
    --scan-scope=*)  SCAN_SCOPE="${arg#*=}" ;;
    --fail-on-find=*) FAIL_ON_FIND="${arg#*=}" ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$PROJECT_DIR" ]; then
  echo "project-dir not found: $PROJECT_DIR" >&2
  exit 2
fi

# Canonical anti-patterns keyed by language/framework.
PATTERNS=(
  'jest\.mock\('
  'sinon\.(stub|spy|mock)\('
  'vi\.mock\('
  'MagicMock\(|mock\.patch'
  'gomock|mockgen'
  'OHHTTPStubs|Cuckoo'
  '\.stub\(|\.mock\('
)
LABELS=(
  "jest.mock"
  "sinon.stub/spy/mock"
  "vitest vi.mock"
  "Python MagicMock/mock.patch"
  "Go gomock/mockgen"
  "iOS OHHTTPStubs/Cuckoo"
  "generic .stub()/.mock()"
)

# Pick search engine.
if command -v rg >/dev/null 2>&1; then
  SEARCH="rg -nE --no-heading --color=never"
else
  SEARCH="grep -rnE"
fi

HITS_FILE="$(mktemp)"
trap 'rm -f "$HITS_FILE"' EXIT

TOTAL=0
declare -a PER_PATTERN_COUNTS=()

cd "$PROJECT_DIR" || exit 2

for i in "${!PATTERNS[@]}"; do
  pattern="${PATTERNS[$i]}"
  count=0
  for dir in $SCAN_SCOPE; do
    [ -d "$dir" ] || continue
    # shellcheck disable=SC2086
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      count=$((count + 1))
      TOTAL=$((TOTAL + 1))
      echo "${LABELS[$i]}|$line" >> "$HITS_FILE"
    done < <($SEARCH "$pattern" "$dir" 2>/dev/null || true)
  done
  PER_PATTERN_COUNTS+=("$count")
done

# Test file naming violations.
TEST_FILE_COUNT=0
for dir in $SCAN_SCOPE; do
  [ -d "$dir" ] || continue
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    TEST_FILE_COUNT=$((TEST_FILE_COUNT + 1))
    TOTAL=$((TOTAL + 1))
    echo "test-file|$f:1:(filename matches test pattern)" >> "$HITS_FILE"
  done < <(find "$dir" -type f \( -name '*.test.*' -o -name '*.spec.*' -o -name '*_test.go' -o -name 'test_*.py' \) 2>/dev/null)
done

echo "=== scan-for-mocks summary ==="
echo "project-dir: $PROJECT_DIR"
echo "scan-scope:  $SCAN_SCOPE"
echo "total matches: $TOTAL"
echo "--- breakdown ---"
for i in "${!PATTERNS[@]}"; do
  printf "  %-28s %s\n" "${LABELS[$i]}" "${PER_PATTERN_COUNTS[$i]}"
done
printf "  %-28s %s\n" "test-file names" "$TEST_FILE_COUNT"

if [ "$TOTAL" -gt 0 ]; then
  echo "--- first 20 hits ---"
  head -n 20 "$HITS_FILE"
fi

if [ "$TOTAL" -gt 0 ] && [ "$FAIL_ON_FIND" = "true" ]; then
  exit 1
fi
exit 0
