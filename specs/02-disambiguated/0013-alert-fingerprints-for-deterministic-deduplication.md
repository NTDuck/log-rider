# 0013. Alert Fingerprints for Deterministic Deduplication

## Status
Accepted

## Context
The system's Alert Deduplication mechanism requires that if the "same" error occurs 100 consecutive times within 1 minute, the system sends only a single notification to prevent alert fatigue.
A significant architectural trap arises in defining what constitutes the "same" error. Because every incoming structured log includes dynamic telemetry such as a `Timestamp` and a `Trace_ID`, every single log payload is mathematically unique. If the Alert Consumer relies on a hash of the raw JSON payload or the exact Message string to maintain Redis counters, the deduplication will fail 100% of the time. The Redis counters will simply generate hundreds of unique keys, all with a count of 1, resulting in zero deduplication, and alert fatigue will destroy your team.

## Decision
We will implement an Alert Fingerprint (Deduplication Key) pattern for deterministic deduplication.
Before incrementing the Redis counter, the Alert Consumer must explicitly strip away all dynamic telemetry (e.g., `Timestamp`, `Trace_ID`, and user-specific variables). It will generate a deterministic hash using only invariant structural fields:
1. `Application_Name`
2. `Log_Level`
3. A designated structural identifier (such as an `error_code` from the Attributes, or the normalized stack trace class name).

This computed hash will serve as the exact Redis key for the deduplication counter (e.g., `alert:payment_api:error:db_timeout_hash`).

## Consequences
- **Positive**: Deduplication will correctly aggregate related errors, effectively preventing alert fatigue.
- **Positive**: Provides O(1) deduplication lookups using simple Redis `INCR` counters keyed by the deterministic fingerprint.
- **Negative**: Requires careful design and maintenance of the fingerprinting algorithm within the Alert Consumer to ensure distinct underlying errors are not accidentally grouped together, or that noise within the message field does not break the hash.
