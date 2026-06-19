# 0013. Alert Fingerprints for Deterministic Deduplication

## Status
Accepted

## Context
The Alert Consumer needs to deduplicate critical errors (e.g., 100 occurrences in 1 minute). To do this efficiently, the system must definitively identify when two distinct log payloads represent the "same" error.

## Decision
We will use Alert Fingerprints for deterministic deduplication. Logs will be hashed into a fingerprint based on specific invariant fields (like Application, Level, and normalized Message) to track occurrences in Redis.

## Consequences
- **Positive**: O(1) deduplication lookups using simple Redis counters keyed by the fingerprint.
- **Positive**: Robust against slight variations in dynamic attributes or trace IDs.
- **Negative**: Requires careful design of the fingerprinting algorithm so that distinct errors aren't accidentally grouped together.
